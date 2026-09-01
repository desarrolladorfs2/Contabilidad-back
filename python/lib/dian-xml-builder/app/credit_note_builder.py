"""
Generador de XML UBL 2.1 para Nota Crédito Electrónica DIAN Colombia.

Reutiliza la lógica de impuestos, party y encoding de builder.py pero genera
un documento CreditNote en lugar de Invoice, con las siguientes diferencias:

  - Root element: CreditNote (namespace CreditNote-2)
  - CustomizationID: "20" (NC que referencia factura, tabla 13.1.5.2)
  - ProfileID: "DIAN 2.1: Nota Crédito de Factura Electrónica de Venta"
  - CreditNoteTypeCode: "91"
  - CUDE (SHA-384) en lugar de CUFE
  - DiscrepancyResponse: concepto de corrección + referencia a la factura original
  - BillingReference: número, CUFE y fecha de la factura que se corrige
  - Líneas con CreditedQuantity en lugar de InvoicedQuantity
  - DianExtensions sin InvoiceControl (las NC no llevan resolución/autorización)

Referencias:
  - Caja de herramientas FE V19 (v2026) / CreditNote.xml
  - Tabla 13.1.5.2 Documento CreditNote _ Nota Crédito.xlsx
  - XSD: UBL-CreditNote-2.1.xsd
  - Odoo l10n_co_electronic_invoice_self/templates/credit_note_ubl.xml
"""

import base64
from datetime import date, datetime, timezone, timedelta
from hashlib import sha384

# Colombia no tiene horario de verano: siempre UTC-5
COLOMBIA_TZ = timezone(timedelta(hours=-5))
from typing import Any

from lxml import etree

from .constants import AGENCY_ID_DIAN, CORRECT_DIAN_AGENCY, CORRECT_PROFILE_ID
from .schemas import CreditNoteGenerationRequest, CONCEPTO_NOTA_CREDITO
from .builder import _build_custom_tag_general_health
from .tax_engine import (
    calculate_line_taxes,
    aggregate_invoice_taxes,
    InvoiceTaxSummary,
    get_cufe_tax_values,
)

# Namespace raíz para CreditNote (distinto al de Invoice)
CREDIT_NOTE_NS = "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"

# Namespaces completos para el documento CreditNote
NS_MAP_CN = {
    None: CREDIT_NOTE_NS,
    "cac": "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
    "cbc": "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
    "ext": "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2",
    "ds": "http://www.w3.org/2000/09/xmldsig#",
    "xades": "http://uri.etsi.org/01903/v1.3.2#",
    "xades141": "http://uri.etsi.org/01903/v1.4.1#",
    "sts": "dian:gov:co:facturaelectronica:Structures-2-1",
    "xsi": "http://www.w3.org/2001/XMLSchema-instance",
}

# Shorthands de namespace para uso interno
_CAC = "{urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2}"
_CBC = "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}"
_EXT = "{urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2}"
_STS = "{dian:gov:co:facturaelectronica:Structures-2-1}"

# Literal EXACTO para el nombre del agente DIAN (bytes para evitar corrupción)
DIAN_AGENCY_NAME = b"CO, DIAN (Direcci\xc3\xb3n de Impuestos y Aduanas Nacionales)".decode("utf-8")
COUNTRY_NAME_ES = "Colombia"
# ProfileID literal exacto para NC (según Anexo Técnico DIAN v1.9)
PROFILE_ID_NC = b"DIAN 2.1: Nota Cr\xc3\xa9dito de Factura Electr\xc3\xb3nica de Venta".decode("utf-8")


# ---------------------------------------------------------------------------
# Helpers compartidos con builder.py (duplicados aquí para independencia)
# ---------------------------------------------------------------------------

def _format_float(value: float, decimals: int = 2) -> str:
    return f"{round(value, decimals):.{decimals}f}"


def _get_issue_time(request: CreditNoteGenerationRequest) -> str:
    if request.issue_time:
        return request.issue_time
    return datetime.now().strftime("%H:%M:%S-05:00")


def _calculate_dv(nit: str) -> str:
    """Calcula dígito de verificación NIT Colombia."""
    pesos = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71]
    digits = [int(d) for d in str(nit).replace(".", "").replace(",", "")[-15:]][::-1]
    total = sum(d * p for d, p in zip(digits, pesos[: len(digits)]))
    mod = total % 11
    return str(11 - mod) if mod > 1 else str(mod)


# ---------------------------------------------------------------------------
# Cálculo del CUDE (idéntico al CUFE pero para nota crédito)
# DIAN Anexo Técnico v1.9: mismo algoritmo SHA-384, diferente schemeName
# ---------------------------------------------------------------------------

def _compute_cude(
    credit_note_number: str,
    issue_date: str,
    issue_time: str,
    line_extension: float,
    cufe_tax_values: dict,
    payable_amount: float,
    issuer_nit: str,
    customer_nit: str,
    software_pin: str,
    environment: str,
) -> str:
    """
    Cálculo del CUDE según Anexo Técnico DIAN v1.9 sección 11.4.3.

    DIFERENCIA CLAVE vs CUFE:
      - CUFE (facturas)       usa ClTec  (clave técnica del software)
      - CUDE (notas crédito)  usa Software-PIN (pin del software, NO la clave técnica)

    Fórmula: SHA-384(NumFac + FecFac + HorFac + ValFac +
                     CodImp1 + ValImp1 + CodImp2 + ValImp2 + CodImp3 + ValImp3 +
                     ValTot + NitOFE + NumAdq + Software-PIN + TipoAmbiente)
    """
    val_fac = _format_float(line_extension)
    val_tot = _format_float(payable_amount)

    cude_str = (
        f"{credit_note_number}"
        f"{issue_date}"
        f"{issue_time}"
        f"{val_fac}"
        f"{cufe_tax_values['codImp1']}{cufe_tax_values['valImp1']}"
        f"{cufe_tax_values['codImp2']}{cufe_tax_values['valImp2']}"
        f"{cufe_tax_values['codImp3']}{cufe_tax_values['valImp3']}"
        f"{val_tot}"
        f"{issuer_nit}"
        f"{customer_nit}"
        f"{software_pin}"
        f"{environment}"
    )
    result = sha384(cude_str.encode("utf-8")).hexdigest()
    # LOG para diagnóstico — visible en la consola del xml-builder (puerto 8002)
    print(f"[CUDE] cadena  : {cude_str}", flush=True)
    print(f"[CUDE] hash    : {result}", flush=True)
    print(f"[CUDE] NOTA: usa Software-PIN (no ClTec). Ref: Anexo Técnico DIAN v1.9 §11.4.3", flush=True)
    return result


def _compute_software_security_code(software_id: str, pin: str, doc_number: str) -> str:
    s = f"{software_id}{pin}{doc_number}"
    return sha384(s.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# DianExtensions para Nota Crédito
# Las NC no llevan InvoiceControl (sin resolución/autorización).
# ---------------------------------------------------------------------------

def _build_dian_extensions_credit_note(
    request: CreditNoteGenerationRequest,
    cn_number: str,
    cude: str,
    ssc: str,
    tax_summary: InvoiceTaxSummary,
    issue_date: str,
) -> etree._Element:
    """
    Construye el bloque DianExtensions para una nota crédito.
    Usa inyección por string XML para garantizar literales exactos (mismo patrón que builder.py).
    """
    agency = DIAN_AGENCY_NAME

    xml_str = f'''<sts:DianExtensions xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
<sts:InvoiceSource>
<cbc:IdentificationCode listAgencyID="6" listAgencyName="United Nations Economic Commission for Europe" listSchemeURI="urn:oasis:names:specification:ubl:codelist:gc:CountryIdentificationCode-2.1">CO</cbc:IdentificationCode>
</sts:InvoiceSource>
<sts:SoftwareProvider>
<sts:ProviderID schemeAgencyID="195" schemeAgencyName="{agency}" schemeID="{request.issuer.dv or '0'}" schemeName="31">{request.issuer.nit}</sts:ProviderID>
<sts:SoftwareID schemeAgencyID="195" schemeAgencyName="{agency}">{request.software_id}</sts:SoftwareID>
</sts:SoftwareProvider>
<sts:SoftwareSecurityCode schemeAgencyID="195" schemeAgencyName="{agency}">{ssc}</sts:SoftwareSecurityCode>
<sts:AuthorizationProvider>
<sts:AuthorizationProviderID schemeAgencyID="195" schemeAgencyName="{agency}" schemeID="4" schemeName="31">800197268</sts:AuthorizationProviderID>
</sts:AuthorizationProvider>
<sts:QRCode>NroFactura={cn_number}
NitFacturador={request.issuer.nit}
NitAdquiriente={request.customer.nit}
FechaFactura={issue_date}
ValorTotalFactura={_format_float(tax_summary.grand_tax_inclusive)}
CUFE={cude}
URL=https://catalogo-vpfe-hab.dian.gov.co/Document/FindDocument?documentKey={cude}</sts:QRCode>
</sts:DianExtensions>'''

    return etree.fromstring(xml_str.encode("utf-8"))


# ---------------------------------------------------------------------------
# Party (reutiliza la lógica de builder.py)
# ---------------------------------------------------------------------------

def _add_party(parent: etree._Element, tag: str, party, is_supplier: bool):
    """Idéntico a builder._add_party — emite AccountingSupplierParty / AccountingCustomerParty."""
    container = etree.SubElement(parent, f"{_CAC}{tag}")
    etree.SubElement(container, f"{_CBC}AdditionalAccountID").text = getattr(party, 'person_type', '1') or '1'

    party_elem = etree.SubElement(container, f"{_CAC}Party")

    name_elem = etree.SubElement(party_elem, f"{_CAC}PartyName")
    etree.SubElement(name_elem, f"{_CBC}Name").text = party.name

    # PhysicalLocation
    location = etree.SubElement(party_elem, f"{_CAC}PhysicalLocation")
    address = etree.SubElement(location, f"{_CAC}Address")
    etree.SubElement(address, f"{_CBC}ID").text = party.city_code or "11001"
    etree.SubElement(address, f"{_CBC}CityName").text = party.city_name or "Bogotá"
    etree.SubElement(address, f"{_CBC}CountrySubentity").text = party.department_name or "Bogotá"
    etree.SubElement(address, f"{_CBC}CountrySubentityCode").text = party.department_code or "11"
    addr_line = etree.SubElement(address, f"{_CAC}AddressLine")
    etree.SubElement(addr_line, f"{_CBC}Line").text = party.address or "Carrera 1 # 1-1"
    country = etree.SubElement(address, f"{_CAC}Country")
    etree.SubElement(country, f"{_CBC}IdentificationCode").text = party.country_code or "CO"
    cn = etree.SubElement(country, f"{_CBC}Name")
    cn.set("languageID", "es")
    cn.text = COUNTRY_NAME_ES

    # PartyTaxScheme
    tax_scheme = etree.SubElement(party_elem, f"{_CAC}PartyTaxScheme")
    etree.SubElement(tax_scheme, f"{_CBC}RegistrationName").text = party.name
    company_id = etree.SubElement(tax_scheme, f"{_CBC}CompanyID")
    company_id.set("schemeAgencyID", AGENCY_ID_DIAN)
    company_id.set("schemeAgencyName", DIAN_AGENCY_NAME)
    company_id.set("schemeID", party.dv or "0")
    company_id.set("schemeName", getattr(party, 'document_type', '31') or '31')
    company_id.text = party.nit
    tax_level = etree.SubElement(tax_scheme, f"{_CBC}TaxLevelCode")
    tax_level.set("listName", "05")
    tax_level.text = party.tax_level_code or "R-99-PN"
    reg_address = etree.SubElement(tax_scheme, f"{_CAC}RegistrationAddress")
    etree.SubElement(reg_address, f"{_CBC}ID").text = party.city_code or "11001"
    etree.SubElement(reg_address, f"{_CBC}CityName").text = party.city_name or "Bogotá"
    etree.SubElement(reg_address, f"{_CBC}CountrySubentity").text = party.department_name or "Bogotá"
    etree.SubElement(reg_address, f"{_CBC}CountrySubentityCode").text = party.department_code or "11"
    reg_al = etree.SubElement(reg_address, f"{_CAC}AddressLine")
    etree.SubElement(reg_al, f"{_CBC}Line").text = party.address or "Carrera 1 # 1-1"
    reg_country = etree.SubElement(reg_address, f"{_CAC}Country")
    etree.SubElement(reg_country, f"{_CBC}IdentificationCode").text = "CO"
    rcn = etree.SubElement(reg_country, f"{_CBC}Name")
    rcn.set("languageID", "es")
    rcn.text = COUNTRY_NAME_ES
    ts = etree.SubElement(tax_scheme, f"{_CAC}TaxScheme")
    etree.SubElement(ts, f"{_CBC}ID").text = party.tax_scheme_id or "01"
    etree.SubElement(ts, f"{_CBC}Name").text = party.tax_scheme_name or "IVA"

    # PartyLegalEntity
    legal = etree.SubElement(party_elem, f"{_CAC}PartyLegalEntity")
    etree.SubElement(legal, f"{_CBC}RegistrationName").text = party.name
    company_id2 = etree.SubElement(legal, f"{_CBC}CompanyID")
    company_id2.set("schemeAgencyID", AGENCY_ID_DIAN)
    company_id2.set("schemeAgencyName", DIAN_AGENCY_NAME)
    company_id2.set("schemeID", party.dv or "0")
    company_id2.set("schemeName", "31")
    company_id2.text = party.nit
    corp = etree.SubElement(legal, f"{_CAC}CorporateRegistrationScheme")
    etree.SubElement(corp, f"{_CBC}ID").text = getattr(party, "prefix", None) or "NC"


# ---------------------------------------------------------------------------
# TaxTotal (cabecera) — igual que en builder.py
# ---------------------------------------------------------------------------

def _add_header_tax_totals(root: etree._Element, summary: InvoiceTaxSummary):
    for tax_code, data in summary.totals_by_type.items():
        tax_total = etree.SubElement(root, f"{_CAC}TaxTotal")
        etree.SubElement(tax_total, f"{_CBC}TaxAmount", currencyID="COP").text = _format_float(data["total_amount"])
        for group in data["groups"]:
            if not group.get("is_per_unit") and group.get("rate", 0) == 0:
                continue
            subtotal = etree.SubElement(tax_total, f"{_CAC}TaxSubtotal")
            etree.SubElement(subtotal, f"{_CBC}TaxableAmount", currencyID="COP").text = _format_float(group["taxable"])
            etree.SubElement(subtotal, f"{_CBC}TaxAmount", currencyID="COP").text = _format_float(group["tax_amount"])
            cat = etree.SubElement(subtotal, f"{_CAC}TaxCategory")
            if not group.get("is_per_unit"):
                etree.SubElement(cat, f"{_CBC}Percent").text = _format_float(group["rate"], 2)
            scheme = etree.SubElement(cat, f"{_CAC}TaxScheme")
            etree.SubElement(scheme, f"{_CBC}ID").text = tax_code
            etree.SubElement(scheme, f"{_CBC}Name").text = data["name"]


# ---------------------------------------------------------------------------
# LegalMonetaryTotal
# ---------------------------------------------------------------------------

def _add_legal_monetary_total(root: etree._Element, summary: InvoiceTaxSummary, currency: str):
    lmt = etree.SubElement(root, f"{_CAC}LegalMonetaryTotal")
    etree.SubElement(lmt, f"{_CBC}LineExtensionAmount", currencyID=currency).text = _format_float(summary.grand_line_extension)
    etree.SubElement(lmt, f"{_CBC}TaxExclusiveAmount", currencyID=currency).text = _format_float(summary.grand_tax_exclusive)
    etree.SubElement(lmt, f"{_CBC}TaxInclusiveAmount", currencyID=currency).text = _format_float(summary.grand_tax_inclusive)
    etree.SubElement(lmt, f"{_CBC}PayableAmount", currencyID=currency).text = _format_float(summary.grand_tax_inclusive)


# ---------------------------------------------------------------------------
# Línea de nota crédito
# La diferencia vs InvoiceLine es que usa CreditedQuantity en lugar de InvoicedQuantity
# y el elemento raíz es CreditNoteLine en lugar de InvoiceLine.
# ---------------------------------------------------------------------------

def _add_credit_note_line(
    root: etree._Element,
    line_id: int,
    line,
    tax_result,
    currency: str,
):
    cn_line = etree.SubElement(root, f"{_CAC}CreditNoteLine")
    etree.SubElement(cn_line, f"{_CBC}ID").text = str(line_id)

    # CreditedQuantity (en vez de InvoicedQuantity)
    qty = etree.SubElement(cn_line, f"{_CBC}CreditedQuantity", unitCode=line.unit_code)
    qty.text = _format_float(line.quantity, 6)

    etree.SubElement(cn_line, f"{_CBC}LineExtensionAmount", currencyID=currency).text = _format_float(tax_result.line_extension)
    etree.SubElement(cn_line, f"{_CBC}FreeOfChargeIndicator").text = "false"

    # TaxTotal de la línea
    if tax_result.tax_details:
        for td in tax_result.tax_details:
            tt = etree.SubElement(cn_line, f"{_CAC}TaxTotal")
            etree.SubElement(tt, f"{_CBC}TaxAmount", currencyID=currency).text = _format_float(td.tax_amount)
            sub = etree.SubElement(tt, f"{_CAC}TaxSubtotal")
            if td.taxable_amount > 0:
                etree.SubElement(sub, f"{_CBC}TaxableAmount", currencyID=currency).text = _format_float(td.taxable_amount)
            etree.SubElement(sub, f"{_CBC}TaxAmount", currencyID=currency).text = _format_float(td.tax_amount)
            cat = etree.SubElement(sub, f"{_CAC}TaxCategory")
            if not td.is_per_unit:
                etree.SubElement(cat, f"{_CBC}Percent").text = _format_float(td.rate, 2)
            scheme = etree.SubElement(cat, f"{_CAC}TaxScheme")
            etree.SubElement(scheme, f"{_CBC}ID").text = td.tax_type
            etree.SubElement(scheme, f"{_CBC}Name").text = td.tax_name

    # Item
    item = etree.SubElement(cn_line, f"{_CAC}Item")
    etree.SubElement(item, f"{_CBC}Description").text = line.description
    std_ident = etree.SubElement(item, f"{_CAC}StandardItemIdentification")
    std_id = etree.SubElement(std_ident, f"{_CBC}ID")
    std_id.set("schemeID", "999")
    std_id.set("schemeName", "UNSPSC")
    std_id.text = line.unspsc

    # Price
    price = etree.SubElement(cn_line, f"{_CAC}Price")
    etree.SubElement(price, f"{_CBC}PriceAmount", currencyID=currency).text = _format_float(line.unit_price)
    bq = etree.SubElement(price, f"{_CBC}BaseQuantity", unitCode=line.unit_code)
    bq.text = "1.000000"


# ---------------------------------------------------------------------------
# Sanitización final (misma que builder.py)
# ---------------------------------------------------------------------------

def _force_correct_dian_literals(xml_bytes: bytes) -> bytes:
    """Garantiza que los literales exactos de la DIAN estén correctos en el XML final."""
    result = xml_bytes

    # Capa 1: bytes conocidos con mojibake
    corrections = {
        b"Electr\xc3\x83\xc2\xb3nica": b"Electr\xc3\xb3nica",
        b"Direcci\xc3\x83\xc2\xb3n": b"Direcci\xc3\xb3n",
    }
    for bad, good in corrections.items():
        result = result.replace(bad, good)

    # Capa 2: string con múltiples pasadas
    try:
        xml_str = result.decode("utf-8", errors="replace")
    except Exception:
        xml_str = result.decode("latin-1", errors="replace")

    for _ in range(3):
        xml_str = xml_str.replace(
            "DIAN 2.1: Factura Electrónica de Venta", CORRECT_PROFILE_ID
        ).replace(
            "CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)", CORRECT_DIAN_AGENCY
        ).replace(
            "DIAN 2.1: Nota Crédito de Factura Electrónica de Venta", PROFILE_ID_NC
        )

    return xml_str.encode("utf-8")


# ---------------------------------------------------------------------------
# Función principal
# ---------------------------------------------------------------------------

def build_dian_credit_note_xml(
    request: CreditNoteGenerationRequest,
) -> tuple[str, dict[str, Any]]:
    """
    Construye el XML completo de una Nota Crédito Electrónica DIAN.

    Retorna:
        (xml_string, metadata)  donde metadata contiene cude, número, resumen de impuestos.
    """
    # 1. DV
    if not request.issuer.dv:
        request.issuer.dv = _calculate_dv(request.issuer.nit)
    if not request.customer.dv:
        request.customer.dv = _calculate_dv(request.customer.nit)

    cn_number = f"{request.prefix}{request.number}"
    # Siempre usar fecha/hora en zona horaria Colombia (UTC-5, sin DST)
    # independientemente del timezone del servidor.
    _now_co = datetime.now(COLOMBIA_TZ)
    issue_date = _now_co.strftime("%Y-%m-%d")
    issue_time = _now_co.strftime("%H:%M:%S-05:00")

    # 2. Procesar líneas + impuestos (misma lógica que las facturas)
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

    # 3. Construir árbol XML — raíz CreditNote
    root = etree.Element("{" + CREDIT_NOTE_NS + "}CreditNote", nsmap=NS_MAP_CN)

    # --- UBLExtensions ---
    ubl_extensions = etree.SubElement(root, f"{_EXT}UBLExtensions")

    # Extensión 1: DianExtensions (placeholder; se reemplaza más abajo)
    ext1 = etree.SubElement(ubl_extensions, f"{_EXT}UBLExtension")
    ext_content1 = etree.SubElement(ext1, f"{_EXT}ExtensionContent")
    etree.SubElement(ext_content1, f"{_STS}DianExtensions")  # placeholder

    # Extensión 2: espacio reservado para firma XAdES
    ext2 = etree.SubElement(ubl_extensions, f"{_EXT}UBLExtension")
    ext_content2 = etree.SubElement(ext2, f"{_EXT}ExtensionContent")
    ext_content2.append(etree.Comment(" ESPACIO RESERVADO PARA LA FIRMA DIGITAL XAdES "))

    # Extensión 3: CustomTagGeneral Sector Salud (Resolución 948:2026) — solo si
    # la NC corresponde a una factura de salud (viene el dict `health`).
    health = request.health or {}
    if health:
        ctg_xml = _build_custom_tag_general_health(health)
        if ctg_xml is not None:
            ext3 = etree.SubElement(ubl_extensions, f"{_EXT}UBLExtension")
            ext_content3 = etree.SubElement(ext3, f"{_EXT}ExtensionContent")
            ext_content3.append(ctg_xml)

    # --- Cabecera del documento ---
    etree.SubElement(root, f"{_CBC}UBLVersionID").text = "UBL 2.1"
    etree.SubElement(root, f"{_CBC}CustomizationID").text = "20"   # NC con referencia = 20 (tabla 13.1.5.2)
    etree.SubElement(root, f"{_CBC}ProfileID").text = PROFILE_ID_NC  # literal exacto DIAN
    etree.SubElement(root, f"{_CBC}ProfileExecutionID").text = request.environment
    etree.SubElement(root, f"{_CBC}ID").text = cn_number

    # CUDE (UUID) — se rellena después del cálculo
    uuid_elem = etree.SubElement(root, f"{_CBC}UUID")
    uuid_elem.set("schemeID", request.environment)
    uuid_elem.set("schemeName", "CUDE-SHA384")   # CUDE, no CUFE

    etree.SubElement(root, f"{_CBC}IssueDate").text = issue_date
    etree.SubElement(root, f"{_CBC}IssueTime").text = issue_time
    etree.SubElement(root, f"{_CBC}CreditNoteTypeCode").text = "91"  # Código fijo para NC

    if request.note:
        etree.SubElement(root, f"{_CBC}Note").text = request.note

    currency_elem = etree.SubElement(root, f"{_CBC}DocumentCurrencyCode")
    currency_elem.set("listAgencyID", "6")
    currency_elem.set("listAgencyName", "United Nations Economic Commission for Europe")
    currency_elem.set("listID", "ISO 4217 Alpha")
    currency_elem.text = request.currency

    etree.SubElement(root, f"{_CBC}LineCountNumeric").text = str(len(request.lines))

    # --- DiscrepancyResponse (concepto de corrección) ---
    # Tabla 13.1.5.2: ResponseCode 1-5
    discrepancy = etree.SubElement(root, f"{_CAC}DiscrepancyResponse")
    etree.SubElement(discrepancy, f"{_CBC}ReferenceID").text = request.billing_reference.invoice_id
    etree.SubElement(discrepancy, f"{_CBC}ResponseCode").text = request.discrepancy_code
    # DIAN exige texto EXACTO de la tabla 13.1.5.2 (error CBF04 si es texto libre)
    official_desc = CONCEPTO_NOTA_CREDITO.get(
        request.discrepancy_code, "Devolución parcial de los bienes y/o no aceptación parcial del servicio"
    )
    etree.SubElement(discrepancy, f"{_CBC}Description").text = official_desc

    # --- BillingReference (referencia a la factura original) ---
    billing_ref = etree.SubElement(root, f"{_CAC}BillingReference")
    inv_doc_ref = etree.SubElement(billing_ref, f"{_CAC}InvoiceDocumentReference")
    etree.SubElement(inv_doc_ref, f"{_CBC}ID").text = request.billing_reference.invoice_id
    uuid_ref = etree.SubElement(inv_doc_ref, f"{_CBC}UUID")
    uuid_ref.set("schemeName", "CUFE-SHA384")
    uuid_ref.text = request.billing_reference.invoice_uuid
    etree.SubElement(inv_doc_ref, f"{_CBC}IssueDate").text = request.billing_reference.invoice_date

    # --- Emisor ---
    _add_party(root, "AccountingSupplierParty", request.issuer, is_supplier=True)

    # --- Cliente ---
    _add_party(root, "AccountingCustomerParty", request.customer, is_supplier=False)

    # --- PaymentMeans ---
    pm = etree.SubElement(root, f"{_CAC}PaymentMeans")
    etree.SubElement(pm, f"{_CBC}ID").text = "1"
    etree.SubElement(pm, f"{_CBC}PaymentMeansCode").text = "10"
    etree.SubElement(pm, f"{_CBC}PaymentDueDate").text = issue_date
    etree.SubElement(pm, f"{_CBC}PaymentID").text = "1"

    # --- TaxTotal (cabecera) ---
    _add_header_tax_totals(root, tax_summary)

    # --- LegalMonetaryTotal ---
    _add_legal_monetary_total(root, tax_summary, request.currency)

    # --- CreditNoteLines ---
    for idx, line in enumerate(request.lines, 1):
        _add_credit_note_line(root, idx, line, processed_lines[idx - 1], request.currency)

    # 4. Calcular CUDE y SoftwareSecurityCode
    cude = _compute_cude(
        credit_note_number=cn_number,
        issue_date=issue_date,
        issue_time=issue_time,
        line_extension=tax_summary.grand_line_extension,
        cufe_tax_values=cufe_tax_values,
        payable_amount=tax_summary.grand_tax_inclusive,
        issuer_nit=request.issuer.nit,
        customer_nit=request.customer.nit,
        software_pin=request.software_pin,   # CUDE usa PIN, no ClTec (Anexo Técnico DIAN v1.9 §11.4.3)
        environment=request.environment,
    )
    ssc = _compute_software_security_code(request.software_id, request.software_pin, cn_number)

    # 5. Inyectar CUDE en el elemento UUID
    uuid_elem.text = cude

    # 6. Reemplazar placeholder DianExtensions con el bloque real
    clean_dian = _build_dian_extensions_credit_note(
        request=request,
        cn_number=cn_number,
        cude=cude,
        ssc=ssc,
        tax_summary=tax_summary,
        issue_date=issue_date,
    )
    ec1 = root.find(f".//{_EXT}ExtensionContent")
    if ec1 is not None:
        for old in ec1.findall(f"{_STS}DianExtensions"):
            ec1.remove(old)
        ec1.append(clean_dian)

    # 7. Serializar
    xml_bytes = etree.tostring(
        root,
        xml_declaration=True,
        encoding="UTF-8",
        standalone=True,
        pretty_print=True,
    )

    # 8. Sanitización final de literales DIAN
    xml_bytes = _force_correct_dian_literals(xml_bytes)
    xml_string = xml_bytes.decode("utf-8")

    metadata = {
        "cude": cude,
        "credit_note_number": cn_number,
        "software_security_code": ssc,
        "billing_reference": {
            "invoice_id": request.billing_reference.invoice_id,
            "invoice_uuid": request.billing_reference.invoice_uuid,
            "invoice_date": request.billing_reference.invoice_date,
        },
        "discrepancy_code": request.discrepancy_code,
        "tax_summary": {
            "total_iva": tax_summary.total_iva,
            "total_inc": tax_summary.total_inc,
            "total_ica": tax_summary.total_ica,
            "line_extension": tax_summary.grand_line_extension,
            "tax_exclusive": tax_summary.grand_tax_exclusive,
            "tax_inclusive": tax_summary.grand_tax_inclusive,
        },
    }

    return xml_string, metadata
