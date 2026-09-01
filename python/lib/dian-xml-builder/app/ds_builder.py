"""
Generador de XML UBL 2.1 para Documento Soporte de Compras (DS).
Resolución 0167/2021 — DIAN Colombia.

Reutiliza todos los helpers del builder de facturas (builder.py).

Diferencias clave respecto a una factura normal:
  - InvoiceTypeCode = "05"  (Documento Soporte — NO "91", ese código es de Nota Crédito)
  - ProfileID       = "DIAN 2.1: documento soporte en adquisiciones efectuadas a no obligados a facturar."
  - UUID schemeName = "CUDS-SHA384" (mismo patrón que "CUFE-SHA384" de facturas)
  - SÍ requiere sts:InvoiceControl (igual que una factura): la DIAN exige que el
    contribuyente tenga un rango de numeración autorizado también para Documento
    Soporte (se solicita en el portal DIAN, igual que la resolución de facturación).
    Omitir este bloque produce ZB01 "Fallo en el esquema XML del archivo" porque
    sts:InvoiceControl es un elemento obligatorio (1..1) del esquema.
  - Roles (CONFIRMADO en el Anexo Técnico DS oficial, dian.gov.co — al REVÉS de lo que se
    asumía antes, y la causa real del rechazo "89, NIT X no autorizado a enviar documentos
    para emisor con NIT Y"):
      AccountingSupplierParty = VENDEDOR del documento soporte = SNO (proveedor no obligado)
      AccountingCustomerParty = ADQUIRIENTE = ABS (nuestra empresa, la obligada a facturar)
    Nuestra empresa sigue firmando/transmitiendo el documento — eso no cambia — pero su
    identidad legal dentro del XML va en el tag "Customer", no en "Supplier".
"""

from hashlib import sha384
from typing import Any, Literal, Optional

from lxml import etree
from pydantic import BaseModel, Field

from .constants import NS_MAP, AGENCY_ID_DIAN, INVOICE_NS
from .schemas import InvoiceLineItem, Party
from .builder import (
    _format_float,
    _calculate_dv,
    _add_party,
    _add_header_tax_totals,
    _add_legal_monetary_total,
    _add_invoice_line,
    _force_correct_dian_literals,
    _compute_software_security_code,
)
from .tax_engine import (
    calculate_line_taxes,
    aggregate_invoice_taxes,
    InvoiceTaxSummary,
    get_cufe_tax_values,
)

from datetime import datetime


# ─── Schema ──────────────────────────────────────────────────────────────────

class DsGenerationRequest(BaseModel):
    """
    Payload para generar XML de Documento Soporte de Compras.
    Similar a InvoiceGenerationRequest, incluyendo los datos de la resolución/
    rango de numeración autorizado por la DIAN para Documento Soporte
    (sts:InvoiceControl es obligatorio, igual que en una factura).
    """
    # Identificación — usa document_id si se provee (ej: "DS-000009"),
    # o construye f"{prefix}{number}" si no.
    document_id: Optional[str] = Field(None, description="ID completo del documento (ej: DS-000009). Si se envía, sobreescribe prefix+number.")
    prefix: str = Field("DS", max_length=10, description="Prefijo DS (también usado en CorporateRegistrationScheme)")
    number: int = Field(1, gt=0, description="Número consecutivo (usado solo si document_id es None)")

    issue_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$", description="YYYY-MM-DD")
    issue_time: Optional[str] = Field(None, description="HH:MM:SS-05:00 (calculado si no viene)")

    # Nuestra empresa — la obligada a facturar. En el XML del DS va como
    # AccountingCustomerParty (ADQUIRIENTE/ABS), NO como AccountingSupplierParty.
    # El nombre del campo "issuer" se conserva por compatibilidad con el resto
    # del código (ds-payload.utils.ts, etc.) — es quien genera/firma el documento.
    issuer: Party
    # El proveedor no obligado a facturar (SNO). En el XML del DS va como
    # AccountingSupplierParty (VENDEDOR), NO como AccountingCustomerParty.
    customer: Party

    # Config DIAN
    software_id: str
    software_pin: str
    technical_key_test: str = Field(..., description="Clave técnica (pruebas o producción)")
    environment: Literal["1", "2"] = Field("2", description="1=Producción, 2=Pruebas")
    # CONFIRMADO contra ejemplo oficial DIAN (tabla TipoOperacion-2.1.gc): NO es un código
    # de "tipo de documento" (DS01..DS04, como se asumía antes) — es Residente(10)/No
    # Residente(11) del PROVEEDOR/SNO. "DS03"/"05" causaban DSAD02b.
    customization_id: str = Field("10", description="10=Proveedor/SNO Residente, 11=No Residente (tabla TipoOperacion-2.1.gc)")

    # Resolución / rango de numeración autorizado para Documento Soporte
    # (sts:InvoiceControl — obligatorio, la DIAN exige numeración autorizada
    # también para DS, solicitada en el portal igual que para facturas)
    resolution_number:     str = Field(..., description="Número de autorización DIAN para DS")
    resolution_prefix:     str = Field("DS", description="Prefijo autorizado")
    resolution_from:       int = Field(1, description="Rango inicial autorizado")
    resolution_to:         int = Field(99999999, description="Rango final autorizado")
    resolution_start_date: str = Field(..., description="YYYY-MM-DD — inicio vigencia autorización")
    resolution_end_date:   str = Field(..., description="YYYY-MM-DD — fin vigencia autorización")

    # Líneas
    lines: list[InvoiceLineItem] = Field(..., min_length=1)

    # Opcionales
    payment_means_code: str = Field("10", description="Código medio de pago DIAN tabla 13.3.4.1")
    note: Optional[str] = Field(None, description="Observaciones")
    currency: str = "COP"


# ─── CUDS ────────────────────────────────────────────────────────────────────

def _compute_cuds(
    ds_number: str,
    issue_date: str,
    issue_time: str,
    line_extension: float,
    cod_imp: str,
    val_imp: float,
    payable_amount: float,
    num_sno: str,
    nit_abs: str,
    software_pin: str,
    environment: str,
) -> str:
    """
    Cadena oficial del CUDS (SHA-384) — VERIFICADA byte a byte contra el ejemplo
    real "DocumentoSoporte-OperacionConResidente.xml" de la caja de herramientas
    oficial de la DIAN (Validación Previa v1.1): reconstruyendo esta cadena con
    los valores de ese XML se obtiene EXACTAMENTE el mismo CUDS publicado ahí
    (c96a728f...). Es DISTINTA de la fórmula del CUFE de facturas:
      - Solo UN par código/valor de impuesto (CodImp/ValImp), no tres.
      - Usa NumSNO (identificación del proveedor no obligado, AccountingSupplierParty)
        y NITABS (NIT de nuestra empresa, AccountingCustomerParty) — en ese orden.
      - Usa el PIN del software en vez de la clave técnica.
    """
    val_ds = _format_float(line_extension)
    val_tot = _format_float(payable_amount)

    cuds_str = (
        f"{ds_number}"
        f"{issue_date}"
        f"{issue_time}"
        f"{val_ds}"
        f"{cod_imp}"
        f"{_format_float(val_imp)}"
        f"{val_tot}"
        f"{num_sno}"
        f"{nit_abs}"
        f"{software_pin}"
        f"{environment}"
    )
    return sha384(cuds_str.encode("utf-8")).hexdigest()


# ─── DianExtensions DS (con InvoiceControl) ──────────────────────────────────

def _build_ds_dian_extensions(
    request: DsGenerationRequest,
    ds_number: str,
    cuds: str,
    ssc: str,
    tax_summary: InvoiceTaxSummary,
    issue_time: str,
    cod_imp: str,
    val_imp: float,
) -> etree._Element:
    """
    DianExtensions para DS.
    Incluye sts:InvoiceControl — la DIAN exige numeración autorizada para
    Documento Soporte igual que para facturas (elemento obligatorio 1..1
    del esquema XSD; omitirlo causa ZB01 "Fallo en el esquema XML del archivo").
    """
    agency = b"CO, DIAN (Direcci\xc3\xb3n de Impuestos y Aduanas Nacionales)".decode("utf-8")

    env_url = (
        "https://catalogo-vpfe.dian.gov.co"
        if request.environment == "1"
        else "https://catalogo-vpfe-hab.dian.gov.co"
    )

    xml_str = (
        f'<sts:DianExtensions'
        f' xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1"'
        f' xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">'
        f'<sts:InvoiceControl>'
        f'<sts:InvoiceAuthorization>{request.resolution_number}</sts:InvoiceAuthorization>'
        f'<sts:AuthorizationPeriod>'
        f'<cbc:StartDate>{request.resolution_start_date}</cbc:StartDate>'
        f'<cbc:EndDate>{request.resolution_end_date}</cbc:EndDate>'
        f'</sts:AuthorizationPeriod>'
        f'<sts:AuthorizedInvoices>'
        f'<sts:Prefix>{request.resolution_prefix}</sts:Prefix>'
        f'<sts:From>{request.resolution_from}</sts:From>'
        f'<sts:To>{request.resolution_to}</sts:To>'
        f'</sts:AuthorizedInvoices>'
        f'</sts:InvoiceControl>'
        f'<sts:InvoiceSource>'
        f'<cbc:IdentificationCode'
        f' listAgencyID="6"'
        f' listAgencyName="United Nations Economic Commission for Europe"'
        f' listSchemeURI="urn:oasis:names:specification:ubl:codelist:gc:CountryIdentificationCode-2.1"'
        f'>CO</cbc:IdentificationCode>'
        f'</sts:InvoiceSource>'
        f'<sts:SoftwareProvider>'
        f'<sts:ProviderID schemeAgencyID="195" schemeAgencyName="{agency}"'
        f' schemeID="{request.issuer.dv or "0"}" schemeName="31">{request.issuer.nit}</sts:ProviderID>'
        f'<sts:SoftwareID schemeAgencyID="195" schemeAgencyName="{agency}">{request.software_id}</sts:SoftwareID>'
        f'</sts:SoftwareProvider>'
        f'<sts:SoftwareSecurityCode schemeAgencyID="195" schemeAgencyName="{agency}">{ssc}</sts:SoftwareSecurityCode>'
        f'<sts:AuthorizationProvider>'
        f'<sts:AuthorizationProviderID schemeAgencyID="195" schemeAgencyName="{agency}"'
        f' schemeID="4" schemeName="31">800197268</sts:AuthorizationProviderID>'
        f'</sts:AuthorizationProvider>'
        # Formato REAL confirmado por la DIAN (respuesta oficial de soporte, caso
        # "Aranda", regla DSAB36): a diferencia del CUFE de facturas (que sí lleva
        # los pares Nro/Fecha/Valor/etc. como texto), el QR del Documento Soporte
        # es ÚNICAMENTE la URL de consulta, con la ruta en minúsculas
        # "document/searchqr?documentkey=" (NO "Document/FindDocument?documentKey="
        # como decía el ejemplo de la caja de herramientas — ese formato con todos
        # los campos NroDocSoporte=/Fecha=/etc. causaba el rechazo DSAB36).
        f'<sts:QRCode>{env_url}/document/searchqr?documentkey={cuds}</sts:QRCode>'
        f'</sts:DianExtensions>'
    )
    return etree.fromstring(xml_str.encode("utf-8"))


# ─── InvoiceLine DS (con fallback IVA 0%) ─────────────────────────────────────

def _add_ds_invoice_line(root, line_id: int, line: InvoiceLineItem, tax_result, currency: str, issue_date: str):
    """
    Igual a builder._add_invoice_line, pero con un caso adicional: cuando
    tax_type == "01" (IVA) y tax_rate == 0, tax_engine.calculate_line_taxes()
    NO genera tax_details (para evitar FAU04 en facturas normales) — pero en DS
    la cabecera (_add_header_tax_totals) SIEMPRE emite un TaxTotal de IVA 01/0%
    cuando no hay impuestos reales, y la DIAN exige que exista al menos una línea
    con ese mismo grupo de impuesto (DSAU04: "Base Imponible es distinto a la
    suma de las bases imponibles de las líneas"; DSAS01b: "Existe TaxTotal IVA
    en cabecera sin InvoiceLine con ese impuesto"). Por eso replicamos aquí el
    mismo branch que ya existe para tax_type == "ZA", pero también para "01".
    """
    ns_cac = "{urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2}"
    ns_cbc = "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}"

    inv_line = etree.SubElement(root, f"{ns_cac}InvoiceLine")
    etree.SubElement(inv_line, f"{ns_cbc}ID").text = str(line_id)
    qty = etree.SubElement(inv_line, f"{ns_cbc}InvoicedQuantity", unitCode=line.unit_code)
    qty.text = _format_float(line.quantity, 6)

    etree.SubElement(inv_line, f"{ns_cbc}LineExtensionAmount", currencyID=currency).text = _format_float(tax_result.line_extension)
    etree.SubElement(inv_line, f"{ns_cbc}FreeOfChargeIndicator").text = "false"

    # cac:InvoicePeriod a nivel de línea — OBLIGATORIO para Documento Soporte
    # (DSFC01 "No se informó el grupo InvoicePeriod" + DSFC03 "Código no corresponde
    # de acuerdo a tabla de referencia"). DescriptionCode indica el método de
    # generación/transmisión: 1 = por operación, 2 = acumulado semanal. Usamos 1
    # porque cada documento se genera y transmite individualmente por operación.
    line_period = etree.SubElement(inv_line, f"{ns_cac}InvoicePeriod")
    etree.SubElement(line_period, f"{ns_cbc}StartDate").text = issue_date
    etree.SubElement(line_period, f"{ns_cbc}DescriptionCode").text = "1"
    # Texto EXACTO de la tabla FormaGeneracionTransmision-2.1.gc (código 1 = "Por
    # operación") — confirmado contra el ejemplo oficial DIAN. Antes usábamos "1"
    # (el código repetido como texto), lo cual causaba DSFC04.
    etree.SubElement(line_period, f"{ns_cbc}Description").text = "Por operación"

    if tax_result.tax_details:
        for td in tax_result.tax_details:
            tt = etree.SubElement(inv_line, f"{ns_cac}TaxTotal")
            etree.SubElement(tt, f"{ns_cbc}TaxAmount", currencyID=currency).text = _format_float(td.tax_amount)

            sub = etree.SubElement(tt, f"{ns_cac}TaxSubtotal")
            if td.taxable_amount > 0:
                etree.SubElement(sub, f"{ns_cbc}TaxableAmount", currencyID=currency).text = _format_float(td.taxable_amount)
            etree.SubElement(sub, f"{ns_cbc}TaxAmount", currencyID=currency).text = _format_float(td.tax_amount)

            cat = etree.SubElement(sub, f"{ns_cac}TaxCategory")
            if not td.is_per_unit:
                etree.SubElement(cat, f"{ns_cbc}Percent").text = _format_float(td.rate, 2)

            scheme = etree.SubElement(cat, f"{ns_cac}TaxScheme")
            etree.SubElement(scheme, f"{ns_cbc}ID").text = td.tax_type
            etree.SubElement(scheme, f"{ns_cbc}Name").text = td.tax_name
    elif line.tax_type in ("ZA", "01"):
        # Línea sin impuesto real (excluida, o IVA a tasa 0%). DIAN exige de todas
        # formas un TaxTotal IVA(01)/0% a nivel de línea que respalde el de cabecera.
        tt = etree.SubElement(inv_line, f"{ns_cac}TaxTotal")
        etree.SubElement(tt, f"{ns_cbc}TaxAmount", currencyID=currency).text = "0.00"
        sub = etree.SubElement(tt, f"{ns_cac}TaxSubtotal")
        etree.SubElement(sub, f"{ns_cbc}TaxableAmount", currencyID=currency).text = _format_float(tax_result.line_extension)
        etree.SubElement(sub, f"{ns_cbc}TaxAmount", currencyID=currency).text = "0.00"
        cat = etree.SubElement(sub, f"{ns_cac}TaxCategory")
        etree.SubElement(cat, f"{ns_cbc}Percent").text = "0.00"
        scheme = etree.SubElement(cat, f"{ns_cac}TaxScheme")
        etree.SubElement(scheme, f"{ns_cbc}ID").text = "01"
        etree.SubElement(scheme, f"{ns_cbc}Name").text = "IVA"

    # Item
    item = etree.SubElement(inv_line, f"{ns_cac}Item")
    etree.SubElement(item, f"{ns_cbc}Description").text = line.description

    std_ident = etree.SubElement(item, f"{ns_cac}StandardItemIdentification")
    std_id = etree.SubElement(std_ident, f"{ns_cbc}ID")
    std_id.set("schemeID", "999")
    std_id.set("schemeName", "UNSPSC")
    std_id.text = line.unspsc

    # Price
    price = etree.SubElement(inv_line, f"{ns_cac}Price")
    etree.SubElement(price, f"{ns_cbc}PriceAmount", currencyID=currency).text = _format_float(line.unit_price)
    bq = etree.SubElement(price, f"{ns_cbc}BaseQuantity", unitCode=line.unit_code)
    bq.text = "1.000000"


# ─── AccountingSupplierParty (SNO) — estructura mínima oficial ────────────────

def _add_ds_supplier_party(root, party) -> None:
    """
    Construye cac:AccountingSupplierParty para el vendedor/SNO del Documento
    Soporte replicando EXACTAMENTE la estructura del ejemplo oficial DIAN
    "DocumentoSoporte-OperacionConResidente.xml" (caja de herramientas
    Validación Previa v1.1): PhysicalLocation+Address y PartyTaxScheme
    (CompanyID + TaxLevelCode + TaxScheme) — SIN PartyLegalEntity ni
    RegistrationAddress duplicado, que sí lleva el builder compartido de
    facturas (builder._add_party). DSAJ08a "No fue informado el conjunto de
    elementos correctos de acuerdo a la procedencia del vendedor" se producía
    porque ese builder añade elementos que no corresponden a esta sección.
    """
    ns_cac = "{urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2}"
    ns_cbc = "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}"
    agency_name = b"CO, DIAN (Direcci\xc3\xb3n de Impuestos y Aduanas Nacionales)".decode("utf-8")

    container = etree.SubElement(root, f"{ns_cac}AccountingSupplierParty")
    etree.SubElement(container, f"{ns_cbc}AdditionalAccountID").text = getattr(party, "person_type", "1") or "1"

    party_elem = etree.SubElement(container, f"{ns_cac}Party")

    # NOTA: PartyIdentification se probó (para person_type=="2") como intento de
    # arreglar DSAJ08a, pero el ejemplo oficial NO lo incluye en absoluto — la
    # identificación del SNO va solo vía PartyTaxScheme/CompanyID (NIT, schemeName
    # "31"). Como DSAJ08a persistía con el bloque presente, se elimina para
    # replicar EXACTAMENTE la estructura mínima oficial sin importar person_type.

    location = etree.SubElement(party_elem, f"{ns_cac}PhysicalLocation")
    address = etree.SubElement(location, f"{ns_cac}Address")
    etree.SubElement(address, f"{ns_cbc}ID").text = party.city_code or "11001"
    etree.SubElement(address, f"{ns_cbc}CityName").text = party.city_name or "Bogotá"
    # cbc:PostalZone — OBLIGATORIO cuando CustomizationID="10" (regla DSAJ08a: el grupo
    # debe incluir ID, CityName, PostalZone, CountrySubentity, CountrySubentityCode,
    # AddressLine/Line, Country/IdentificationCode). Confirmado por la página de reglas
    # de rechazo de la DIAN — recomiendan "000000" cuando no se tiene el código postal real.
    etree.SubElement(address, f"{ns_cbc}PostalZone").text = getattr(party, "postal_zone", None) or "000000"
    etree.SubElement(address, f"{ns_cbc}CountrySubentity").text = party.department_name or "Bogotá"
    etree.SubElement(address, f"{ns_cbc}CountrySubentityCode").text = party.department_code or "11"
    addr_line = etree.SubElement(address, f"{ns_cac}AddressLine")
    etree.SubElement(addr_line, f"{ns_cbc}Line").text = party.address or "Carrera 1 # 1-1"
    country = etree.SubElement(address, f"{ns_cac}Country")
    etree.SubElement(country, f"{ns_cbc}IdentificationCode").text = "CO"
    country_name = etree.SubElement(country, f"{ns_cbc}Name")
    country_name.set("languageID", "es")
    country_name.text = "Colombia"

    tax_scheme = etree.SubElement(party_elem, f"{ns_cac}PartyTaxScheme")
    etree.SubElement(tax_scheme, f"{ns_cbc}RegistrationName").text = party.name

    company_id = etree.SubElement(tax_scheme, f"{ns_cbc}CompanyID")
    company_id.set("schemeAgencyID", AGENCY_ID_DIAN)
    company_id.set("schemeAgencyName", agency_name)
    company_id.set("schemeID", party.dv or "0")
    company_id.set("schemeName", getattr(party, "document_type", "31") or "31")
    company_id.text = party.nit

    tax_level = etree.SubElement(tax_scheme, f"{ns_cbc}TaxLevelCode")
    tax_level.set("listName", "")  # presente así, vacío, en el ejemplo oficial DIAN
    tax_level.text = party.tax_level_code or "R-99-PN"

    ts = etree.SubElement(tax_scheme, f"{ns_cac}TaxScheme")
    etree.SubElement(ts, f"{ns_cbc}ID").text = party.tax_scheme_id or "ZZ"
    etree.SubElement(ts, f"{ns_cbc}Name").text = party.tax_scheme_name or "No aplica"

    # cac:Person — cuando el SNO es persona natural (AdditionalAccountID="2"), la
    # DIAN exige identificarlo también con nombres/apellidos (mismo patrón que FAK61
    # para facturas en builder._add_party). El ejemplo oficial de DS es persona
    # jurídica y no lo necesita, pero un SNO persona natural probablemente sí —
    # intento de causa raíz para DSAJ08a ("conjunto de elementos... procedencia
    # del vendedor") con nuestro proveedor de prueba (persona natural).
    if (getattr(party, "person_type", "1") or "1") == "2":
        person_elem = etree.SubElement(party_elem, f"{ns_cac}Person")
        name_parts = (party.name or "").split()
        first = getattr(party, "first_name", None) or (name_parts[0] if name_parts else party.name)
        middle = getattr(party, "middle_name", None)
        family = getattr(party, "family_name", None) or (name_parts[1] if len(name_parts) > 1 else None)
        second = getattr(party, "second_family_name", None)
        etree.SubElement(person_elem, f"{ns_cbc}FirstName").text = first
        if family:
            etree.SubElement(person_elem, f"{ns_cbc}FamilyName").text = family
        if middle:
            etree.SubElement(person_elem, f"{ns_cbc}MiddleName").text = middle
        if second:
            etree.SubElement(person_elem, f"{ns_cbc}SecondFamilyName").text = second


# ─── Builder principal ────────────────────────────────────────────────────────

def build_dian_ds_xml(request: DsGenerationRequest) -> tuple[str, dict[str, Any]]:
    """
    Construye el XML completo del Documento Soporte DIAN (DocTypeCode 05).
    Reutiliza los helpers del builder de facturas — misma estructura UBL 2.1,
    sólo cambian InvoiceTypeCode, ProfileID, schemeName del UUID y DianExtensions.
    """
    # 1. DV automático
    if not request.issuer.dv:
        request.issuer.dv = _calculate_dv(request.issuer.nit)
    if not request.customer.dv and getattr(request.customer, 'document_type', '31') == '31':
        request.customer.dv = _calculate_dv(request.customer.nit)

    # ID del documento — SIN guiones ni espacios (DSAD05a: "no se permiten caracteres
    # adicionales como espacios o guiones"). Se usa tal cual en cbc:ID, en la cadena del
    # CUDS y en el campo NroDocSoporte= del QR — debe ser el MISMO valor limpio en los tres.
    ds_number = (request.document_id or f"{request.prefix}{request.number}").replace("-", "").replace(" ", "")

    # Hora de emisión
    if request.issue_time:
        issue_time = request.issue_time
    else:
        now = datetime.now()
        issue_time = now.strftime("%H:%M:%S-05:00")

    # 2. Procesar líneas + impuestos
    processed_lines = []
    for idx, line in enumerate(request.lines, start=1):
        line_result = calculate_line_taxes(
            line_id=idx,
            quantity=line.quantity,
            unit_price=line.unit_price,
            discount_percent=line.discount_percent,
            tax_type=line.tax_type,
            tax_rate=line.tax_rate,
            per_unit_amount=line.per_unit_amount,
            base_unit_measure=line.base_unit_measure,
        )
        processed_lines.append(line_result)

    tax_summary: InvoiceTaxSummary = aggregate_invoice_taxes(processed_lines)
    cufe_tax_values = get_cufe_tax_values(tax_summary)

    # 3. Árbol XML
    root = etree.Element("{" + INVOICE_NS + "}Invoice", nsmap=NS_MAP)

    # --- UBLExtensions ---
    ubl_extensions = etree.SubElement(
        root,
        "{urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2}UBLExtensions",
    )
    ext1 = etree.SubElement(
        ubl_extensions,
        "{urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2}UBLExtension",
    )
    ext_content1 = etree.SubElement(
        ext1,
        "{urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2}ExtensionContent",
    )
    # Placeholder — se reemplaza más abajo con DianExtensions real
    etree.SubElement(
        ext_content1,
        "{dian:gov:co:facturaelectronica:Structures-2-1}DianExtensions",
    )

    ext2 = etree.SubElement(
        ubl_extensions,
        "{urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2}UBLExtension",
    )
    ext_content2 = etree.SubElement(
        ext2,
        "{urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2}ExtensionContent",
    )
    ext_content2.append(etree.Comment(" ESPACIO RESERVADO PARA LA FIRMA DIGITAL XAdES "))

    # --- Datos básicos ---
    NS_CBC = "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}"
    NS_CAC = "{urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2}"

    etree.SubElement(root, f"{NS_CBC}UBLVersionID").text = "UBL 2.1"
    etree.SubElement(root, f"{NS_CBC}CustomizationID").text = request.customization_id

    # ProfileID EXACTO exigido por el Anexo Técnico Documento Soporte (Res. 0167/2021)
    profile_id_elem = etree.SubElement(root, f"{NS_CBC}ProfileID")
    profile_id_elem.text = (
        b"DIAN 2.1: documento soporte en adquisiciones efectuadas a no "
        b"obligados a facturar.".decode("utf-8")
    )

    etree.SubElement(root, f"{NS_CBC}ProfileExecutionID").text = request.environment
    etree.SubElement(root, f"{NS_CBC}ID").text = ds_number

    # UUID — schemeName="CUDS-SHA384" para DS (mismo patrón que "CUFE-SHA384" de facturas,
    # solo cambia el prefijo CUDS/CUFE; DSAD08/DSAD06 se producían por el "3-384" extra).
    uuid_elem = etree.SubElement(root, f"{NS_CBC}UUID")
    uuid_elem.set("schemeID", request.environment)
    uuid_elem.set("schemeName", "CUDS-SHA384")
    # Se inyecta más abajo tras calcular CUDS

    etree.SubElement(root, f"{NS_CBC}IssueDate").text = request.issue_date
    etree.SubElement(root, f"{NS_CBC}IssueTime").text = issue_time
    # InvoiceTypeCode = 05 → Documento Soporte (NO 91, ese código corresponde a Nota Crédito)
    etree.SubElement(root, f"{NS_CBC}InvoiceTypeCode").text = "05"

    if request.note:
        etree.SubElement(root, f"{NS_CBC}Note").text = request.note

    currency_elem = etree.SubElement(root, f"{NS_CBC}DocumentCurrencyCode")
    currency_elem.set("listAgencyID", "6")
    currency_elem.set("listAgencyName", "United Nations Economic Commission for Europe")
    currency_elem.set("listID", "ISO 4217 Alpha")
    currency_elem.text = request.currency

    etree.SubElement(root, f"{NS_CBC}LineCountNumeric").text = str(len(request.lines))

    # NOTA: a diferencia de las facturas normales (donde cac:InvoicePeriod, si aplica,
    # va a nivel de CABECERA), en Documento Soporte ese grupo es obligatorio a nivel de
    # CADA LÍNEA (cac:InvoiceLine/cac:InvoicePeriod con cbc:StartDate + cbc:DescriptionCode).
    # Ver _add_ds_invoice_line() más abajo — DSFC01/DSFC03 se producían por no incluirlo ahí.

    # --- AccountingSupplierParty = VENDEDOR del documento soporte = SNO (proveedor no obligado) ---
    # Confirmado en el Anexo Técnico DS oficial (dian.gov.co): "Sección AccountingSupplierParty:
    # Grupo de información legales del vendedor del documento soporte: SNO". Es decir, al REVÉS
    # de lo que se asumió antes — NO es nuestra empresa. Poner nuestra empresa aquí hacía que la
    # DIAN comparara el certificado firmante contra el NIT del proveedor y rechazara con el error
    # "89, NIT X no autorizado a enviar documentos para emisor con NIT Y" (Y = NIT del proveedor).
    # is_supplier=False: el proveedor no tiene CorporateRegistrationScheme (esa resolución es
    # nuestra, no de él) ni el Contact obligatorio de correo — solo lo que ya tenga disponible.
    #
    # DSAJ25a "El contenido de este atributo no corresponde a '31'" — confirmado contra la
    # tabla oficial TipoIdFiscal-2.1.gc y el ejemplo real de la DIAN: para Documento Soporte,
    # el vendedor/SNO SIEMPRE se identifica con esquema NIT ("31"), incluso si su documento
    # real es cédula — la tabla NO tiene código para cédula de ciudadanía nacional (13), solo
    # NIT (31) o tipos de extranjero (21/22/41/42/47/50). Forzamos "31" aquí sin mutar el
    # objeto Party original (podría reutilizarse en otro lado del payload).
    # DSAJ08a "No fue informado el conjunto de elementos correctos de acuerdo a la
    # procedencia del vendedor": el ejemplo oficial DIAN muestra al SNO con TaxScheme
    # "ZZ"/"No aplica" en vez de "01"/"IVA" — coherente con que un sujeto no obligado
    # a facturar típicamente está fuera del régimen de IVA. Forzamos eso también.
    proveedor_ds = request.customer.model_copy(update={
        "document_type": "31",
        "tax_scheme_id": "ZZ",
        "tax_scheme_name": "No aplica",
    })
    # El DV se calculó arriba solo si el document_type original ya era "31"; como acabamos
    # de forzarlo aquí, hay que recalcularlo también aquí (DSAJ24b "El DV del NIT no es
    # correcto" si queda vacío o el de un tipo de documento distinto).
    proveedor_ds.dv = _calculate_dv(proveedor_ds.nit)
    _add_ds_supplier_party(root, proveedor_ds)

    # --- AccountingCustomerParty = ADQUIRIENTE = ABS (nuestra empresa, la obligada) ---
    # is_supplier=True: aunque va en el tag "Customer", conserva CorporateRegistrationScheme
    # (nuestro prefijo de resolución) y el Contact con nuestro correo — eso es propio de nuestra
    # empresa sin importar en qué tag UBL quede su información para este tipo de documento.
    _add_party(root, "AccountingCustomerParty", request.issuer, is_supplier=True, invoice_prefix=request.resolution_prefix or request.prefix)

    # --- PaymentMeans ---
    pm = etree.SubElement(root, f"{NS_CAC}PaymentMeans")
    etree.SubElement(pm, f"{NS_CBC}ID").text = "1"
    etree.SubElement(pm, f"{NS_CBC}PaymentMeansCode").text = request.payment_means_code
    etree.SubElement(pm, f"{NS_CBC}PaymentDueDate").text = request.issue_date
    etree.SubElement(pm, f"{NS_CBC}PaymentID").text = "1"

    # --- TaxTotal ---
    _add_header_tax_totals(root, tax_summary)

    # --- LegalMonetaryTotal ---
    _add_legal_monetary_total(root, tax_summary, request.currency)

    # --- InvoiceLines ---
    for idx, line in enumerate(request.lines, 1):
        _add_ds_invoice_line(root, idx, line, processed_lines[idx - 1], request.currency, request.issue_date)

    # 4. Calcular CUDS — CodImp/ValImp = único par código/valor de impuesto (IVA),
    # a diferencia del CUFE de facturas que usa tres pares. Verificado contra el
    # ejemplo oficial de la DIAN (ver _compute_cuds).
    cod_imp = "01"
    val_imp = tax_summary.total_iva
    cuds = _compute_cuds(
        ds_number=ds_number,
        issue_date=request.issue_date,
        issue_time=issue_time,
        line_extension=tax_summary.grand_line_extension,
        cod_imp=cod_imp,
        val_imp=val_imp,
        payable_amount=tax_summary.grand_tax_inclusive,
        num_sno=request.customer.nit,
        nit_abs=request.issuer.nit,
        software_pin=request.software_pin,
        environment=request.environment,
    )

    software_security_code = _compute_software_security_code(
        request.software_id, request.software_pin, ds_number
    )

    # Inyectar CUDS
    uuid_elem.text = cuds

    # 5. DianExtensions DS (con InvoiceControl)
    clean_dian = _build_ds_dian_extensions(
        request, ds_number, cuds, software_security_code, tax_summary,
        issue_time, cod_imp, val_imp,
    )
    ext_content1_found = root.find(
        ".//{urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2}ExtensionContent"
    )
    if ext_content1_found is not None:
        for old in ext_content1_found.findall("{dian:gov:co:facturaelectronica:Structures-2-1}DianExtensions"):
            ext_content1_found.remove(old)
        ext_content1_found.append(clean_dian)

    # 6. Serializar y sanitizar
    xml_bytes = etree.tostring(
        root,
        xml_declaration=True,
        encoding="UTF-8",
        standalone=True,
        pretty_print=True,
    )
    xml_bytes = _force_correct_dian_literals(xml_bytes)
    xml_string = xml_bytes.decode("utf-8")

    metadata = {
        "cuds": cuds,
        "ds_number": ds_number,
        "software_security_code": software_security_code,
    }
    return xml_string, metadata
