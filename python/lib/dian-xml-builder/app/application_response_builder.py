"""
Builder UBL 2.1 ApplicationResponse — Eventos RADIAN DIAN Colombia
Eventos soportados:
  030 - Acuse de recibo de Factura Electronica de Venta
  031 - Reclamo de la Factura Electronica de Venta
  032 - Recibo del bien y/o prestacion del servicio
  033 - Aceptacion expresa
  034 - Aceptacion tacita (declaracion jurada — Receiver = DIAN)

Basado en la Caja de Herramientas RADIAN 1.1 (Anexo Tecnico - Resolucion 000085
de 2022), numerales 7.2 (estructura de eventos) y 12.1 (calculo del CUDE).
"""
from __future__ import annotations
import hashlib
from datetime import datetime
from typing import Any, Dict, Optional

import pytz

# ── Namespaces UBL 2.1 ────────────────────────────────────────────────────────
NS_AR  = "urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2"
NS_CAC = "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
NS_CBC = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
NS_EXT = "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"
NS_STS = "dian:gov:co:facturaelectronica:Structures-2-1"
NS_XSI = "http://www.w3.org/2001/XMLSchema-instance"

DIAN_AGENCY_ID   = "195"
DIAN_AGENCY_NAME = "CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)"

# NIT de la DIAN — receptor constante del evento 034 (Aceptación Tácita), que a
# diferencia de los demás eventos NO se dirige al proveedor sino a la propia DIAN.
DIAN_NIT  = "800197268"
DIAN_NAME = "Unidad Administrativa Especial Dirección de Impuestos y Aduanas Nacionales"

# Perfil exacto exigido por el Anexo Técnico (numeral 9.2, campo AAD03) — debe
# coincidir literalmente o la DIAN rechaza el documento.
PROFILE_ID = "DIAN 2.1: ApplicationResponse de la Factura Electrónica de Venta"

# DocumentTypeCode de la factura referenciada (01 = Factura Electrónica de Venta)
DOCUMENT_TYPE_CODE_FEV = "01"

RADIAN_EVENTS = {
    "030": "Acuse de recibo de Factura Electrónica de Venta",
    "031": "Reclamo de la Factura Electrónica de Venta",
    "032": "Recibo del bien y/o prestación del servicio",
    "033": "Aceptación expresa",
    "034": "Aceptación Tácita",
}

RADIAN_PREREQUISITES: dict[str, list[str]] = {
    "030": [],
    "031": ["030"],
    "032": ["030"],
    "033": ["030", "032"],
    "034": ["030", "032"],
}

RADIAN_EXCLUSIONS: dict[str, list[str]] = {
    "033": ["031", "034"],
    "031": ["033", "034"],
    "034": ["031", "033"],
}

# Códigos del listado DIAN "FaltadeAceptacion.gc" — usados como @listID del
# ResponseCode del evento 031 (Reclamo).
MOTIVO_RECLAMO_CATEGORIAS = {
    "01": "Falta de aceptación parcial",
    "02": "Falta de aceptación total",
}

# Nota jurada obligatoria del evento 034 (numeral 7.2.1.4 del Anexo Técnico) —
# se usa la variante "sin mandatario" salvo que se indique lo contrario.
NOTA_TACITA_SIN_MANDATARIO = (
    'Manifiesto bajo la gravedad de juramento que transcurridos 3 días hábiles '
    'siguientes a la fecha de recepción de la mercancía o del servicio en la '
    'referida factura de este evento, el adquirente {razon_social} identificado '
    'con NIT {nit} no manifestó expresamente la aceptación o rechazo de la '
    'referida factura, ni reclamó en contra de su contenido.'
)


def validate_event_prerequisites(
    event_code: str,
    sent_events: list[str],
) -> tuple[bool, str]:
    """
    Verifica que se cumplan los prerequisitos RADIAN.
    Retorna (ok, mensaje_de_error).
    """
    prereqs = RADIAN_PREREQUISITES.get(event_code, [])
    for req in prereqs:
        if req not in sent_events:
            return False, (
                f"Para enviar el evento {event_code} primero debe enviarse "
                f"el evento {req} ({RADIAN_EVENTS.get(req, req)})"
            )
    exclusions = RADIAN_EXCLUSIONS.get(event_code, [])
    for excl in exclusions:
        if excl in sent_events:
            return False, (
                f"No se puede enviar {event_code} porque ya se envio "
                f"el evento excluyente {excl} ({RADIAN_EVENTS.get(excl, excl)})"
            )
    return True, ""


def _calculate_dv(nit: str) -> str:
    """Calcula dígito de verificación NIT Colombia (idéntico a builder.py, la
    versión ya probada en producción para facturas)."""
    pesos = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71]
    digits = [int(d) for d in str(nit).replace(".", "").replace(",", "")[-15:]][::-1]
    total = sum(d * p for d, p in zip(digits, pesos[: len(digits)]))
    mod = total % 11
    return str(11 - mod) if mod > 1 else str(mod)


def _compute_cude(
    num_de: str,
    fec_emi: str,
    hor_emi: str,
    nit_fe: str,
    doc_adq: str,
    response_code: str,
    ref_id: str,
    document_type_code: str,
    software_pin: str,
) -> str:
    """
    CUDE-SHA384 del ApplicationResponse (numeral 12.1.1 del Anexo Técnico RADIAN).
    Concatenación: Num_DE + Fec_Emi + Hor_Emi + NitFE + DocAdq + ResponseCode
                   + ID + DocumentTypeCode + Software-PIN
    """
    cude_str = (
        f"{num_de}{fec_emi}{hor_emi}{nit_fe}{doc_adq}"
        f"{response_code}{ref_id}{document_type_code}{software_pin}"
    )
    return hashlib.sha384(cude_str.encode("utf-8")).hexdigest()


def build_application_response_xml(
    event_code: str,
    invoice_id: str,
    invoice_cufe: str,
    # Adquiriente (nosotros — quien envia el evento)
    sender_nit: str,
    sender_name: str,
    sender_tax_scheme_id: str = "01",
    sender_tax_scheme_name: str = "IVA",
    # Proveedor (quien emitio la factura — receiver del evento, salvo evento 034)
    receiver_nit: str = "",
    receiver_name: str = "",
    receiver_tax_scheme_id: str = "01",
    receiver_tax_scheme_name: str = "IVA",
    # Numeración y credenciales requeridas para el CUDE y el SoftwareSecurityCode
    evento_numero: str = "1",
    software_pin: str = "",
    software_id: str = "",
    # Opcionales
    note: str = "",
    environment: str = "test",
    # Evento 031 (Reclamo) — motivo obligatorio
    motivo_categoria: str = "",       # '01' parcial | '02' total
    motivo_descripcion: str = "",
    # Evento 032 (Recibo del bien) — persona que recibió, opcional
    persona_receptora: Optional[Dict[str, str]] = None,
) -> tuple[str, dict]:
    """
    Construye el XML ApplicationResponse UBL 2.1 para un evento RADIAN.

    Retorna (xml_string, metadata).
    metadata incluye: event_id, event_code, event_description, issue_datetime, cude
    """
    if event_code not in RADIAN_EVENTS:
        raise ValueError(
            f"Codigo de evento invalido: {event_code}. "
            f"Use uno de: {list(RADIAN_EVENTS.keys())}"
        )

    bog = pytz.timezone("America/Bogota")
    now = datetime.now(bog)
    issue_date = now.strftime("%Y-%m-%d")
    issue_time = now.strftime("%H:%M:%S-05:00")
    event_id   = str(evento_numero)

    event_desc = RADIAN_EVENTS[event_code]
    env_code   = "1" if str(environment) in ("1", "production", "prod") else "2"

    # El evento 034 (Aceptación Tácita) se dirige a la propia DIAN, no al proveedor.
    is_tacita = event_code == "034"
    final_receiver_nit  = DIAN_NIT  if is_tacita else receiver_nit
    final_receiver_name = DIAN_NAME if is_tacita else receiver_name

    # CUDE propio del evento (numeral 12.1.1)
    cude = _compute_cude(
        num_de=event_id,
        fec_emi=issue_date,
        hor_emi=issue_time,
        nit_fe=sender_nit,
        doc_adq=final_receiver_nit,
        response_code=event_code,
        ref_id=invoice_id,
        document_type_code=DOCUMENT_TYPE_CODE_FEV,
        software_pin=software_pin,
    )

    notes: list[str] = []
    if note:
        notes.append(note)
    if is_tacita:
        notes.append(
            NOTA_TACITA_SIN_MANDATARIO.format(razon_social=sender_name, nit=sender_nit)
        )

    lines: list[str] = []
    lines.append('<?xml version="1.0" encoding="UTF-8" standalone="no"?>')
    lines.append(
        f'<ApplicationResponse'
        f' xmlns="{NS_AR}"'
        f' xmlns:cac="{NS_CAC}"'
        f' xmlns:cbc="{NS_CBC}"'
        f' xmlns:ext="{NS_EXT}"'
        f' xmlns:sts="{NS_STS}"'
        f' xmlns:xsi="{NS_XSI}">'
    )

    # ── Extensiones requeridas por DIAN ──────────────────────────────────────
    # Igual que en Factura/NC/ND: van DOS ext:UBLExtension. La primera lleva el
    # bloque sts:DianExtensions (proveedor de software, código de seguridad del
    # software, QR) — sin esto la DIAN rechaza el evento reportando que falta
    # el NIT del "prestador del servicio" (se refiere al proveedor del software,
    # no al proveedor/emisor de la factura). La segunda queda vacía como
    # placeholder para que el firmador (python-signer) inserte ahí la firma
    # XAdES, tal como ya hace para facturas/NC/ND (ver signer.py: con ≥2
    # UBLExtension la firma va en la segunda).
    agency = "CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)"
    ssc = hashlib.sha384(f"{software_id}{software_pin}{event_id}".encode("utf-8")).hexdigest()
    qr_host = "https://catalogo-vpfe.dian.gov.co" if env_code == "1" else "https://catalogo-vpfe-hab.dian.gov.co"
    sender_dv   = _calculate_dv(sender_nit)
    receiver_dv = _calculate_dv(final_receiver_nit) if final_receiver_nit else "0"

    lines.append("  <ext:UBLExtensions>")
    lines.append("    <ext:UBLExtension>")
    lines.append("      <ext:ExtensionContent>")
    lines.append(f'        <sts:DianExtensions xmlns:sts="{NS_STS}" xmlns:cbc="{NS_CBC}">')
    lines.append('          <sts:InvoiceSource>')
    lines.append('            <cbc:IdentificationCode listAgencyID="6" listAgencyName="United Nations Economic Commission for Europe" listSchemeURI="urn:oasis:names:specification:ubl:codelist:gc:CountryIdentificationCode-2.1">CO</cbc:IdentificationCode>')
    lines.append('          </sts:InvoiceSource>')
    lines.append('          <sts:SoftwareProvider>')
    lines.append(f'            <sts:ProviderID schemeAgencyID="195" schemeAgencyName="{agency}" schemeID="{sender_dv}" schemeName="31">{sender_nit}</sts:ProviderID>')
    lines.append(f'            <sts:SoftwareID schemeAgencyID="195" schemeAgencyName="{agency}">{software_id}</sts:SoftwareID>')
    lines.append('          </sts:SoftwareProvider>')
    lines.append(f'          <sts:SoftwareSecurityCode schemeAgencyID="195" schemeAgencyName="{agency}">{ssc}</sts:SoftwareSecurityCode>')
    lines.append('          <sts:AuthorizationProvider>')
    lines.append(f'            <sts:AuthorizationProviderID schemeAgencyID="195" schemeAgencyName="{agency}" schemeID="4" schemeName="31">{DIAN_NIT}</sts:AuthorizationProviderID>')
    lines.append('          </sts:AuthorizationProvider>')
    # OJO: el Anexo Técnico RADIAN (regla AAB36, numeral 9.2.3.2) es explícito:
    # "...documentkey=CUFE" donde la palabra CUFE debe ser reemplazada por el
    # CUFE del DOCUMENTO ELECTRÓNICO REFERENCIADO (la factura), NO por el CUDE
    # propio del evento. Durante varias rondas de pruebas esto llevaba aquí el
    # `cude` del evento — un hash distinto — por lo que la DIAN no podía resolver
    # la URL contra la factura referenciada y reportaba AAB36 ("No se incluyó la
    # información de la URL del CódigoQR") como si no existiera, a pesar de que
    # el elemento sts:QRCode sí estaba presente con una URL válida en la forma.
    # Esto también es la sospecha más plausible para AAD09e/DC24a persistentes:
    # si la DIAN no logra resolver el documento referenciado por esta URL,
    # cualquier validación que dependa de comparar contra los datos de la
    # factura original (fechas, etc.) puede fallar de forma inconsistente.
    lines.append(f'          <sts:QRCode>{qr_host}/document/searchqr?documentkey={invoice_cufe}</sts:QRCode>')
    lines.append('        </sts:DianExtensions>')
    lines.append("      </ext:ExtensionContent>")
    lines.append("    </ext:UBLExtension>")
    lines.append("    <ext:UBLExtension>")
    lines.append("      <ext:ExtensionContent/>")
    lines.append("    </ext:UBLExtension>")
    lines.append("  </ext:UBLExtensions>")

    lines.append("  <cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>")
    lines.append("  <cbc:CustomizationID>1</cbc:CustomizationID>")
    lines.append(f"  <cbc:ProfileID>{PROFILE_ID}</cbc:ProfileID>")
    lines.append(f"  <cbc:ProfileExecutionID>{env_code}</cbc:ProfileExecutionID>")
    lines.append(f"  <cbc:ID>{event_id}</cbc:ID>")
    lines.append(
        f'  <cbc:UUID schemeID="{env_code}" schemeName="CUDE-SHA384">{cude}</cbc:UUID>'
    )
    lines.append(f"  <cbc:IssueDate>{issue_date}</cbc:IssueDate>")
    lines.append(f"  <cbc:IssueTime>{issue_time}</cbc:IssueTime>")

    for n in notes:
        lines.append(f"  <cbc:Note>{n}</cbc:Note>")

    # ── SenderParty (adquiriente = nosotros) ────────────────────────────────
    lines.append("  <cac:SenderParty>")
    lines.append("    <cac:PartyTaxScheme>")
    lines.append(f"      <cbc:RegistrationName>{sender_name}</cbc:RegistrationName>")
    lines.append(
        f'      <cbc:CompanyID schemeAgencyID="{DIAN_AGENCY_ID}"'
        f' schemeAgencyName="{DIAN_AGENCY_NAME}"'
        f' schemeID="{sender_dv}" schemeName="31" schemeVersionID="1">{sender_nit}</cbc:CompanyID>'
    )
    lines.append("      <cac:TaxScheme>")
    lines.append(f"        <cbc:ID>{sender_tax_scheme_id}</cbc:ID>")
    lines.append(f"        <cbc:Name>{sender_tax_scheme_name}</cbc:Name>")
    lines.append("      </cac:TaxScheme>")
    lines.append("    </cac:PartyTaxScheme>")
    lines.append("  </cac:SenderParty>")

    # ── ReceiverParty (proveedor que emitio la factura — o la DIAN si es 034) ──
    lines.append("  <cac:ReceiverParty>")
    lines.append("    <cac:PartyTaxScheme>")
    lines.append(f"      <cbc:RegistrationName>{final_receiver_name}</cbc:RegistrationName>")
    lines.append(
        f'      <cbc:CompanyID schemeAgencyID="{DIAN_AGENCY_ID}"'
        f' schemeAgencyName="{DIAN_AGENCY_NAME}"'
        f' schemeID="{receiver_dv}" schemeName="31" schemeVersionID="1">{final_receiver_nit}</cbc:CompanyID>'
    )
    lines.append("      <cac:TaxScheme>")
    lines.append(f"        <cbc:ID>{receiver_tax_scheme_id}</cbc:ID>")
    lines.append(f"        <cbc:Name>{receiver_tax_scheme_name}</cbc:Name>")
    lines.append("      </cac:TaxScheme>")
    lines.append("    </cac:PartyTaxScheme>")
    lines.append("  </cac:ReceiverParty>")

    # ── DocumentResponse ─────────────────────────────────────────────────────
    lines.append("  <cac:DocumentResponse>")
    lines.append("    <cac:Response>")
    if event_code == "031" and motivo_categoria:
        # Reclamo: ResponseCode lleva @listID (categoría FaltadeAceptacion.gc)
        # y @name (descripción específica del motivo).
        cat = str(motivo_categoria).zfill(2)
        nombre_attr = motivo_descripcion or MOTIVO_RECLAMO_CATEGORIAS.get(cat, "")
        lines.append(
            f'      <cbc:ResponseCode name="{nombre_attr}" listID="{cat}">{event_code}</cbc:ResponseCode>'
        )
    else:
        lines.append(f"      <cbc:ResponseCode>{event_code}</cbc:ResponseCode>")
    lines.append(f"      <cbc:Description>{event_desc}</cbc:Description>")
    lines.append("    </cac:Response>")
    lines.append("    <cac:DocumentReference>")
    lines.append(f"      <cbc:ID>{invoice_id}</cbc:ID>")
    lines.append(
        f'      <cbc:UUID schemeName="CUFE-SHA384">{invoice_cufe}</cbc:UUID>'
    )
    lines.append(f"      <cbc:DocumentTypeCode>{DOCUMENT_TYPE_CODE_FEV}</cbc:DocumentTypeCode>")
    lines.append("    </cac:DocumentReference>")

    # ── IssuerParty/Person (persona natural que registra el evento) ──────────
    # OBLIGATORIO para TODOS los eventos RADIAN (estructura común, numeral 9.2.3),
    # no solo para el 032 como se asumió originalmente — confirmado en pruebas
    # reales: el evento 030 fue rechazado por la DIAN con exactamente estas
    # reglas al no incluir este grupo:
    #   AAH12 "No se informó el grupo", AAH13 "No fue informado un documento de
    #   identidad", AAH15 "No fue informado los nombres", AAH16 "No fue
    #   informado los apellidos" (las 4 son de RECHAZO — bloquean el envío).
    # AAH17 (cargo) y AAH18 (área/departamento) son solo de NOTIFICACIÓN, no
    # bloquean, por lo que esos dos campos quedan opcionales.
    if not (persona_receptora and (persona_receptora.get("cedula") or persona_receptora.get("nombre"))):
        raise ValueError(
            f"El evento {event_code} ({event_desc}) requiere informar la persona "
            "que registra el evento (cédula, nombres y apellidos) — este dato es "
            "obligatorio para la DIAN."
        )

    if persona_receptora:
        pid      = persona_receptora.get("cedula", "")
        pid_type = persona_receptora.get("tipo_id", "13")
        nombre   = persona_receptora.get("nombre", "")
        apellido = persona_receptora.get("apellido", "")
        cargo    = persona_receptora.get("cargo", "")
        depto    = persona_receptora.get("departamento", "")
        if pid or nombre:
            lines.append("    <cac:IssuerParty>")
            lines.append("      <cac:Person>")
            if pid:
                lines.append(f'        <cbc:ID schemeID="4" schemeName="{pid_type}">{pid}</cbc:ID>')
            if nombre:
                lines.append(f"        <cbc:FirstName>{nombre}</cbc:FirstName>")
            if apellido:
                lines.append(f"        <cbc:FamilyName>{apellido}</cbc:FamilyName>")
            if cargo:
                lines.append(f"        <cbc:JobTitle>{cargo}</cbc:JobTitle>")
            if depto:
                lines.append(f"        <cbc:OrganizationDepartment>{depto}</cbc:OrganizationDepartment>")
            lines.append("      </cac:Person>")
            lines.append("    </cac:IssuerParty>")

    lines.append("  </cac:DocumentResponse>")

    lines.append("</ApplicationResponse>")

    xml_string = "\n".join(lines)
    metadata = {
        "event_id":          event_id,
        "event_code":        event_code,
        "event_description": event_desc,
        "issue_date":        issue_date,
        "issue_time":        issue_time,
        "issue_datetime":    f"{issue_date}T{issue_time}",
        "invoice_id":        invoice_id,
        "invoice_cufe":      invoice_cufe,
        "cude":              cude,
    }
    return xml_string, metadata
