#!/usr/bin/env python3
"""
ds_xml_builder_cli.py

CLI para generación de XML UBL 2.1 del Documento Soporte (Res. DIAN 0167/2021)
y sus Notas de Ajuste (DocumentTypeCode 92/93).

Lee JSON por stdin, opera según el argumento argv[1], escribe JSON por stdout.

Operaciones:
  generate-ds           → XML DocumentoSoporte (DocTypeCode 91)
  generate-nota-ajuste  → XML NotaAjuste (DocTypeCode 92 o 93)
  generate-ds-pdf       → PDF del DocumentoSoporte

IMPORTANTE — roles invertidos vs. factura normal:
  AccountingSupplierParty = nuestra empresa (la obligada a facturar)
  AccountingCustomerParty = la persona NO obligada (proveedor en términos de negocio)
"""

import sys
import json
import hashlib
import traceback
from datetime import datetime, date
from typing import Any

# ─── Utilidades ──────────────────────────────────────────────────────────────

def ok(data: dict) -> None:
    print(json.dumps({"success": True, **data}), flush=True)

def fail(msg: str) -> None:
    print(json.dumps({"success": False, "error": msg, "traceback": traceback.format_exc()}), flush=True)

def read_stdin() -> dict:
    raw = sys.stdin.read()
    return json.loads(raw)

def fmt_date(d: str | None) -> str:
    if not d:
        return date.today().isoformat()
    return str(d)[:10]

def fmt_amount(v) -> str:
    return f"{float(v or 0):.2f}"

# ─── CUDS ────────────────────────────────────────────────────────────────────

def calcular_cuds(payload: dict) -> str:
    """
    Calcula el CUDS (Código Único del Documento Soporte) mediante SHA3-256.
    Concatenación: NumDS + FechaEmision + ValorTotal + CodImp1 + ValImp1 +
                   CodImp2 + ValImp2 + NitEmisor + NumAdquiriente + ClTec
    Ref: Res. 0167/2021 Anexo Técnico.
    """
    num_ds        = payload.get("ds_number", "")
    fecha         = fmt_date(payload.get("issue_date"))
    valor_total   = fmt_amount(payload.get("total", 0))

    # Impuesto 1: IVA (código "01")
    iva           = float(payload.get("iva_total", 0))
    cod_imp1      = "01" if iva > 0 else ""
    val_imp1      = fmt_amount(iva) if iva > 0 else ""

    # Impuesto 2: INC/otros (dejar vacío si no aplica)
    cod_imp2      = ""
    val_imp2      = ""

    nit_emisor    = payload.get("issuer", {}).get("nit", "")
    nit_proveedor = payload.get("non_obligated", {}).get("nit", "")
    cl_tec        = payload.get("technical_key", "")

    cadena = (
        f"{num_ds}{fecha}{valor_total}"
        f"{cod_imp1}{val_imp1}"
        f"{cod_imp2}{val_imp2}"
        f"{nit_emisor}{nit_proveedor}{cl_tec}"
    )

    return hashlib.sha3_256(cadena.encode("utf-8")).hexdigest()

# ─── XML UBL 2.1 ─────────────────────────────────────────────────────────────

NS = {
    "xmlns":     "urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2",
    "cac":       "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
    "cbc":       "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
    "ext":       "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2",
    "sts":       "dian:gov:co:facturaelectronica:Structures-2-1",
    "xades":     "http://uri.etsi.org/01903/v1.3.2#",
    "xades141":  "http://uri.etsi.org/01903/v1.4.1#",
    "xsi":       "http://www.w3.org/2001/XMLSchema-instance",
}

DS_NS = (
    'xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" '
    'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" '
    'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" '
    'xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" '
    'xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1" '
    'xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" '
    'xmlns:xades141="http://uri.etsi.org/01903/v1.4.1#" '
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
)

def e(tag: str, val: str, attrs: str = "") -> str:
    """Genera un elemento XML simple."""
    if attrs:
        return f"<{tag} {attrs}>{_esc(val)}</{tag}>"
    return f"<{tag}>{_esc(val)}</{tag}>"

def _esc(s: str) -> str:
    return (str(s)
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;"))

def build_party(info: dict, role: str) -> str:
    """Genera bloque cac:AccountingSupplierParty o cac:AccountingCustomerParty."""
    nit      = info.get("nit", "")
    name     = info.get("name", "")
    doc_type = info.get("document_type", "13")
    p_type   = info.get("person_type", "2")
    city_c   = info.get("city_code", "11001")
    city_n   = info.get("city_name", "Bogota")
    dept_c   = info.get("department_code", "11")
    dept_n   = info.get("department_name", "Bogota")
    address  = info.get("address", "")
    email    = info.get("email", "")
    tax_lvl  = info.get("tax_level_code", "R-99-PN")

    block = f"""
    <cac:{role}>
      <cac:Party>
        <cac:PartyIdentification>
          <cbc:ID schemeID="{doc_type}">{_esc(nit)}</cbc:ID>
        </cac:PartyIdentification>
        <cac:PartyName>
          <cbc:Name>{_esc(name)}</cbc:Name>
        </cac:PartyName>
        <cac:PhysicalLocation>
          <cac:Address>
            <cbc:CityName>{_esc(city_n)}</cbc:CityName>
            <cbc:CountrySubentity>{_esc(dept_n)}</cbc:CountrySubentity>
            <cac:AddressLine>
              <cbc:Line>{_esc(address)}</cbc:Line>
            </cac:AddressLine>
            <cac:Country>
              <cbc:IdentificationCode>CO</cbc:IdentificationCode>
              <cbc:Name>Colombia</cbc:Name>
            </cac:Country>
          </cac:Address>
        </cac:PhysicalLocation>
        <cac:PartyTaxScheme>
          <cbc:RegistrationName>{_esc(name)}</cbc:RegistrationName>
          <cbc:CompanyID schemeID="{doc_type}" schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">{_esc(nit)}</cbc:CompanyID>
          <cbc:TaxLevelCode listName="48">{_esc(tax_lvl)}</cbc:TaxLevelCode>
          <cac:RegistrationAddress>
            <cbc:CityName>{_esc(city_n)}</cbc:CityName>
            <cbc:CountrySubentity>{_esc(dept_n)}</cbc:CountrySubentity>
            <cac:AddressLine>
              <cbc:Line>{_esc(address)}</cbc:Line>
            </cac:AddressLine>
            <cac:Country>
              <cbc:IdentificationCode>CO</cbc:IdentificationCode>
              <cbc:Name>Colombia</cbc:Name>
            </cac:Country>
          </cac:RegistrationAddress>
          <cac:TaxScheme>
            <cbc:ID>ZZ</cbc:ID>
            <cbc:Name>No aplica</cbc:Name>
          </cac:TaxScheme>
        </cac:PartyTaxScheme>
        <cac:PartyLegalEntity>
          <cbc:RegistrationName>{_esc(name)}</cbc:RegistrationName>
          <cbc:CompanyID schemeID="{doc_type}" schemeAgencyID="195">{_esc(nit)}</cbc:CompanyID>
          <cac:CorporateRegistrationScheme>
            <cbc:ID>{_esc(nit)}</cbc:ID>
          </cac:CorporateRegistrationScheme>
        </cac:PartyLegalEntity>
        <cac:Contact>
          <cbc:ElectronicMail>{_esc(email)}</cbc:ElectronicMail>
        </cac:Contact>
        <cac:Person>
          <cbc:FirstName>{_esc(info.get("primer_nombre") or name.split()[0])}</cbc:FirstName>
          <cbc:FamilyName>{_esc(info.get("primer_apellido") or "")}</cbc:FamilyName>
          <cbc:MiddleName>{_esc(info.get("segundo_nombre") or "")}</cbc:MiddleName>
        </cac:Person>
      </cac:Party>
    </cac:{role}>"""
    return block

def build_tax_totals(iva_total: float) -> str:
    if iva_total <= 0:
        return ""
    return f"""
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="COP">{fmt_amount(iva_total)}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="COP">{fmt_amount(iva_total)}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="COP">{fmt_amount(iva_total)}</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:Percent>19.00</cbc:Percent>
          <cac:TaxScheme>
            <cbc:ID>01</cbc:ID>
            <cbc:Name>IVA</cbc:Name>
          </cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>"""

def build_lines(lines: list, currency: str = "COP", fallback_subtotal: float = 0.0) -> str:
    if not lines:
        # Línea mínima obligatoria.
        # Usa fallback_subtotal para que LineExtensionAmount coincida con LegalMonetaryTotal (evita ZB01).
        amt = fmt_amount(fallback_subtotal)
        return f"""
    <cac:InvoiceLine>
      <cbc:ID>1</cbc:ID>
      <cbc:InvoicedQuantity unitCode="EA">1.000000</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="{currency}">{amt}</cbc:LineExtensionAmount>
      <cac:Item>
        <cbc:Description>Adquisición</cbc:Description>
        <cac:StandardItemIdentification>
          <cbc:ID schemeID="999">7890000000000</cbc:ID>
        </cac:StandardItemIdentification>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="{currency}">{amt}</cbc:PriceAmount>
      </cac:Price>
    </cac:InvoiceLine>"""

    xml_lines = ""
    for i, line in enumerate(lines, start=1):
        qty      = float(line.get("quantity", line.get("cantidad", 1)))
        price    = float(line.get("price", line.get("precio_unitario", 0)))
        subtotal = float(line.get("subtotal", qty * price))
        desc     = line.get("description", line.get("descripcion", "Adquisición"))
        unit     = line.get("unit", line.get("unidad", "EA"))
        xml_lines += f"""
    <cac:InvoiceLine>
      <cbc:ID>{i}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="{_esc(unit)}">{qty:.6f}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="{currency}">{fmt_amount(subtotal)}</cbc:LineExtensionAmount>
      <cac:Item>
        <cbc:Description>{_esc(desc)}</cbc:Description>
        <cac:StandardItemIdentification>
          <cbc:ID schemeID="999">7890000000000</cbc:ID>
        </cac:StandardItemIdentification>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="{currency}">{fmt_amount(price)}</cbc:PriceAmount>
      </cac:Price>
    </cac:InvoiceLine>"""
    return xml_lines

# ─── Operación: generate-ds ───────────────────────────────────────────────────

def generate_ds(payload: dict) -> None:
    cuds         = calcular_cuds(payload)
    doc_num      = payload.get("ds_number", "DS-000001")
    issue_date   = fmt_date(payload.get("issue_date"))
    currency     = payload.get("currency", "COP")
    customization= payload.get("customization_id", "DS-DS03")
    env          = payload.get("environment", "2")
    soft_id      = payload.get("software_id", "")
    soft_pin     = payload.get("software_pin", "")
    resolution   = payload.get("resolution_number", "")
    prefix       = payload.get("resolution_prefix", "DS")
    tech_key     = payload.get("technical_key", "")
    subtotal     = float(payload.get("subtotal", 0))
    iva_total    = float(payload.get("iva_total", 0))
    total        = float(payload.get("total", 0))
    notes        = payload.get("notes", "")
    issuer       = payload.get("issuer", {})
    non_obligated= payload.get("non_obligated", {})
    lines        = payload.get("lines", [])

    issue_time   = datetime.now().strftime("%H:%M:%S")
    doc_number   = doc_num.replace(prefix, "").lstrip("-0") or "1"
    num_prefix   = prefix
    soft_security_code = hashlib.sha384(
        f"{soft_id}{soft_pin}{doc_num}{issue_date}{issue_time}{issuer.get('nit','')}".encode()
    ).hexdigest()

    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Invoice {DS_NS}>
  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionContent>
        <sts:DianExtensions>
          <sts:InvoiceControl>
            <sts:InvoiceAuthorization>{_esc(resolution)}</sts:InvoiceAuthorization>
            <sts:AuthorizationPeriod>
              <sts:StartDate>{issue_date}</sts:StartDate>
              <sts:EndDate>2030-12-31</sts:EndDate>
            </sts:AuthorizationPeriod>
            <sts:AuthorizedInvoices>
              <sts:Prefix>{_esc(num_prefix)}</sts:Prefix>
              <sts:From>1</sts:From>
              <sts:To>99999999</sts:To>
            </sts:AuthorizedInvoices>
          </sts:InvoiceControl>
          <sts:InvoiceSource>
            <cbc:IdentificationCode listAgencyID="6" listAgencyName="United Nations Economic Commission for Europe" listSchemeURI="urn:oasis:names:specification:ubl:codelist:gc:CountryIdentificationCode-2.1">CO</cbc:IdentificationCode>
          </sts:InvoiceSource>
          <sts:SoftwareProvider>
            <sts:ProviderID schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)" schemeID="31">{_esc(issuer.get("nit",""))}</sts:ProviderID>
            <sts:SoftwareID schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">{_esc(soft_id)}</sts:SoftwareID>
          </sts:SoftwareProvider>
          <sts:SoftwareSecurityCode schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">{soft_security_code}</sts:SoftwareSecurityCode>
          <sts:AuthorizationProvider>
            <sts:AuthorizationProviderID schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)" schemeID="31">800197268</sts:AuthorizationProviderID>
          </sts:AuthorizationProvider>
          <sts:QRCode>https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey={cuds}</sts:QRCode>
        </sts:DianExtensions>
      </ext:ExtensionContent>
    </ext:UBLExtension>
  </ext:UBLExtensions>
  <cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>{_esc(customization)}</cbc:CustomizationID>
  <cbc:ProfileID>DIAN 2.1</cbc:ProfileID>
  <cbc:ProfileExecutionID>{env}</cbc:ProfileExecutionID>
  <cbc:ID>{_esc(doc_num)}</cbc:ID>
  <cbc:UUID schemeID="{env}" schemeName="CUDS-SHA3-256">{cuds}</cbc:UUID>
  <cbc:IssueDate>{issue_date}</cbc:IssueDate>
  <cbc:IssueTime>{issue_time}</cbc:IssueTime>
  <cbc:InvoiceTypeCode listAgencyID="195" listAgencyName="CO, DIAN" listSchemeURI="http://www.dian.gov.co/contratos/facturaelectronica/v1/InvoiceType">91</cbc:InvoiceTypeCode>
  <cbc:Note>{_esc(notes or "Documento soporte en adquisiciones efectuadas a no obligados a facturar")}</cbc:Note>
  <cbc:DocumentCurrencyCode>COP</cbc:DocumentCurrencyCode>
  <cbc:LineCountNumeric>{len(lines) or 1}</cbc:LineCountNumeric>
  {build_party(issuer, "AccountingSupplierParty")}
  {build_party(non_obligated, "AccountingCustomerParty")}
  {build_tax_totals(iva_total)}
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="{currency}">{fmt_amount(subtotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="{currency}">{fmt_amount(subtotal)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="{currency}">{fmt_amount(total)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="{currency}">0.00</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="{currency}">{fmt_amount(total)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  {build_lines(lines, currency, subtotal)}
</Invoice>"""

    import base64
    xml_b64 = base64.b64encode(xml.encode("utf-8")).decode()
    ok({"xml_base64": xml_b64, "cuds": cuds, "ds_number": doc_num})

# ─── Operación: generate-nota-ajuste ─────────────────────────────────────────

def generate_nota_ajuste(payload: dict) -> None:
    """
    Genera XML para Nota de Ajuste al DS.
    DocumentTypeCode: 92 (NC_DS) o 93 (ND_DS) — depende del campo document_type_code.
    La estructura XML es similar a una CreditNote/DebitNote UBL 2.1.
    """
    cuds_local      = calcular_cuds(payload)
    doc_type_code   = payload.get("document_type_code", "92")
    nota_num        = payload.get("nota_number", "NADS-000001")
    issue_date      = fmt_date(payload.get("issue_date"))
    currency        = payload.get("currency", "COP")
    description     = payload.get("description", "Nota ajuste Documento Soporte")
    ref_ds_number   = payload.get("ref_ds_number", "")
    ref_ds_cuds     = payload.get("ref_ds_cuds", "")
    ref_ds_date     = fmt_date(payload.get("ref_ds_date"))
    discrepancy_c   = payload.get("discrepancy_code", "1")
    discrepancy_d   = payload.get("discrepancy_description", "Devolución parcial")
    env             = payload.get("environment", "2")
    soft_id         = payload.get("software_id", "")
    issuer          = payload.get("issuer", {})
    non_obligated   = payload.get("non_obligated", {})
    lines           = payload.get("lines", [])
    subtotal        = float(payload.get("subtotal", 0))
    total_imp       = float(payload.get("total_impuestos", 0))
    total           = float(payload.get("total", 0))

    # Para una Nota de Ajuste usamos el esquema CreditNote UBL
    root_tag    = "CreditNote" if doc_type_code == "92" else "DebitNote"
    qty_tag     = "CreditedQuantity" if doc_type_code == "92" else "DebitedQuantity"
    line_tag    = "CreditNoteLine" if doc_type_code == "92" else "DebitNoteLine"
    amount_tag  = "CreditedQuantity" if doc_type_code == "92" else "DebitedQuantity"
    issue_time  = datetime.now().strftime("%H:%M:%S")

    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<{root_tag} {DS_NS.replace("Invoice-2", "CreditNote-2" if doc_type_code == "92" else "DebitNote-2")}>
  <cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>{_esc(payload.get("customization_id","DS-DS03"))}</cbc:CustomizationID>
  <cbc:ProfileID>DIAN 2.1</cbc:ProfileID>
  <cbc:ProfileExecutionID>{env}</cbc:ProfileExecutionID>
  <cbc:ID>{_esc(nota_num)}</cbc:ID>
  <cbc:UUID schemeID="{env}" schemeName="CUDS-SHA3-256">{cuds_local}</cbc:UUID>
  <cbc:IssueDate>{issue_date}</cbc:IssueDate>
  <cbc:IssueTime>{issue_time}</cbc:IssueTime>
  <cbc:Note>{_esc(description)}</cbc:Note>
  <cbc:DocumentCurrencyCode>COP</cbc:DocumentCurrencyCode>
  <cbc:LineCountNumeric>{len(lines) or 1}</cbc:LineCountNumeric>
  <cac:DiscrepancyResponse>
    <cbc:ReferenceID>{_esc(ref_ds_number)}</cbc:ReferenceID>
    <cbc:ResponseCode listAgencyID="195">{_esc(discrepancy_c)}</cbc:ResponseCode>
    <cbc:Description>{_esc(discrepancy_d)}</cbc:Description>
  </cac:DiscrepancyResponse>
  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>{_esc(ref_ds_number)}</cbc:ID>
      <cbc:UUID schemeName="CUDS-SHA3-256">{_esc(ref_ds_cuds)}</cbc:UUID>
      <cbc:IssueDate>{ref_ds_date}</cbc:IssueDate>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>
  {build_party(issuer, "AccountingSupplierParty")}
  {build_party(non_obligated, "AccountingCustomerParty")}
  {build_tax_totals(total_imp)}
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="{currency}">{fmt_amount(subtotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="{currency}">{fmt_amount(subtotal)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="{currency}">{fmt_amount(total)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="{currency}">0.00</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="{currency}">{fmt_amount(total)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  {build_lines(lines, currency, subtotal)}
</{root_tag}>"""

    import base64
    xml_b64 = base64.b64encode(xml.encode("utf-8")).decode()
    ok({"xml_base64": xml_b64, "cuds": cuds_local, "nota_number": nota_num})

# ─── Operación: generate-ds-pdf ───────────────────────────────────────────────

def generate_ds_pdf(payload: dict) -> None:
    """
    Genera PDF del Documento Soporte usando reportlab.
    Si reportlab no está disponible, devuelve un PDF mínimo embebido.
    """
    try:
        import io
        import base64
        from reportlab.lib.pagesizes import letter
        from reportlab.lib.units import cm
        from reportlab.lib.styles import getSampleStyleSheet
        from reportlab.lib import colors
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
        from reportlab.lib.styles import ParagraphStyle

        issuer       = payload.get("issuer", {})
        non_obligated= payload.get("non_obligated", {})
        ds_number    = payload.get("ds_number", "DS-000001")
        issue_date   = fmt_date(payload.get("issue_date"))
        subtotal     = float(payload.get("subtotal", 0))
        iva_total    = float(payload.get("iva_total", 0))
        total        = float(payload.get("total", 0))
        cuds         = payload.get("cuds", "")
        lines        = payload.get("lines", [])
        notes        = payload.get("notes", "")
        pdf_color    = payload.get("pdf_primary_color", "#1a56db")

        # Convertir color hex a RGB
        def hex_to_rgb(hex_str: str):
            h = hex_str.lstrip("#")
            return colors.Color(*[int(h[i:i+2], 16)/255 for i in (0, 2, 4)])

        primary = hex_to_rgb(pdf_color)
        buf     = io.BytesIO()
        doc     = SimpleDocTemplate(
            buf, pagesize=letter,
            rightMargin=2*cm, leftMargin=2*cm,
            topMargin=2*cm, bottomMargin=2*cm
        )
        styles = getSampleStyleSheet()
        story  = []

        title_style = ParagraphStyle("title", parent=styles["Heading1"],
                                     fontSize=11, textColor=primary, spaceAfter=4)
        sub_style   = ParagraphStyle("sub",   parent=styles["Normal"],
                                     fontSize=9, textColor=colors.grey)
        body_style  = ParagraphStyle("body",  parent=styles["Normal"],  fontSize=9)
        bold_style  = ParagraphStyle("bold",  parent=styles["Normal"],  fontSize=9, fontName="Helvetica-Bold")

        # Título exacto requerido por la DIAN
        story.append(Paragraph(
            "DOCUMENTO SOPORTE EN ADQUISICIONES EFECTUADAS A NO OBLIGADOS A FACTURAR",
            title_style
        ))
        story.append(Paragraph(f"Número: <b>{ds_number}</b>  |  Fecha: {issue_date}", sub_style))
        story.append(Spacer(1, 0.3*cm))

        # Datos emisor (nuestra empresa)
        story.append(Paragraph("EMISOR (OBLIGADO A FACTURAR)", bold_style))
        story.append(Paragraph(f"{issuer.get('name','')} — NIT: {issuer.get('nit','')}", body_style))
        story.append(Paragraph(issuer.get('address',''), body_style))
        story.append(Spacer(1, 0.2*cm))

        # Datos del no obligado
        story.append(Paragraph("ADQUIRIENTE (NO OBLIGADO A FACTURAR)", bold_style))
        story.append(Paragraph(f"{non_obligated.get('name','')} — Doc: {non_obligated.get('nit','')}", body_style))
        story.append(Paragraph(non_obligated.get('address',''), body_style))
        story.append(Spacer(1, 0.3*cm))

        # Tabla de líneas
        if lines:
            tdata = [["#", "Descripción", "Cant.", "Precio", "Subtotal"]]
            for i, ln in enumerate(lines, 1):
                tdata.append([
                    str(i),
                    ln.get("description", ln.get("descripcion", "")),
                    str(ln.get("quantity", ln.get("cantidad", 1))),
                    f"${float(ln.get('price', ln.get('precio_unitario', 0))):,.2f}",
                    f"${float(ln.get('subtotal', 0)):,.2f}",
                ])
            t = Table(tdata, colWidths=[1*cm, 9*cm, 2*cm, 3*cm, 3*cm])
            t.setStyle(TableStyle([
                ('BACKGROUND',   (0,0), (-1,0),  primary),
                ('TEXTCOLOR',    (0,0), (-1,0),  colors.white),
                ('FONTNAME',     (0,0), (-1,0),  'Helvetica-Bold'),
                ('FONTSIZE',     (0,0), (-1,-1), 8),
                ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, colors.Color(0.95,0.95,0.97)]),
                ('GRID',         (0,0), (-1,-1), 0.25, colors.lightgrey),
            ]))
            story.append(t)
            story.append(Spacer(1, 0.3*cm))

        # Totales
        tot_data = [
            ["Subtotal:", f"$ {subtotal:,.2f}"],
            ["IVA:",      f"$ {iva_total:,.2f}"],
            ["TOTAL:",    f"$ {total:,.2f}"],
        ]
        tt = Table(tot_data, colWidths=[14*cm, 4*cm])
        tt.setStyle(TableStyle([
            ('ALIGN',    (1,0), (1,-1), 'RIGHT'),
            ('FONTNAME', (0,2), (1,2),  'Helvetica-Bold'),
            ('FONTSIZE', (0,0), (-1,-1), 9),
        ]))
        story.append(tt)

        if cuds:
            story.append(Spacer(1, 0.3*cm))
            story.append(Paragraph(f"CUDS: {cuds}", ParagraphStyle("cuds", parent=sub_style, fontSize=7, wordWrap='LTR')))

        if notes:
            story.append(Spacer(1, 0.2*cm))
            story.append(Paragraph(f"Notas: {notes}", body_style))

        doc.build(story)
        pdf_b64 = base64.b64encode(buf.getvalue()).decode()
        ok({"pdf_base64": pdf_b64})

    except ImportError:
        # Fallback: PDF mínimo válido hardcoded
        import base64
        # Plantilla mínima PDF 1.4
        ds_num   = payload.get("ds_number", "DS-000001")
        date_str = fmt_date(payload.get("issue_date"))
        total_v  = float(payload.get("total", 0))
        text     = (
            f"Documento soporte en adquisiciones efectuadas a no obligados a facturar\n"
            f"Numero: {ds_num}  Fecha: {date_str}  Total: {total_v:,.2f}"
        )
        pdf_min = (
            b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
            b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
            b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]"
            b"/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n"
            + f"4 0 obj<</Length {len(text)+40}>>\nstream\nBT /F1 10 Tf 40 750 Td ({text}) Tj ET\nendstream\nendobj\n".encode()
            + b"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n"
            + b"xref\n0 6\n0000000000 65535 f\ntrailer<</Size 6/Root 1 0 R>>\n%%EOF"
        )
        ok({"pdf_base64": base64.b64encode(pdf_min).decode()})

# ─── Dispatcher ───────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        fail("Uso: ds_xml_builder_cli.py <operacion>")
        return

    op = sys.argv[1]
    try:
        payload = read_stdin()
    except Exception as exc:
        fail(f"Error leyendo stdin: {exc}")
        return

    try:
        if   op == "generate-ds":           generate_ds(payload)
        elif op == "generate-nota-ajuste":  generate_nota_ajuste(payload)
        elif op == "generate-ds-pdf":       generate_ds_pdf(payload)
        else:
            fail(f"Operación desconocida: {op}")
    except Exception as exc:
        fail(str(exc))

if __name__ == "__main__":
    main()
