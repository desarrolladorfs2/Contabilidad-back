"""
Generador de XML UBL 2.1 + Estructuras DIAN Colombia.

Sigue el patrón de Odoo l10n_co_electronic_invoice_self pero de forma
independiente y simplificada.

Genera el XML completo listo para ser firmado (con CUFE, SoftwareSecurityCode y QR ya calculados).
"""

import base64
from datetime import datetime
from hashlib import sha384
from typing import Any

from lxml import etree

from .constants import NS_MAP, AGENCY_ID_DIAN, INVOICE_NS

# === Literales EXACTOS (Unicode escapes para máxima seguridad de encoding) ===
# Copiados fielmente del código viejo en app.js que funcionaba correctamente.
DIAN_AGENCY_NAME = "CO, DIAN (Direcci\u00f3n de Impuestos y Aduanas Nacionales)"
PROFILE_ID_LITERAL = "DIAN 2.1: Factura Electr\u00f3nica de Venta"
COUNTRY_NAME_ES = "Colombia"
from .schemas import InvoiceGenerationRequest, InvoiceLineItem
from .tax_engine import (
    calculate_line_taxes,
    aggregate_invoice_taxes,
    InvoiceTaxSummary,
    get_cufe_tax_values,
)


def _format_float(value: float, decimals: int = 2) -> str:
    return f"{round(value, decimals):.{decimals}f}"


def _get_issue_time(request: InvoiceGenerationRequest) -> str:
    if request.issue_time:
        return request.issue_time
    # Generar hora Colombia actual
    now = datetime.now()
    return now.strftime("%H:%M:%S-05:00")


def _calculate_dv(nit: str) -> str:
    """Calcula dígito de verificación NIT Colombia."""
    pesos = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71]
    digits = [int(d) for d in str(nit).replace(".", "").replace(",", "")[-15:]][::-1]
    total = sum(d * p for d, p in zip(digits, pesos[: len(digits)]))
    mod = total % 11
    return str(11 - mod) if mod > 1 else str(mod)


def build_dian_invoice_xml(request: InvoiceGenerationRequest) -> tuple[str, dict[str, Any]]:
    """
    Construye el XML completo de factura DIAN.

    Retorna:
        (xml_string, metadata) donde metadata contiene cufe, número, etc.
    """
    # 1. Calcular DV si no viene
    if not request.issuer.dv:
        request.issuer.dv = _calculate_dv(request.issuer.nit)
    # Solo calcular DV automáticamente para NIT (31); CC, CE y otros no tienen DV
    if not request.customer.dv and getattr(request.customer, 'document_type', '31') == '31':
        request.customer.dv = _calculate_dv(request.customer.nit)

    invoice_number = f"{request.prefix}{request.number}"
    issue_time = _get_issue_time(request)

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

    # 3. Construir el árbol XML
    # Usamos el namespace por defecto correctamente con lxml (None key)
    root = etree.Element("{" + INVOICE_NS + "}Invoice", nsmap=NS_MAP)

    # --- UBLExtensions (se llenan al final con CUFE y firma placeholder) ---
    ubl_extensions = etree.SubElement(root, "{urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2}UBLExtensions")

    # Extensión 1: DianExtensions (se crea más adelante con literales limpios)
    ext1 = etree.SubElement(ubl_extensions, "{urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2}UBLExtension")
    ext_content1 = etree.SubElement(ext1, "{urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2}ExtensionContent")
    # Placeholder temporal
    placeholder_dian = etree.SubElement(ext_content1, "{dian:gov:co:facturaelectronica:Structures-2-1}DianExtensions")

    # Extensión 2: Placeholder para la firma (compatible con el firmador actual)
    ext2 = etree.SubElement(ubl_extensions, "{urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2}UBLExtension")
    ext_content2 = etree.SubElement(ext2, "{urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2}ExtensionContent")
    ext_content2.append(etree.Comment(" ESPACIO RESERVADO PARA LA FIRMA DIGITAL XAdES "))

    # Extensión 3: CustomTagGeneral Sector Salud (Resolución 948:2026 — obligatoria para validador Ministerio)
    health = request.health or {}
    if health and request.customization_id and request.customization_id.startswith("SS-"):
        ctg_xml = _build_custom_tag_general_health(health)
        if ctg_xml is not None:
            ext3 = etree.SubElement(ubl_extensions, "{urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2}UBLExtension")
            ext_content3 = etree.SubElement(ext3, "{urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2}ExtensionContent")
            ext_content3.append(ctg_xml)

    # --- Datos básicos del documento ---
    etree.SubElement(root, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}UBLVersionID").text = "UBL 2.1"
    etree.SubElement(root, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}CustomizationID").text = request.customization_id
    # Literal EXACTO que exige DIAN
    # Literal EXACTO usando bytes para evitar cualquier corrupción (mismo truco que Odoo + Node viejo)
    profile_bytes = b"DIAN 2.1: Factura Electr\xc3\xb3nica de Venta"
    profile_id = etree.SubElement(root, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}ProfileID")
    profile_id.text = profile_bytes.decode("utf-8")
    etree.SubElement(root, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}ProfileExecutionID").text = request.environment

    etree.SubElement(root, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}ID").text = invoice_number

    # UUID (CUFE) - se inyecta después de calcularlo
    uuid_elem = etree.SubElement(root, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}UUID")
    uuid_elem.set("schemeID", request.environment)
    uuid_elem.set("schemeName", "CUFE-SHA384")
    # uuid_elem.text = se calcula más abajo

    etree.SubElement(root, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}IssueDate").text = request.issue_date
    etree.SubElement(root, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}IssueTime").text = issue_time
    etree.SubElement(root, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}InvoiceTypeCode").text = "01"
    if request.note:
        etree.SubElement(root, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}Note").text = request.note

    currency_elem = etree.SubElement(root, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}DocumentCurrencyCode")
    currency_elem.set("listAgencyID", "6")
    currency_elem.set("listAgencyName", "United Nations Economic Commission for Europe")
    currency_elem.set("listID", "ISO 4217 Alpha")
    currency_elem.text = request.currency

    etree.SubElement(root, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}LineCountNumeric").text = str(len(request.lines))

    # --- InvoicePeriod (PGP/SS-Recaudo y salud "evento") — posición correcta UBL 2.1:
    # después de cbc y antes de cac:AccountingSupplierParty.
    # BUG CORREGIDO (2026-08-31): faltaban StartTime/EndTime. Confirmado contra
    # NS82845.xml (ejemplo validado por el Ministerio de Salud), que cubre el día
    # completo del servicio con StartTime=00:00:00 / EndTime=23:59:00 incluso
    # cuando StartDate == EndDate (un solo día, caso típico de "evento").
    if request.invoice_period_start and request.invoice_period_end:
        inv_period = etree.SubElement(root, "{urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2}InvoicePeriod")
        etree.SubElement(inv_period, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}StartDate").text = request.invoice_period_start
        etree.SubElement(inv_period, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}StartTime").text = "00:00:00"
        etree.SubElement(inv_period, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}EndDate").text = request.invoice_period_end
        etree.SubElement(inv_period, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}EndTime").text = "23:59:00"

    # --- Emisor ---
    _add_party(root, "AccountingSupplierParty", request.issuer, is_supplier=True, invoice_prefix=request.resolution_prefix)

    # --- Cliente ---
    _add_party(root, "AccountingCustomerParty", request.customer, is_supplier=False)

    # --- PaymentMeans ---
    # BUG CRITICO CORREGIDO (2026-08-31): el <cbc:ID> de PaymentMeans llevaba el
    # código de modalidad de pago de salud (catálogo salud_modalidades_pago.gc,
    # ej. "04"=evento, "02"=PGP, "03"=paquete) en vez de un código real de la
    # tabla DIAN "Forma de Pago" (6.3.4.1: solo "1"=Contado o "2"=Crédito). La
    # regla de rechazo FAN02 de la DIAN valida este campo contra esa tabla sin
    # tener en cuenta el atributo schemeName, así que cualquier modalidad
    # distinta de "1"/"2" (es decir, casi todas) se rechazaba con "Método de
    # pago inválido" (factura SETP994200137, confirmado). El código de
    # modalidad de pago SÍ va, pero solo en la etiqueta de salud
    # CustomTagGeneral/MODALIDAD_PAGO (ver mas abajo en health), que es un
    # campo totalmente independiente de este — confirmado comparando dos XML
    # ya validados por la DIAN/Min. Salud: NS95285.xml tiene PaymentMeans/ID="2"
    # con MODALIDAD_PAGO="04", y PRUE57 (factura PGP aprobada de este mismo
    # sistema) tiene PaymentMeans/ID="1" con MODALIDAD_PAGO="02" — es decir,
    # nunca coinciden entre sí y ambos pasan.
    #
    # Configurable por contrato (2026-08-31): en vez de un valor fijo, el valor
    # de PaymentMeans/ID para salud ahora viene del contrato del cliente
    # (ContratoSalud.forma_pago_eps para la factura a la EPS, y
    # ContratoSalud.forma_pago_usuario para la factura de pago por usuario /
    # cuota moderadora / copago al paciente), propagado por el backend Node en
    # health['forma_pago_eps'] / request.payment_means_id respectivamente.
    # IMPORTANTE: esto SOLO aplica a documentos del sector salud (factura EPS
    # con customization_id SS-* o factura de pago por usuario asociada a una
    # factura de salud). Las facturas comerciales normales NO pasan por esta
    # rama — buildInvoiceXmlPayload (facturación normal) nunca setea
    # payment_means_id, así que ese caso sigue siendo "1" exactamente igual
    # que antes de este cambio.
    is_health = bool(request.customization_id and request.customization_id.startswith("SS-"))
    pm = etree.SubElement(root, "{urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2}PaymentMeans")
    pm_id = etree.SubElement(pm, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}ID")
    if is_health:
        pm_id.text = (health.get('forma_pago_eps') or '2') if health else '2'
    elif request.payment_means_id:
        # Factura de pago por usuario (salud, cliente/paciente) — único caso no
        # health que envía este campo explícitamente.
        pm_id.text = request.payment_means_id
    else:
        pm_id.text = "1"
    etree.SubElement(pm, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}PaymentMeansCode").text = request.payment_means_code
    etree.SubElement(pm, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}PaymentDueDate").text = request.issue_date
    etree.SubElement(pm, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}PaymentID").text = "1"

    # --- PrepaidPayment (copago / cuota moderadora, Res. 948/2026) ---
    # Solo aplica si la factura de salud trae información de recaudo al usuario.
    prepaid = (health.get('prepaid_payment') if is_health else None) or None
    prepaid_amount = 0.0
    if prepaid and float(prepaid.get('paid_amount') or 0) > 0:
        prepaid_amount = float(prepaid.get('paid_amount') or 0)
        pp = etree.SubElement(root, "{urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2}PrepaidPayment")
        pp_id = etree.SubElement(pp, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}ID")
        pp_id.set("schemeID", str(prepaid.get('scheme_id') or '02'))
        pp_id.text = "1"
        etree.SubElement(pp, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}PaidAmount", currencyID=request.currency).text = _format_float(prepaid_amount)
        received_date = prepaid.get('received_date') or request.issue_date
        etree.SubElement(pp, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}ReceivedDate").text = received_date
        etree.SubElement(pp, "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}PaidDate").text = received_date

    # --- TAX TOTAL (cabecera) - MÚLTIPLES según tipo ---
    _add_header_tax_totals(root, tax_summary)

    # --- Legal Monetary Total ---
    # Si hubo copago/cuota moderadora, PayableAmount = total - PrepaidAmount
    # (lo que efectivamente le queda por pagar a la EPS). Confirmado contra NS82845.
    _add_legal_monetary_total(root, tax_summary, request.currency, prepaid_amount=prepaid_amount)

    # --- Invoice Lines ---
    # copagocuotam_valor (AdditionalItemProperty, ver NS82845): a pedido del
    # usuario, todo el valor del copago/cuota moderadora se pone en la primera
    # línea (idx==1) y 0 en el resto — igual que en el ejemplo NS82845, que solo
    # tenía una línea. No se reparte proporcional entre varias líneas por falta
    # de un criterio confirmado con la EPS.
    for idx, line in enumerate(request.lines, 1):
        _add_invoice_line(root, idx, line, processed_lines[idx-1], request.currency,
                           copago_valor=(prepaid_amount if idx == 1 else 0.0))

    # === Cálculo de CUFE, SoftwareSecurityCode y QR ===
    # Usamos grand_line_extension (el valor real que va en el XML como LineExtensionAmount)
    # Esto replica el comportamiento de la versión JS antigua que funcionaba.
    cufe = _compute_cufe(
        invoice_number=invoice_number,
        issue_date=request.issue_date,
        issue_time=issue_time,
        line_extension=tax_summary.grand_line_extension,
        cufe_tax_values=cufe_tax_values,
        # Si hubo copago/cuota moderadora, el CUFE debe calcularse con el mismo
        # PayableAmount que queda en el XML (total - PrepaidAmount), no con el
        # total bruto — de lo contrario el CUFE no coincidiría con el documento.
        payable_amount=tax_summary.grand_tax_inclusive - (prepaid_amount or 0.0),
        issuer_nit=request.issuer.nit,
        customer_nit=request.customer.nit,
        technical_key=request.technical_key_test,
        environment=request.environment,
    )

    software_security_code = _compute_software_security_code(
        request.software_id, request.software_pin, invoice_number
    )

    # Inyectar CUFE
    uuid_elem.text = cufe

    # === DianExtensions con método limpio (el más cercano al viejo código que funcionaba) ===
    clean_dian = _build_clean_dian_extensions(
        request, invoice_number, cufe, software_security_code, tax_summary
    )
    # Insertamos el bloque limpio en el lugar correcto
    ext_content1 = root.find('.//{urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2}ExtensionContent')
    if ext_content1 is not None:
        # Limpiamos cualquier DianExtensions anterior
        for old in ext_content1.findall('{dian:gov:co:facturaelectronica:Structures-2-1}DianExtensions'):
            ext_content1.remove(old)
        ext_content1.append(clean_dian)

    # Generar XML final con lxml
    xml_bytes = etree.tostring(
        root,
        xml_declaration=True,
        encoding="UTF-8",
        standalone=True,
        pretty_print=True,
    )

    # === SANITIZACIÓN FINAL OBLIGATORIA (Opción 1) ===
    # Esta es la capa principal dentro del Python.
    # Se ejecuta SIEMPRE antes de devolver el XML.
    xml_bytes = _force_correct_dian_literals(xml_bytes)

    xml_string = xml_bytes.decode("utf-8")

    metadata = {
        "cufe": cufe,
        "invoice_number": invoice_number,
        "software_security_code": software_security_code,
        "tax_summary": {
            "total_iva": tax_summary.total_iva,
            "total_inc": tax_summary.total_inc,
            "total_ica": tax_summary.total_ica,
            "line_extension": tax_summary.grand_line_extension,   # Valor que va en el XML
            "tax_exclusive": tax_summary.grand_tax_exclusive,     # Solo gravable
            "tax_inclusive": tax_summary.grand_tax_inclusive,
        },
    }

    return xml_string, metadata


def _add_party(parent, tag: str, party, is_supplier: bool, invoice_prefix: str = ''):
    """
    Versión robusta y completa de Party (emisor y receptor).
    Basada en ejemplos oficiales de la DIAN + patrones de Odoo l10n_co.
    """
    ns_cac = "{urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2}"
    ns_cbc = "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}"

    container = etree.SubElement(parent, f"{ns_cac}{tag}")
    etree.SubElement(container, f"{ns_cbc}AdditionalAccountID").text = getattr(party, 'person_type', '1') or '1'

    party_elem = etree.SubElement(container, f"{ns_cac}Party")

    # === cac:PartyIdentification — FAK61: obligatorio cuando AdditionalAccountID="2" (persona natural)
    # Debe ser el PRIMER hijo de cac:Party, antes de PartyName
    if getattr(party, 'person_type', '1') == '2':
        party_id_elem = etree.SubElement(party_elem, f"{ns_cac}PartyIdentification")
        pid = etree.SubElement(party_id_elem, f"{ns_cbc}ID")
        pid.set("schemeName", getattr(party, 'document_type', '13') or '13')
        pid.text = party.nit

    # PartyName (puede haber varios, pero al menos uno principal)
    name_elem = etree.SubElement(party_elem, f"{ns_cac}PartyName")
    etree.SubElement(name_elem, f"{ns_cbc}Name").text = party.name

    # === PhysicalLocation + Address completo (muy importante para DIAN) ===
    location = etree.SubElement(party_elem, f"{ns_cac}PhysicalLocation")
    address = etree.SubElement(location, f"{ns_cac}Address")
    etree.SubElement(address, f"{ns_cbc}ID").text = party.city_code or "11001"
    etree.SubElement(address, f"{ns_cbc}CityName").text = party.city_name or "Bogotá"
    etree.SubElement(address, f"{ns_cbc}CountrySubentity").text = party.department_name or "Bogotá"
    etree.SubElement(address, f"{ns_cbc}CountrySubentityCode").text = party.department_code or "11"

    # AddressLine es obligatorio en la práctica
    addr_line = etree.SubElement(address, f"{ns_cac}AddressLine")
    etree.SubElement(addr_line, f"{ns_cbc}Line").text = party.address or "Carrera 1 # 1-1"

    country = etree.SubElement(address, f"{ns_cac}Country")
    etree.SubElement(country, f"{ns_cbc}IdentificationCode").text = party.country_code or "CO"
    country_name = etree.SubElement(country, f"{ns_cbc}Name")
    country_name.set("languageID", "es")
    country_name.text = COUNTRY_NAME_ES

    # === PartyTaxScheme ===
    # Orden correcto que suele pasar validación DIAN (basado en lo que funcionaba antes):
    # CompanyID → TaxLevelCode → RegistrationAddress → TaxScheme
    tax_scheme = etree.SubElement(party_elem, f"{ns_cac}PartyTaxScheme")
    etree.SubElement(tax_scheme, f"{ns_cbc}RegistrationName").text = party.name

    company_id = etree.SubElement(tax_scheme, f"{ns_cbc}CompanyID")
    company_id.set("schemeAgencyID", AGENCY_ID_DIAN)
    company_id.set("schemeAgencyName", DIAN_AGENCY_NAME)
    # schemeID = DV del NIT;  schemeName = tipo de documento (31=NIT, 13=CC, etc.)
    company_id.set("schemeID", party.dv or "0")
    company_id.set("schemeName", getattr(party, 'document_type', '31') or '31')
    company_id.text = party.nit

    # TaxLevelCode justo después de CompanyID (este orden es el que más consistentemente pasa)
    tax_level = etree.SubElement(tax_scheme, f"{ns_cbc}TaxLevelCode")
    tax_level.set("listName", getattr(party, 'tax_level_list_name', None) or "05")
    tax_level.text = party.tax_level_code or "R-99-PN"

    # RegistrationAddress DENTRO de PartyTaxScheme (estructura completa)
    reg_address = etree.SubElement(tax_scheme, f"{ns_cac}RegistrationAddress")
    etree.SubElement(reg_address, f"{ns_cbc}ID").text = party.city_code or "11001"
    etree.SubElement(reg_address, f"{ns_cbc}CityName").text = party.city_name or "Bogotá"
    etree.SubElement(reg_address, f"{ns_cbc}CountrySubentity").text = party.department_name or "Bogotá"
    etree.SubElement(reg_address, f"{ns_cbc}CountrySubentityCode").text = party.department_code or "11"

    reg_addr_line = etree.SubElement(reg_address, f"{ns_cac}AddressLine")
    etree.SubElement(reg_addr_line, f"{ns_cbc}Line").text = party.address or "Carrera 1 # 1-1"

    reg_country = etree.SubElement(reg_address, f"{ns_cac}Country")
    etree.SubElement(reg_country, f"{ns_cbc}IdentificationCode").text = "CO"
    reg_country_name = etree.SubElement(reg_country, f"{ns_cbc}Name")
    reg_country_name.set("languageID", "es")
    reg_country_name.text = COUNTRY_NAME_ES

    # TaxScheme al final
    ts = etree.SubElement(tax_scheme, f"{ns_cac}TaxScheme")
    etree.SubElement(ts, f"{ns_cbc}ID").text = party.tax_scheme_id or "01"
    etree.SubElement(ts, f"{ns_cbc}Name").text = party.tax_scheme_name or "IVA"

    # === PartyLegalEntity ===
    legal = etree.SubElement(party_elem, f"{ns_cac}PartyLegalEntity")
    etree.SubElement(legal, f"{ns_cbc}RegistrationName").text = party.name

    company_id2 = etree.SubElement(legal, f"{ns_cbc}CompanyID")
    company_id2.set("schemeAgencyID", AGENCY_ID_DIAN)
    company_id2.set("schemeAgencyName", DIAN_AGENCY_NAME)
    company_id2.set("schemeID", party.dv or "0")
    # schemeName debe reflejar el tipo de documento real del party (31=NIT, 13=CC, etc.)
    # Para personas naturales (CC, CE, etc.) usar su document_type, no "31"
    company_id2.set("schemeName", getattr(party, 'document_type', '31') or '31')
    company_id2.text = party.nit

    # CorporateRegistrationScheme — solo emisor, con el prefijo de la resolución (FAB10a)
    if is_supplier:
        corp = etree.SubElement(legal, f"{ns_cac}CorporateRegistrationScheme")
        etree.SubElement(corp, f"{ns_cbc}ID").text = invoice_prefix or getattr(party, 'prefix', '') or 'SETP'

    # Contact: email (FAJ71) y teléfono — emisor siempre, adquiriente cuando están disponibles
    has_email = bool(getattr(party, 'email', None))
    has_phone = bool(getattr(party, 'phone', None))
    if is_supplier and has_email:
        contact = etree.SubElement(party_elem, f"{ns_cac}Contact")
        etree.SubElement(contact, f"{ns_cbc}ElectronicMail").text = party.email
    elif not is_supplier and (has_email or has_phone):
        contact = etree.SubElement(party_elem, f"{ns_cac}Contact")
        if has_phone:
            etree.SubElement(contact, f"{ns_cbc}Telephone").text = party.phone
        if has_email:
            etree.SubElement(contact, f"{ns_cbc}ElectronicMail").text = party.email

    # === cac:Person — va AL FINAL del Party (después de Contact).
    # FAK61 = cac:PartyIdentification (ya agregado arriba).
    # cac:Person con FirstName es requerido adicionalmente por la DIAN para persona natural.
    # Orden dentro de Person (UBL 2.1): FirstName → FamilyName → MiddleName → OtherName
    if getattr(party, 'person_type', '1') == '2':
        person_elem = etree.SubElement(party_elem, f"{ns_cac}Person")
        first  = getattr(party, 'first_name',        None) or party.name.split()[0]
        middle = getattr(party, 'middle_name',       None)
        family = getattr(party, 'family_name',       None) or (party.name.split()[1] if len(party.name.split()) > 1 else '')
        second = getattr(party, 'second_family_name', None)
        etree.SubElement(person_elem, f"{ns_cbc}FirstName").text = first
        if family:
            etree.SubElement(person_elem, f"{ns_cbc}FamilyName").text = family
        if middle:
            etree.SubElement(person_elem, f"{ns_cbc}MiddleName").text = middle
        if second:
            etree.SubElement(person_elem, f"{ns_cbc}OtherName").text = second


def _add_header_tax_totals(root, summary: InvoiceTaxSummary):
    ns_cac = "{urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2}"
    ns_cbc = "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}"

    # DIAN siempre requiere un <cac:TaxTotal> con IVA (01), incluso para facturas
    # de salud excluidas de IVA. DIAN solo acepta 01 y 04 como TaxScheme en TaxTotal;
    # ZA es un clasificador de línea, no un esquema de impuesto válido aquí (causa FAS01).
    if not summary.totals_by_type:
        tax_total = etree.SubElement(root, f"{ns_cac}TaxTotal")
        etree.SubElement(tax_total, f"{ns_cbc}TaxAmount", currencyID="COP").text = "0.00"
        subtotal = etree.SubElement(tax_total, f"{ns_cac}TaxSubtotal")
        etree.SubElement(subtotal, f"{ns_cbc}TaxableAmount", currencyID="COP").text = _format_float(summary.grand_line_extension)
        etree.SubElement(subtotal, f"{ns_cbc}TaxAmount", currencyID="COP").text = "0.00"
        cat = etree.SubElement(subtotal, f"{ns_cac}TaxCategory")
        etree.SubElement(cat, f"{ns_cbc}Percent").text = "0.00"
        scheme = etree.SubElement(cat, f"{ns_cac}TaxScheme")
        etree.SubElement(scheme, f"{ns_cbc}ID").text = "01"
        etree.SubElement(scheme, f"{ns_cbc}Name").text = "IVA"
        return

    for tax_code, data in summary.totals_by_type.items():
        tax_total = etree.SubElement(root, f"{ns_cac}TaxTotal")
        etree.SubElement(tax_total, f"{ns_cbc}TaxAmount", currencyID="COP").text = _format_float(data["total_amount"])

        for group in data["groups"]:
            # Seguridad adicional: no emitimos TaxSubtotal con tasa 0% (evita FAU04
            # cuando hay mezcla de tasas + ítems excluidos o a 0%).
            if not group.get("is_per_unit") and group.get("rate", 0) == 0:
                continue

            subtotal = etree.SubElement(tax_total, f"{ns_cac}TaxSubtotal")
            etree.SubElement(subtotal, f"{ns_cbc}TaxableAmount", currencyID="COP").text = _format_float(group["taxable"])
            etree.SubElement(subtotal, f"{ns_cbc}TaxAmount", currencyID="COP").text = _format_float(group["tax_amount"])

            cat = etree.SubElement(subtotal, f"{ns_cac}TaxCategory")
            if not group.get("is_per_unit"):
                etree.SubElement(cat, f"{ns_cbc}Percent").text = _format_float(group["rate"], 2)

            scheme = etree.SubElement(cat, f"{ns_cac}TaxScheme")
            etree.SubElement(scheme, f"{ns_cbc}ID").text = tax_code
            etree.SubElement(scheme, f"{ns_cbc}Name").text = data["name"]


# Tabla de modalidades de pago (catálogo salud_modalidades_pago.gc), compartida entre
# el CustomTagGeneral/MODALIDAD_PAGO y el cbc:ID de PaymentMeans para que ambos usen
# siempre el mismo código dentro de un mismo documento.
# Valores confirmados contra el XML NS82845 (factura de evento validada por el
# Ministerio de Salud): "evento" = schemeID "04", texto "Pago por evento".
_MODALIDAD_PAGO_MAP = {
    'evento':            ('04', 'Pago por evento'),
    'pgp':               ('02', 'Pago global prospectivo'),
    'paquete':           ('03', 'Paquete'),
    # aliases usados en el sistema
    'Evento':            ('04', 'Pago por evento'),
    'PGP':               ('02', 'Pago global prospectivo'),
    'Paquete':           ('03', 'Paquete'),
    'Global_Prospectivo':('02', 'Pago global prospectivo'),
    'SS-CUFE':           ('04', 'Pago por evento'),
    'SS-Recaudo':        ('02', 'Pago global prospectivo'),
}


def _get_modalidad_pago(modalidad: str) -> tuple[str, str]:
    return _MODALIDAD_PAGO_MAP.get(modalidad, ('04', 'Pago por evento'))


def _add_legal_monetary_total(root, summary: InvoiceTaxSummary, currency: str, prepaid_amount: float = 0.0):
    ns_cac = "{urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2}"
    ns_cbc = "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}"

    lmt = etree.SubElement(root, f"{ns_cac}LegalMonetaryTotal")

    # FAU04: TaxExclusiveAmount debe coincidir con la suma de TaxableAmount de las líneas.
    # Para facturas 100% excluidas (ZA / salud), grand_tax_exclusive=0 pero las líneas
    # declaran TaxableAmount=line_extension → usamos grand_line_extension como base.
    # Para facturas mixtas o con IVA real, grand_tax_exclusive ya tiene el valor correcto.
    tax_exclusive = summary.grand_tax_exclusive if summary.grand_tax_exclusive > 0 else summary.grand_line_extension

    # PayableAmount = total - PrepaidAmount (lo que queda por cobrar, ej. a la EPS,
    # después de descontar lo que ya pagó el usuario por copago/cuota moderadora).
    payable = summary.grand_tax_inclusive - (prepaid_amount or 0.0)

    etree.SubElement(lmt, f"{ns_cbc}LineExtensionAmount",   currencyID=currency).text = _format_float(summary.grand_line_extension)
    etree.SubElement(lmt, f"{ns_cbc}TaxExclusiveAmount",    currencyID=currency).text = _format_float(tax_exclusive)
    etree.SubElement(lmt, f"{ns_cbc}TaxInclusiveAmount",    currencyID=currency).text = _format_float(summary.grand_tax_inclusive)
    etree.SubElement(lmt, f"{ns_cbc}AllowanceTotalAmount",  currencyID=currency).text = "0.00"
    etree.SubElement(lmt, f"{ns_cbc}ChargeTotalAmount",     currencyID=currency).text = "0.00"
    etree.SubElement(lmt, f"{ns_cbc}PrepaidAmount",         currencyID=currency).text = _format_float(prepaid_amount or 0.0)
    etree.SubElement(lmt, f"{ns_cbc}PayableRoundingAmount", currencyID=currency).text = "0"
    etree.SubElement(lmt, f"{ns_cbc}PayableAmount",         currencyID=currency).text = _format_float(payable)


def _add_invoice_line(root, line_id: int, line: InvoiceLineItem, tax_result, currency: str, copago_valor: float = 0.0):
    ns_cac = "{urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2}"
    ns_cbc = "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}"

    inv_line = etree.SubElement(root, f"{ns_cac}InvoiceLine")
    etree.SubElement(inv_line, f"{ns_cbc}ID").text = str(line_id)
    qty = etree.SubElement(inv_line, f"{ns_cbc}InvoicedQuantity", unitCode=line.unit_code)
    qty.text = _format_float(line.quantity, 6)

    etree.SubElement(inv_line, f"{ns_cbc}LineExtensionAmount", currencyID=currency).text = _format_float(tax_result.line_extension)
    etree.SubElement(inv_line, f"{ns_cbc}FreeOfChargeIndicator").text = "false"

    # NOTA: No emitimos <cac:AllowanceCharge> para descuentos comerciales.
    # Esto sigue el patrón del módulo de Odoo (l10n_co_electronic_invoice_self)
    # y evita el error FAU04 por diferencias de redondeo entre BaseAmount/Amount
    # y LineExtensionAmount. El valor neto ya va correctamente en LineExtensionAmount.
    # El precio bruto va en Price/PriceAmount.

    # TaxTotal de la línea
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
    elif line.tax_type == "ZA":
        # FAS01: línea excluida de IVA. DIAN requiere TaxTotal con IVA (01) y 0%
        # tanto en línea como en cabecera. ZA no es un TaxScheme válido en TaxTotal.
        # TaxableAmount = valor real de la línea (FAX05: base gravable requerida).
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

    # SAL-020 (Res. 948/2026): si la línea trae identificación real del ítem
    # (CUPS/CUM + código del pagador) y/o número de autorización, se usa la
    # estructura confirmada contra el XML NS82845 (BuyersItemIdentification para
    # la autorización, StandardItemIdentification con el código real, y el
    # desglose del ítem como AdditionalItemProperty) en vez de la identificación
    # genérica UNSPSC + autorización concatenada en la descripción.
    health_item_code = getattr(line, 'health_item_code', None)
    authorization_number = getattr(line, 'authorization_number', None)

    if health_item_code or authorization_number:
        etree.SubElement(item, f"{ns_cbc}PackSizeNumeric").text = "1"
        if authorization_number:
            buyer_ident = etree.SubElement(item, f"{ns_cac}BuyersItemIdentification")
            buyer_id = etree.SubElement(buyer_ident, f"{ns_cbc}ID")
            buyer_id.set("schemeName", "AutorizaID-ERP/EPS")
            buyer_id.set("schemeVersionID", "AutorizaID-ERP/EPS")
            buyer_id.set("schemeAgencyID", "")
            buyer_id.text = authorization_number

        seller_ident = etree.SubElement(item, f"{ns_cac}SellersItemIdentification")
        etree.SubElement(seller_ident, f"{ns_cbc}ID")
        etree.SubElement(seller_ident, f"{ns_cbc}ExtendedID")

        std_ident = etree.SubElement(item, f"{ns_cac}StandardItemIdentification")
        std_id = etree.SubElement(std_ident, f"{ns_cbc}ID")
        std_id.set("schemeID", "999")
        std_id.set("schemeName", getattr(line, 'health_item_scheme_name', None) or "Estándar de adopción del contribuyente")
        std_id.text = health_item_code or line.unspsc

        unit_text = getattr(line, 'unit_text', None) or ''
        line_total = _format_float(line.quantity * line.unit_price)
        additional_props = [
            ("ValorTotalItem",   line_total),
            ("NumeroLinea",      str(line_id)),
            ("CantidadxPrecioU", line_total),
            ("codigo_item_erp",  health_item_code or ''),
            ("codigo_item",      health_item_code or ''),
            ("descripcion",      line.description),
            ("unidad",           unit_text),
            ("cantidad",         _format_float(line.quantity, 6)),
            ("precio_item",      _format_float(line.unit_price)),
            # Agregados 2026-08-31 a pedido del usuario, confirmados contra NS82845
            # (ejemplo real generado por SIESA para facturas de evento):
            # - copagocuotam_valor: valor del copago/cuota moderadora imputado a esta
            #   línea (todo en la primera línea, 0 en las demás — ver llamada arriba).
            # - precio_referencia / codigo_tipo_referencia: en NS82845 vienen fijos
            #   como "1"/"03" en todas las facturas de evento de SIESA; se deja igual
            #   por ahora (no depende de un tarifario propio todavía).
            ("copagocuotam_valor", _format_float(copago_valor)),
            ("precio_referencia",       "1"),
            ("codigo_tipo_referencia",  "03"),
        ]
        for name, value in additional_props:
            prop = etree.SubElement(item, f"{ns_cac}AdditionalItemProperty")
            etree.SubElement(prop, f"{ns_cbc}Name").text = name
            etree.SubElement(prop, f"{ns_cbc}Value").text = value
    else:
        # Comportamiento anterior — sin cambios para facturas normales/otras líneas
        # que no traigan identificación real de salud.
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


def _build_custom_tag_general_health(health: dict) -> "etree._Element | None":
    """
    Genera la extensión CustomTagGeneral obligatoria para facturas del Sector Salud.
    Resolución 948:2026 — requerida por el validador del Ministerio de Salud (ADRES/SAVIA).

    Mapeos:
      COBERTURA_PLAN_BENEFICIOS schemeID:
        subsidiado=01, contributivo=02, especial=03, excepcion=04
      MODALIDAD_PAGO schemeID (salud_modalidades_pago.gc):
        Evento/evento=01, PGP/pgp=02, Paquete/paquete=03
    """
    # Tabla de coberturas (Res. 948:2026 / validador Ministerio).
    # SIESA usa schemeID="01" tanto para subsidiado como contributivo — el texto diferencia el régimen.
    # schemeID diferencia el TIPO de plan (UPC=01, complementario=02, prepagada=03, etc.),
    # no el régimen (subsidiado/contributivo).
    COBERTURA_MAP = {
        'subsidiado':  ('01', 'Plan de beneficios en salud financiado con UPC Regimen Subsidiado'),
        'contributivo':('01', 'Plan de beneficios en salud financiado con UPC Regimen Contributivo'),
        'especial':    ('03', 'Regimen Especial'),
        'excepcion':   ('04', 'Regimen de Excepcion'),
    }
    # Tabla de cobertura por código real de tipoCoberturaAsegurado (RIPS, Res. 948/2026).
    # Confirmada contra el XML NS82845: paciente con tipoCoberturaAsegurado "16" (contributivo)
    # produce schemeID="16" en COBERTURA_PLAN_BENEFICIOS (no un código de "tipo de plan" 01-04).
    COBERTURA_TEXT_BY_CODE = {
        '16': 'Plan de beneficios en salud financiado con UPC Regimen Contributivo',
        '17': 'Plan de beneficios en salud financiado con UPC Regimen Subsidiado',
    }

    regimen       = health.get('regimen', 'contributivo') or 'contributivo'
    cod_prestador = health.get('cod_prestador', '') or ''
    periodo_inicio= health.get('periodo_inicio', '') or ''
    periodo_fin   = health.get('periodo_fin', '') or ''
    modalidad     = health.get('modalidad_pago', 'Evento') or 'Evento'
    cucon         = health.get('cucon', '') or ''
    factura_sin_contrato = health.get('factura_sin_contrato', '') or ''
    tipo_cobertura_asegurado = (health.get('tipo_cobertura_asegurado') or '').strip()

    # Determinar cobertura: preferir el código real (tipoCoberturaAsegurado) que ya se
    # calcula para el RIPS; si no viene o no está catalogado, usar el mapeo por régimen
    # como respaldo (comportamiento anterior).
    if tipo_cobertura_asegurado and tipo_cobertura_asegurado in COBERTURA_TEXT_BY_CODE:
        cob_id, cob_text = tipo_cobertura_asegurado, COBERTURA_TEXT_BY_CODE[tipo_cobertura_asegurado]
    elif tipo_cobertura_asegurado:
        # Código provisto explícitamente pero no catalogado localmente: respetarlo,
        # usando como texto el mejor esfuerzo según el régimen de la factura.
        cob_id = tipo_cobertura_asegurado
        cob_text = COBERTURA_MAP.get(regimen, ('01', 'Plan de beneficios en salud financiado con UPC Regimen Contributivo'))[1]
    else:
        cob_id, cob_text = COBERTURA_MAP.get(regimen, ('01', 'Plan de beneficios en salud financiado con UPC Regimen Contributivo'))
    # Determinar modalidad
    mod_id, mod_text = _get_modalidad_pago(modalidad)
    # NUMERO_CONTRATO: CUCON si existe, vacío si es factura sin contrato
    numero_contrato = cucon if cucon else ''
    # FACTURA_SIN_CONTRATO: causal si no hay CUCON
    sin_contrato_val = factura_sin_contrato if not cucon and factura_sin_contrato else ''

    xml_str = (
        '<Invoice:CustomTagGeneral'
        ' xmlns:Invoice="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">'
        '<Invoice:Name>Responsable</Invoice:Name>'
        '<Invoice:Value>url www.minsalud.gov.co</Invoice:Value>'
        '<Invoice:Name>Tipo, Identificador:a&#xF1;o del acto adminstrativo</Invoice:Name>'
        '<Invoice:Value>Resoluci&#xF3;n 948:2026</Invoice:Value>'
        '<Invoice:Interoperabilidad>'
        '<Invoice:InteroperabilidadPT>'
        '<Invoice:URLDescargaAdjuntos>'
        '<Invoice:URL/>'
        '</Invoice:URLDescargaAdjuntos>'
        '</Invoice:InteroperabilidadPT>'
        '<Invoice:Group schemeName="Sector Salud">'
        '<Invoice:Collection schemeName="Usuario">'
        f'<Invoice:AdditionalInformation>'
        f'<Invoice:Name>COBERTURA_PLAN_BENEFICIOS</Invoice:Name>'
        f'<Invoice:Value schemeID="{cob_id}">{cob_text}</Invoice:Value>'
        f'</Invoice:AdditionalInformation>'
        f'<Invoice:AdditionalInformation>'
        f'<Invoice:Name>CODIGO_PRESTADOR</Invoice:Name>'
        f'<Invoice:Value>{cod_prestador}</Invoice:Value>'
        f'</Invoice:AdditionalInformation>'
        f'<Invoice:AdditionalInformation>'
        f'<Invoice:Name>FACTURA_SIN_CONTRATO</Invoice:Name>'
        f'<Invoice:Value>{sin_contrato_val}</Invoice:Value>'
        f'</Invoice:AdditionalInformation>'
        f'<Invoice:AdditionalInformation>'
        f'<Invoice:Name>Fecha de inicio del periodo de facturación</Invoice:Name>'
        f'<Invoice:Value>{periodo_inicio}</Invoice:Value>'
        f'</Invoice:AdditionalInformation>'
        f'<Invoice:AdditionalInformation>'
        f'<Invoice:Name>Fecha final del periodo de facturación</Invoice:Name>'
        f'<Invoice:Value>{periodo_fin}</Invoice:Value>'
        f'</Invoice:AdditionalInformation>'
        f'<Invoice:AdditionalInformation>'
        f'<Invoice:Name>MODALIDAD_PAGO</Invoice:Name>'
        f'<Invoice:Value schemeName="salud_modalidades_pago.gc" schemeID="{mod_id}">{mod_text}</Invoice:Value>'
        f'</Invoice:AdditionalInformation>'
        f'<Invoice:AdditionalInformation>'
        f'<Invoice:Name>NUMERO_CONTRATO</Invoice:Name>'
        f'<Invoice:Value>{numero_contrato}</Invoice:Value>'
        f'</Invoice:AdditionalInformation>'
        f'<Invoice:AdditionalInformation>'
        f'<Invoice:Name>NUMERO_POLIZA</Invoice:Name>'
        f'<Invoice:Value/>'
        f'</Invoice:AdditionalInformation>'
        '</Invoice:Collection>'
        '</Invoice:Group>'
        '</Invoice:Interoperabilidad>'
        '</Invoice:CustomTagGeneral>'
    )
    try:
        return etree.fromstring(xml_str.encode('utf-8'))
    except Exception:
        return None


def _build_clean_dian_extensions(request: InvoiceGenerationRequest, invoice_number: str, cufe: str, ssc: str, tax_summary: InvoiceTaxSummary) -> etree._Element:
    """
    Versión ultra-segura: construimos el bloque completo como string XML
    con los literales EXACTOS (copiados del código viejo de Node + ejemplos DIAN),
    usando bytes explícitos para los caracteres problemáticos.
    """
    # Usamos bytes para forzar los caracteres correctos sin depender del encoding del archivo .py
    agency = b"CO, DIAN (Direcci\xc3\xb3n de Impuestos y Aduanas Nacionales)".decode("utf-8")
    profile = b"DIAN 2.1: Factura Electr\xc3\xb3nica de Venta".decode("utf-8")

    xml_str = f'''<sts:DianExtensions xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
<sts:InvoiceControl>
<sts:InvoiceAuthorization>{request.resolution_number}</sts:InvoiceAuthorization>
<sts:AuthorizationPeriod>
<cbc:StartDate>{request.resolution_start_date}</cbc:StartDate>
<cbc:EndDate>{request.resolution_end_date}</cbc:EndDate>
</sts:AuthorizationPeriod>
<sts:AuthorizedInvoices>
<sts:Prefix>{request.resolution_prefix}</sts:Prefix>
<sts:From>{request.resolution_from}</sts:From>
<sts:To>{request.resolution_to}</sts:To>
</sts:AuthorizedInvoices>
</sts:InvoiceControl>
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
<sts:QRCode>NroFactura={invoice_number}
NitFacturador={request.issuer.nit}
NitAdquiriente={request.customer.nit}
FechaFactura={request.issue_date}
ValorTotalFactura={_format_float(tax_summary.grand_tax_inclusive)}
CUFE={cufe}
URL={"https://catalogo-vpfe.dian.gov.co" if request.environment == "1" else "https://catalogo-vpfe-hab.dian.gov.co"}/Document/FindDocument?documentKey={cufe}</sts:QRCode>
</sts:DianExtensions>'''

    # Parseamos desde bytes UTF-8 explícitos
    return etree.fromstring(xml_str.encode("utf-8"))


def _add_dian_extensions(dian_ext, request: InvoiceGenerationRequest, invoice_number: str, cufe: str, ssc: str, tax_summary: InvoiceTaxSummary):
    """
    Versión que usa el método de string limpio + parseo para evitar corrupción.
    """
    clean_dian = _build_clean_dian_extensions(request, invoice_number, cufe, ssc, tax_summary)

    # Copiamos los hijos del fragmento limpio al elemento que ya existe en el árbol
    for child in list(clean_dian):
        dian_ext.append(child)


def _compute_cufe(
    invoice_number: str,
    issue_date: str,
    issue_time: str,
    line_extension: float,
    cufe_tax_values: dict,
    payable_amount: float,
    issuer_nit: str,
    customer_nit: str,
    technical_key: str,
    environment: str,
) -> str:
    """Cadena oficial del CUFE según Anexo Técnico."""
    val_fac = _format_float(line_extension)
    val_tot = _format_float(payable_amount)

    cufe_str = (
        f"{invoice_number}"
        f"{issue_date}"
        f"{issue_time}"
        f"{val_fac}"
        f"{cufe_tax_values['codImp1']}{cufe_tax_values['valImp1']}"
        f"{cufe_tax_values['codImp2']}{cufe_tax_values['valImp2']}"
        f"{cufe_tax_values['codImp3']}{cufe_tax_values['valImp3']}"
        f"{val_tot}"
        f"{issuer_nit}"
        f"{customer_nit}"
        f"{technical_key}"
        f"{environment}"
    )
    return sha384(cufe_str.encode("utf-8")).hexdigest()


def _compute_software_security_code(software_id: str, pin: str, invoice_number: str) -> str:
    s = f"{software_id}{pin}{invoice_number}"
    return sha384(s.encode("utf-8")).hexdigest()


def _force_correct_dian_literals(xml_bytes: bytes) -> bytes:
    """
    Versión nuclear de sanitización (Opción 1).

    Objetivo: Sin importar lo que haya pasado antes, el XML que sale de aquí
    tiene los dos literales EXACTOS que la DIAN exige.

    Se hace en varias capas:
    - Bytes (patrones conocidos de mojibake)
    - String con múltiples pasadas usando las constantes limpias
    """
    from .constants import CORRECT_PROFILE_ID, CORRECT_DIAN_AGENCY

    result = xml_bytes

    # Capa 1: Bytes - arreglamos corrupciones conocidas de "ó"
    known_bad_bytes = [
        b"Electr\xc3\x83\xc2\xb3nica",
        b"Direcci\xc3\x83\xc2\xb3n",
        b"Electr\xc3\x83\xc2\x83\xc3\x82\xc2\xb3nica",
        b"Direcci\xc3\x83\xc2\x83\xc3\x82\xc2\xb3n",
    ]
    good_bytes = {
        b"Electr\xc3\x83\xc2\xb3nica": b"Electr\xc3\xb3nica",
        b"Direcci\xc3\x83\xc2\xb3n": b"Direcci\xc3\xb3n",
    }

    for bad in known_bad_bytes:
        if bad in result and bad in good_bytes:
            result = result.replace(bad, good_bytes[bad])

    # Capa 2: String - forzado final con las constantes limpias (múltiples rondas)
    try:
        xml_str = result.decode("utf-8", errors="replace")
    except:
        xml_str = result.decode("latin-1", errors="replace")

    correct_profile = CORRECT_PROFILE_ID
    correct_agency = CORRECT_DIAN_AGENCY

    # Varias pasadas para romper cualquier capa de corrupción
    for _ in range(5):
        xml_str = xml_str.replace("DIAN 2.1: Factura Electrónica de Venta", correct_profile)
        xml_str = xml_str.replace("DIAN 2.1: Factura Electr��nica de Venta", correct_profile)
        xml_str = xml_str.replace("DIAN 2.1: Factura Electr���nica de Venta", correct_profile)
        xml_str = xml_str.replace("DIAN 2.1: Factura Electr����nica de Venta", correct_profile)

        xml_str = xml_str.replace("CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)", correct_agency)
        xml_str = xml_str.replace("CO, DIAN (Direcci��n de Impuestos y Aduanas Nacionales)", correct_agency)
        xml_str = xml_str.replace("CO, DIAN (Direcci���n de Impuestos y Aduanas Nacionales)", correct_agency)
        xml_str = xml_str.replace("CO, DIAN (Direcci����n de Impuestos y Aduanas Nacionales)", correct_agency)

    return xml_str.encode("utf-8")
