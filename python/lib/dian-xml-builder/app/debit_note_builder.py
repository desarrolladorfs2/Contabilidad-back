"""
Generador de XML UBL 2.1 para Nota Débito Electrónica DIAN Colombia.

Diferencias clave vs Nota Crédito (credit_note_builder.py):

  1. Root element:     DebitNote  (namespace DebitNote-2)
  2. CustomizationID: "32"        (ND con referencia, tabla 13.1.5.3)
  3. ProfileID:       "DIAN 2.1: Nota Débito de Factura Electrónica de Venta"
  4. Líneas:          DebitNoteLine + DebitedQuantity
  5. Totales:         RequestedMonetaryTotal (NC usa LegalMonetaryTotal)
  6. Concepto:        tabla 13.1.5.3  (1=Intereses, 2=Gastos, 3=Cambio valor, 4=Otros)

CUDE: idéntico al de NC — SHA-384 con Software-PIN (NO ClTec).
Ref: Anexo Técnico DIAN v1.9 §11.4.3

Ejemplo XML de referencia:
  docs/.../Ejemplificacion nota debito sin referencia a factura.xml
"""

import base64
from datetime import datetime, timezone, timedelta
from hashlib import sha384
from typing import Any

from lxml import etree

from .constants import AGENCY_ID_DIAN, CORRECT_DIAN_AGENCY, CORRECT_PROFILE_ID
from .schemas import DebitNoteGenerationRequest, CONCEPTO_NOTA_DEBITO
from .builder import _build_custom_tag_general_health
from .tax_engine import (
    calculate_line_taxes,
    aggregate_invoice_taxes,
    InvoiceTaxSummary,
    get_cufe_tax_values,
)

COLOMBIA_TZ = timezone(timedelta(hours=-5))

# Namespace raíz para DebitNote (distinto al de CreditNote e Invoice)
DEBIT_NOTE_NS = "urn:oasis:names:specification:ubl:schema:xsd:DebitNote-2"

NS_MAP_DN = {
    None: DEBIT_NOTE_NS,
    "cac": "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
    "cbc": "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
    "ext": "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2",
    "ds":  "http://www.w3.org/2000/09/xmldsig#",
    "xades":    "http://uri.etsi.org/01903/v1.3.2#",
    "xades141": "http://uri.etsi.org/01903/v1.4.1#",
    "sts": "dian:gov:co:facturaelectronica:Structures-2-1",
    "xsi": "http://www.w3.org/2001/XMLSchema-instance",
}

_CAC = "{urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2}"
_CBC = "{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}"
_EXT = "{urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2}"
_STS = "{dian:gov:co:facturaelectronica:Structures-2-1}"

DIAN_AGENCY_NAME  = b"CO, DIAN (Direcci\xc3\xb3n de Impuestos y Aduanas Nacionales)".decode("utf-8")
COUNTRY_NAME_ES   = "Colombia"
PROFILE_ID_ND     = b"DIAN 2.1: Nota D\xc3\xa9bito de Factura Electr\xc3\xb3nica de Venta".decode("utf-8")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _format_float(value: float, decimals: int = 2) -> str:
    return f"{round(value, decimals):.{decimals}f}"


def _calculate_dv(nit: str) -> str:
    pesos  = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71]
    digits = [int(d) for d in str(nit).replace(".", "").replace(",", "")[-15:]][::-1]
    total  = sum(d * p for d, p in zip(digits, pesos[: len(digits)]))
    mod    = total % 11
    return str(11 - mod) if mod > 1 else str(mod)


# ---------------------------------------------------------------------------
# CUDE — idéntico al de NC: SHA-384 + Software-PIN
# ---------------------------------------------------------------------------

def _compute_cude(
    dn_number: str,
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
    CUDE para Nota Débito — mismo algoritmo que NC (Anexo Técnico §11.4.3).
    Usa Software-PIN, NO clave técnica.
    """
    val_fac = _format_float(line_extension)
    val_tot = _format_float(payable_amount)

    cude_str = (
        f"{dn_number}{issue_date}{issue_time}{val_fac}"
        f"{cufe_tax_values['codImp1']}{cufe_tax_values['valImp1']}"
        f"{cufe_tax_values['codImp2']}{cufe_tax_values['valImp2']}"
        f"{cufe_tax_values['codImp3']}{cufe_tax_values['valImp3']}"
        f"{val_tot}{issuer_nit}{customer_nit}{software_pin}{environment}"
    )
    result = sha384(cude_str.encode("utf-8")).hexdigest()
    print(f"[CUDE-ND] cadena : {cude_str}", flush=True)
    print(f"[CUDE-ND] hash   : {result}", flush=True)
    return result


def _compute_software_security_code(software_id: str, pin: str, doc_number: str) -> str:
    return sha384(f"{software_id}{pin}{doc_number}".encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# DianExtensions para Nota Débito (sin InvoiceControl — igual que NC)
# ---------------------------------------------------------------------------

def _build_dian_extensions(
    request: DebitNoteGenerationRequest,
    dn_number: str,
    cude: str,
    ssc: str,
    tax_summary: InvoiceTaxSummary,
    issue_date: str,
) -> etree._Element:
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
<sts:QRCode>NroFactura={dn_number}
NitFacturador={request.issuer.nit}
NitAdquiriente={request.customer.nit}
FechaFactura={issue_date}
ValorTotalFactura={_format_float(tax_summary.grand_tax_inclusive)}
CUFE={cude}
URL=https://catalogo-vpfe-hab.dian.gov.co/Document/FindDocument?documentKey={cude}</sts:QRCode>
</sts:DianExtensions>'''
    return etree.fromstring(xml_str.encode("utf-8"))


# ---------------------------------------------------------------------------
# Party (idéntico a credit_note_builder)
# ---------------------------------------------------------------------------

def _add_party(parent: etree._Element, tag: str, party, is_supplier: bool):
    container = etree.SubElement(parent, f"{_CAC}{tag}")
    etree.SubElement(container, f"{_CBC}AdditionalAccountID").text = getattr(party, 'person_type', '1') or '1'
    party_elem = etree.SubElement(container, f"{_CAC}Party")

    name_elem = etree.SubElement(party_elem, f"{_CAC}PartyName")
    etree.SubElement(name_elem, f"{_CBC}Name").text = party.name

    location = etree.SubElement(party_elem, f"{_CAC}PhysicalLocation")
    address  = etree.SubElement(location, f"{_CAC}Address")
    etree.SubElement(address, f"{_CBC}ID").text = party.city_code or "11001"
    etree.SubElement(address, f"{_CBC}CityName").text = party.city_name or "Bogotá"
    etree.SubElement(address, f"{_CBC}CountrySubentity").text = party.department_name or "Bogotá"
    etree.SubElement(address, f"{_CBC}CountrySubentityCode").text = party.department_code or "11"
    addr_line = etree.SubElement(address, f"{_CAC}AddressLine")
    etree.SubElement(addr_line, f"{_CBC}Line").text = party.address or "Carrera 1 # 1-1"
    country = etree.SubElement(address, f"{_CAC}Country")
    etree.SubElement(country, f"{_CBC}IdentificationCode").text = "CO"
    cn = etree.SubElement(country, f"{_CBC}Name")
    cn.set("languageID", "es")
    cn.text = COUNTRY_NAME_ES

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

    legal = etree.SubElement(party_elem, f"{_CAC}PartyLegalEntity")
    etree.SubElement(legal, f"{_CBC}RegistrationName").text = party.name
    company_id2 = etree.SubElement(legal, f"{_CBC}CompanyID")
    company_id2.set("schemeAgencyID", AGENCY_ID_DIAN)
    company_id2.set("schemeAgencyName", DIAN_AGENCY_NAME)
    company_id2.set("schemeID", party.dv or "0")
    company_id2.set("schemeName", "31")
    company_id2.text = party.nit
    corp = etree.SubElement(legal, f"{_CAC}CorporateRegistrationScheme")
    etree.SubElement(corp, f"{_CBC}ID").text = getattr(party, "prefix", None) or "ND"


# ---------------------------------------------------------------------------
# TaxTotal cabecera
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
# RequestedMonetaryTotal  ← DIFERENCIA vs NC (que usa LegalMonetaryTotal)
# ---------------------------------------------------------------------------

def _add_requested_monetary_total(root: etree._Element, summary: InvoiceTaxSummary, currency: str):
    rmt = etree.SubElement(root, f"{_CAC}RequestedMonetaryTotal")
    etree.SubElement(rmt, f"{_CBC}LineExtensionAmount", currencyID=currency).text = _format_float(summary.grand_line_extension)
    etree.SubElement(rmt, f"{_CBC}TaxExclusiveAmount",  currencyID=currency).text = _format_float(summary.grand_tax_exclusive)
    etree.SubElement(rmt, f"{_CBC}TaxInclusiveAmount",  currencyID=currency).text = _format_float(summary.grand_tax_inclusive)
    etree.SubElement(rmt, f"{_CBC}PayableAmount",       currencyID=currency).text = _format_float(summary.grand_tax_inclusive)


# ---------------------------------------------------------------------------
# DebitNoteLine  ← DIFERENCIA vs NC (que usa CreditNoteLine + CreditedQuantity)
# ---------------------------------------------------------------------------

def _add_debit_note_line(
    root: etree._Element,
    line_id: int,
    line,
    tax_result,
    currency: str,
):
    dn_line = etree.SubElement(root, f"{_CAC}DebitNoteLine")
    etree.SubElement(dn_line, f"{_CBC}ID").text = str(line_id)

    # DebitedQuantity (en vez de CreditedQuantity / InvoicedQuantity)
    qty = etree.SubElement(dn_line, f"{_CBC}DebitedQuantity", unitCode=line.unit_code)
    qty.text = _format_float(line.quantity, 6)

    etree.SubElement(dn_line, f"{_CBC}LineExtensionAmount", currencyID=currency).text = _format_float(tax_result.line_extension)

    if tax_result.tax_details:
        for td in tax_result.tax_details:
            tt  = etree.SubElement(dn_line, f"{_CAC}TaxTotal")
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

    item = etree.SubElement(dn_line, f"{_CAC}Item")
    etree.SubElement(item, f"{_CBC}Description").text = line.description
    std_ident = etree.SubElement(item, f"{_CAC}StandardItemIdentification")
    std_id = etree.SubElement(std_ident, f"{_CBC}ID")
    std_id.set("schemeID", "999")
    std_id.set("schemeName", "UNSPSC")
    std_id.text = line.unspsc

    price_elem = etree.SubElement(dn_line, f"{_CAC}Price")
    etree.SubElement(price_elem, f"{_CBC}PriceAmount", currencyID=currency).text = _format_float(line.unit_price)
    bq = etree.SubElement(price_elem, f"{_CBC}BaseQuantity", unitCode=line.unit_code)
    bq.text = "1.000000"


# ---------------------------------------------------------------------------
# Sanitización final
# ---------------------------------------------------------------------------

def _force_correct_literals(xml_bytes: bytes) -> bytes:
    result = xml_bytes
    corrections = {
        b"Electr\xc3\x83\xc2\xb3nica": b"Electr\xc3\xb3nica",
        b"Direcci\xc3\x83\xc2\xb3n":   b"Direcci\xc3\xb3n",
    }
    for bad, good in corrections.items():
        result = result.replace(bad, good)
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
            "DIAN 2.1: Nota Débito de Factura Electrónica de Venta", PROFILE_ID_ND
        )
    return xml_str.encode("utf-8")


# ---------------------------------------------------------------------------
# Función principal
# ---------------------------------------------------------------------------

def build_dian_debit_note_xml(
    request: DebitNoteGenerationRequest,
) -> tuple[str, dict[str, Any]]:
    """
    Construye el XML completo de una Nota Débito Electrónica DIAN UBL 2.1.

    Retorna:
        (xml_string, metadata)
    """
    if not request.issuer.dv:
        request.issuer.dv = _calculate_dv(request.issuer.nit)
    if not request.customer.dv:
        request.customer.dv = _calculate_dv(request.customer.nit)

    dn_number  = f"{request.prefix}{request.number}"
    _now_co    = datetime.now(COLOMBIA_TZ)
    issue_date = _now_co.strftime("%Y-%m-%d")
    issue_time = _now_co.strftime("%H:%M:%S-05:00")

    # Procesar líneas + impuestos
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

    # Árbol XML — raíz DebitNote
    root = etree.Element("{" + DEBIT_NOTE_NS + "}DebitNote", nsmap=NS_MAP_DN)

    # UBLExtensions
    ubl_extensions = etree.SubElement(root, f"{_EXT}UBLExtensions")
    ext1 = etree.SubElement(ubl_extensions, f"{_EXT}UBLExtension")
    ec1  = etree.SubElement(ext1, f"{_EXT}ExtensionContent")
    etree.SubElement(ec1, f"{_STS}DianExtensions")   # placeholder

    ext2 = etree.SubElement(ubl_extensions, f"{_EXT}UBLExtension")
    ec2  = etree.SubElement(ext2, f"{_EXT}ExtensionContent")
    ec2.append(etree.Comment(" ESPACIO RESERVADO PARA LA FIRMA DIGITAL XAdES "))

    # Extensión 3: CustomTagGeneral Sector Salud (Resolución 948:2026) — solo si
    # la ND corresponde a una factura de salud (viene el dict `health`).
    health = request.health or {}
    if health:
        ctg_xml = _build_custom_tag_general_health(health)
        if ctg_xml is not None:
            ext3 = etree.SubElement(ubl_extensions, f"{_EXT}UBLExtension")
            ec3  = etree.SubElement(ext3, f"{_EXT}ExtensionContent")
            ec3.append(ctg_xml)

    # Cabecera
    etree.SubElement(root, f"{_CBC}UBLVersionID").text      = "UBL 2.1"
    etree.SubElement(root, f"{_CBC}CustomizationID").text   = "32"           # ND = 32 (tabla 13.1.5.3)
    etree.SubElement(root, f"{_CBC}ProfileID").text         = PROFILE_ID_ND
    etree.SubElement(root, f"{_CBC}ProfileExecutionID").text = request.environment
    etree.SubElement(root, f"{_CBC}ID").text                = dn_number

    uuid_elem = etree.SubElement(root, f"{_CBC}UUID")
    uuid_elem.set("schemeID", request.environment)
    uuid_elem.set("schemeName", "CUDE-SHA384")

    etree.SubElement(root, f"{_CBC}IssueDate").text = issue_date
    etree.SubElement(root, f"{_CBC}IssueTime").text = issue_time

    if request.note:
        etree.SubElement(root, f"{_CBC}Note").text = request.note

    currency_elem = etree.SubElement(root, f"{_CBC}DocumentCurrencyCode")
    currency_elem.set("listAgencyID", "6")
    currency_elem.set("listAgencyName", "United Nations Economic Commission for Europe")
    currency_elem.set("listID", "ISO 4217 Alpha")
    currency_elem.text = request.currency

    etree.SubElement(root, f"{_CBC}LineCountNumeric").text = str(len(request.lines))

    # DiscrepancyResponse (tabla 13.1.5.3)
    discrepancy = etree.SubElement(root, f"{_CAC}DiscrepancyResponse")
    etree.SubElement(discrepancy, f"{_CBC}ReferenceID").text  = request.billing_reference.invoice_id
    etree.SubElement(discrepancy, f"{_CBC}ResponseCode").text = request.discrepancy_code
    official_desc = CONCEPTO_NOTA_DEBITO.get(request.discrepancy_code, "Otros")
    etree.SubElement(discrepancy, f"{_CBC}Description").text  = official_desc

    # BillingReference
    billing_ref = etree.SubElement(root, f"{_CAC}BillingReference")
    inv_doc_ref = etree.SubElement(billing_ref, f"{_CAC}InvoiceDocumentReference")
    etree.SubElement(inv_doc_ref, f"{_CBC}ID").text = request.billing_reference.invoice_id
    uuid_ref = etree.SubElement(inv_doc_ref, f"{_CBC}UUID")
    uuid_ref.set("schemeName", "CUFE-SHA384")
    uuid_ref.text = request.billing_reference.invoice_uuid
    etree.SubElement(inv_doc_ref, f"{_CBC}IssueDate").text = request.billing_reference.invoice_date

    # Emisor + Cliente
    _add_party(root, "AccountingSupplierParty", request.issuer,   is_supplier=True)
    _add_party(root, "AccountingCustomerParty", request.customer, is_supplier=False)

    # PaymentMeans
    pm = etree.SubElement(root, f"{_CAC}PaymentMeans")
    etree.SubElement(pm, f"{_CBC}ID").text               = "1"
    etree.SubElement(pm, f"{_CBC}PaymentMeansCode").text  = "10"
    etree.SubElement(pm, f"{_CBC}PaymentDueDate").text    = issue_date
    etree.SubElement(pm, f"{_CBC}PaymentID").text         = "1"

    # TaxTotal cabecera
    _add_header_tax_totals(root, tax_summary)

    # RequestedMonetaryTotal  ← diferencia vs NC
    _add_requested_monetary_total(root, tax_summary, request.currency)

    # DebitNoteLines  ← diferencia vs NC
    for idx, line in enumerate(request.lines, 1):
        _add_debit_note_line(root, idx, line, processed_lines[idx - 1], request.currency)

    # Calcular CUDE y SSC
    cude = _compute_cude(
        dn_number=dn_number,
        issue_date=issue_date,
        issue_time=issue_time,
        line_extension=tax_summary.grand_line_extension,
        cufe_tax_values=cufe_tax_values,
        payable_amount=tax_summary.grand_tax_inclusive,
        issuer_nit=request.issuer.nit,
        customer_nit=request.customer.nit,
        software_pin=request.software_pin,
        environment=request.environment,
    )
    ssc = _compute_software_security_code(request.software_id, request.software_pin, dn_number)

    uuid_elem.text = cude

    # Inyectar DianExtensions real
    clean_dian = _build_dian_extensions(
        request=request, dn_number=dn_number, cude=cude,
        ssc=ssc, tax_summary=tax_summary, issue_date=issue_date,
    )
    found_ec1 = root.find(f".//{_EXT}ExtensionContent")
    if found_ec1 is not None:
        for old in found_ec1.findall(f"{_STS}DianExtensions"):
            found_ec1.remove(old)
        found_ec1.append(clean_dian)

    # Serializar
    xml_bytes = etree.tostring(
        root,
        xml_declaration=True,
        encoding="UTF-8",
        standalone=True,
        pretty_print=True,
    )
    xml_bytes  = _force_correct_literals(xml_bytes)
    xml_string = xml_bytes.decode("utf-8")

    metadata = {
        "cude":              cude,
        "debit_note_number": dn_number,
        "software_security_code": ssc,
        "billing_reference": {
            "invoice_id":   request.billing_reference.invoice_id,
            "invoice_uuid": request.billing_reference.invoice_uuid,
            "invoice_date": request.billing_reference.invoice_date,
        },
        "discrepancy_code": request.discrepancy_code,
        "tax_summary": {
            "total_iva":      tax_summary.total_iva,
            "total_inc":      tax_summary.total_inc,
            "total_ica":      tax_summary.total_ica,
            "line_extension": tax_summary.grand_line_extension,
            "tax_exclusive":  tax_summary.grand_tax_exclusive,
            "tax_inclusive":  tax_summary.grand_tax_inclusive,
        },
    }

    return xml_string, metadata
