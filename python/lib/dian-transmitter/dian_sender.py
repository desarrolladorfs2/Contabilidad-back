"""
DianTransmitter - Envío 1:1 a la DIAN replicando la lógica del módulo Odoo
(l10n_co_electronic_invoice_self).

Diseñado para integrarse directamente en el flujo de Akribeia CRM:
- Recibe el ZIP ya firmado (base64) + nombre del archivo.
- Construye el sobre SOAP + firma del header exactamente como Odoo.
- Soporta PFX (recomendado, igual que el resto del sistema) o PEMs.
- Retorna respuesta estructurada + raw.

Uso típico después de generar el ZIP firmado:
    from dian_sender import DianTransmitter

    tx = DianTransmitter(
        environment="test",
        pfx_path=r"C:\\...\\certificado_akribeia.pfx",
        password="Neurum2020*",
    )
    result = tx.send_bill_sync(zip_base64, "SETP990000123.zip")
    print(result["status_code"], result["status_description"])
"""

from __future__ import annotations

import base64
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import requests
from lxml import etree

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.serialization import load_pem_private_key, pkcs12
from cryptography.x509 import load_pem_x509_certificate

try:
    import xmlsig
    from xmlsig.constants import TransformExclC14N, TransformRsaSha256, TransformSha256
    XMLSIG_AVAILABLE = True
except ImportError:
    XMLSIG_AVAILABLE = False


# ============================================================
# CONSTANTES (1:1 con Odoo / DIAN)
# ============================================================

DIAN_URLS = {
    "production": "https://vpfe.dian.gov.co/WcfDianCustomerServices.svc",
    "test": "https://vpfe-hab.dian.gov.co/WcfDianCustomerServices.svc",
}

DIAN_ACTION_BASE = "http://wcf.dian.colombia/IWcfDianCustomerServices/"

NSD = {
    "soap": "http://www.w3.org/2003/05/soap-envelope",
    "wcf": "http://wcf.dian.colombia",
    "wsse": "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd",
    "wsu": "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd",
    "wsa": "http://www.w3.org/2005/08/addressing",
    "ds": "http://www.w3.org/2000/09/xmldsig#",
}


def load_cert_and_key(
    *,
    pfx_path: str | Path | None = None,
    password: str | bytes | None = None,
    cert_pem_path: str | Path | None = None,
    key_pem_path: str | Path | None = None,
    pfx_bytes: bytes | None = None,
) -> tuple[Any, Any]:
    """
    Carga (certificado, private_key) desde PFX o PEMs.
    Prioridad: pfx_bytes > pfx_path > pem paths.
    """
    if not XMLSIG_AVAILABLE:
        raise RuntimeError(
            "Faltan dependencias. Instala: pip install xmlsig cryptography lxml requests"
        )

    if pfx_bytes is not None:
        pfx_data = pfx_bytes
        pwd = password.encode() if isinstance(password, str) else password
        private_key, cert, _ = pkcs12.load_key_and_certificates(pfx_data, pwd)
        if cert is None or private_key is None:
            raise ValueError("No se pudo extraer cert/key del PFX (bytes)")
        return cert, private_key

    if pfx_path:
        pfx_data = Path(pfx_path).read_bytes()
        pwd = password.encode() if isinstance(password, str) else password
        private_key, cert, _ = pkcs12.load_key_and_certificates(pfx_data, pwd)
        if cert is None or private_key is None:
            raise ValueError(f"No se pudo extraer cert/key del PFX: {pfx_path}")
        return cert, private_key

    if cert_pem_path and key_pem_path:
        cert = load_pem_x509_certificate(Path(cert_pem_path).read_bytes())
        private_key = load_pem_private_key(
            Path(key_pem_path).read_bytes(), password=None
        )
        return cert, private_key

    raise ValueError("Debes proporcionar pfx_path+password o cert_pem_path+key_pem_path")


class DianTransmitter:
    """
    Réplica fiel del envío a DIAN que hace el módulo de Odoo.
    Enfocado en SendBillSync (y GetStatus / GetStatusZip).
    """

    def __init__(
        self,
        *,
        environment: str = "test",
        timeout: int = 120,
        # Opción recomendada (igual que python-signer y server.js)
        pfx_path: str | Path | None = None,
        password: str | None = None,
        # Alternativa PEM (la que usabas en el Sim_Odoo)
        cert_pem_path: str | Path | None = None,
        key_pem_path: str | Path | None = None,
        # Para cuando recibes el buffer desde Node
        pfx_bytes: bytes | None = None,
    ):
        if not XMLSIG_AVAILABLE:
            raise RuntimeError(
                "Faltan dependencias xmlsig/cryptography. "
                "Ejecuta en la carpeta del transmitter: pip install -r requirements.txt"
            )

        self.environment = environment
        self.url = DIAN_URLS[environment]
        self.timeout = timeout

        self.cert, self.private_key = load_cert_and_key(
            pfx_path=pfx_path,
            password=password,
            cert_pem_path=cert_pem_path,
            key_pem_path=key_pem_path,
            pfx_bytes=pfx_bytes,
        )

        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "AkribeiaCRM-DianTransmitter/1.0 (replica Odoo)",
        })

    # ============================================================
    # Construcción del envelope SOAP (réplica Odoo)
    # ============================================================

    def _get_security_timestamp(self) -> tuple[str, str]:
        now = datetime.now(timezone.utc)
        created = now.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        expires = (now + timedelta(minutes=5)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        return created, expires

    def _build_soap_envelope(self, action: str, body_content: str) -> str:
        created, expires = self._get_security_timestamp()
        timestamp_id = f"TS-{uuid.uuid4()}"
        to_id = f"id-{uuid.uuid4()}"

        envelope = f"""<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
               xmlns:wcf="http://wcf.dian.colombia"
               xmlns:wsa="http://www.w3.org/2005/08/addressing"
               xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
               xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
    <soap:Header>
        <wsse:Security soap:mustUnderstand="1">
            <wsu:Timestamp wsu:Id="{timestamp_id}">
                <wsu:Created>{created}</wsu:Created>
                <wsu:Expires>{expires}</wsu:Expires>
            </wsu:Timestamp>
            <wsse:BinarySecurityToken
                EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary"
                ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3"/>
        </wsse:Security>
        <wsa:Action>{action}</wsa:Action>
        <wsa:To wsu:Id="{to_id}">{self.url}</wsa:To>
    </soap:Header>
    <soap:Body>
        {body_content}
    </soap:Body>
</soap:Envelope>"""
        return envelope

    # ============================================================
    # Firma del envelope (copia casi literal del XMLSigner._envelope_sign de Odoo)
    # ============================================================

    def _prepare_xml_for_signing(self, xml_content: str) -> etree._Element:
        root = etree.fromstring(xml_content.encode("utf-8"))
        for e in root.iter():
            if e.text and e.text.strip():
                e.text = e.text.strip()
            elif e.text:
                e.text = None
            e.tail = None
        return root

    def _envelope_sign(self, soap_envelope: str) -> str:
        root = self._prepare_xml_for_signing(soap_envelope)

        sign_id = f"SIG-{uuid.uuid4()}"
        sign = xmlsig.template.create(
            c14n_method=TransformExclC14N,
            sign_method=TransformRsaSha256,
            ns="ds",
            name=sign_id,
        )

        header = root.find("soap:Header", namespaces=NSD)
        security = header.find("wsse:Security", namespaces=NSD)
        security.append(sign)

        to_id = header.find("wsa:To", namespaces=NSD).attrib.get(
            "{http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd}Id"
        )
        ref = xmlsig.template.add_reference(
            node=sign,
            digest_method=TransformSha256,
            uri=f"#{to_id}",
        )
        xmlsig.template.add_transform(ref, TransformExclC14N)

        key_info = xmlsig.template.ensure_key_info(sign)
        key_info.set("Id", f"KI-{uuid.uuid4()}")

        ctx = xmlsig.SignatureContext()
        ctx.x509 = self.cert
        ctx.public_key = self.cert.public_key()
        ctx.private_key = self.private_key

        # BinarySecurityToken (exacto como Odoo)
        binary_security_token = security.find("wsse:BinarySecurityToken", namespaces=NSD)
        binary_security_token_id = f"X509-{uuid.uuid4()}"
        binary_security_token.set(
            "{http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd}Id",
            binary_security_token_id,
        )
        binary_security_token.text = base64.b64encode(
            ctx.x509.public_bytes(encoding=serialization.Encoding.DER)
        ).decode("ascii")

        # SecurityTokenReference
        security_token_reference = etree.SubElement(
            key_info,
            etree.QName(NSD["wsse"], "SecurityTokenReference"),
            nsmap={"wsse": NSD["wsse"]},
        )
        security_token_reference.set(
            "{http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd}Id",
            f"STR-{uuid.uuid4()}",
        )

        key_info_reference = etree.SubElement(
            security_token_reference,
            etree.QName(NSD["wsse"], "Reference"),
            nsmap={"wsse": NSD["wsse"]},
        )
        key_info_reference.set("URI", f"#{binary_security_token_id}")
        key_info_reference.set(
            "ValueType",
            "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3",
        )

        ctx.sign(sign)
        ctx.verify(sign)

        return etree.tostring(
            root, xml_declaration=True, encoding="UTF-8", standalone=True
        ).decode("utf-8")

    # ============================================================
    # Envío HTTP bajo
    # ============================================================

    def _send_to_dian(self, soap_data: str, action: str) -> bytes:
        headers = {
            "Content-Type": "application/soap+xml; charset=utf-8",
            "SOAPAction": action,
        }
        resp = self.session.post(
            self.url,
            data=soap_data.encode("utf-8"),
            headers=headers,
            timeout=self.timeout,
        )
        return resp.content

    # ============================================================
    # Parseo de respuesta DIAN (robusto)
    # ============================================================

    def _parse_dian_response(self, raw_xml: str, expected_response_tag: str) -> dict[str, Any]:
        """
        Extrae los campos comunes de las respuestas DIAN:
        StatusCode, StatusDescription, StatusMessage, XmlDocumentKey / ZipKey, ErrorMessageList, etc.
        """
        result: dict[str, Any] = {
            "raw_response": raw_xml,
            "success": False,
            "status_code": None,
            "status_description": None,
            "status_message": None,
            "xml_document_key": None,
            "zip_key": None,
            "errors": [],
        }

        try:
            root = etree.fromstring(raw_xml.encode("utf-8"))

            # Buscamos el Body
            body = root.find(".//{http://www.w3.org/2003/05/soap-envelope}Body")
            if body is None:
                body = root.find(".//soap:Body", namespaces=NSD)

            if body is None:
                result["error"] = "No se encontró Body en la respuesta SOAP"
                return result

            # Intentamos encontrar el Response (SendBillSyncResponse, GetStatusResponse, SendTestSetAsyncResponse, GetStatusZipResponse...)
            response_node = None
            for tag in [expected_response_tag, "SendBillSyncResponse", "GetStatusResponse", "GetStatusZipResponse", "SendTestSetAsyncResponse"]:
                response_node = body.find(f".//wcf:{tag}", namespaces=NSD)
                if response_node is not None:
                    break
                # fallback sin prefijo
                for el in body.iter():
                    if tag in (el.tag or ""):
                        response_node = el
                        break
                if response_node is not None:
                    break

            if response_node is None:
                # fallback: tomar primer hijo del body que tenga "Response"
                for child in body:
                    if "Response" in (child.tag or ""):
                        response_node = child
                        break

            if response_node is None:
                result["error"] = "No se encontró nodo de respuesta DIAN conocido"
                return result

            # El Result suele estar un nivel abajo (SendBillSyncResponseResult, etc.)
            inner = None
            for c in response_node:
                if "Result" in (c.tag or "") or c.tag.endswith("Result"):
                    inner = c
                    break
            if inner is None:
                inner = response_node

            # Extraer campos con y sin namespace b:
            def find_text(node, local_names):
                for ln in local_names:
                    # con prefijo b:
                    el = node.find(f"{{http://schemas.datacontract.org/2004/07/ExchangeEmailResponse}}{ln}")
                    if el is not None and el.text:
                        return el.text.strip()
                    # sin namespace o con wcf
                    el = node.find(f".//wcf:{ln}", namespaces=NSD)
                    if el is not None and el.text:
                        return el.text.strip()
                    # any
                    for e in node.iter():
                        if e.tag and e.tag.endswith(ln) and e.text:
                            return e.text.strip()
                return None

            result["status_code"] = find_text(inner, ["StatusCode", "b:StatusCode"])
            result["status_description"] = find_text(inner, ["StatusDescription", "b:StatusDescription"])
            result["status_message"] = find_text(inner, ["StatusMessage", "b:StatusMessage"])
            result["xml_document_key"] = find_text(inner, ["XmlDocumentKey", "b:XmlDocumentKey"])
            result["zip_key"] = find_text(inner, ["ZipKey", "b:ZipKey"])
            # ApplicationResponse XML base64 (presente en GetStatus cuando status_code == "00")
            result["xml_base64_bytes"] = find_text(inner, ["XmlBase64Bytes", "b:XmlBase64Bytes"])

            # Errores: soporta tres estructuras DIAN:
            #   1. <b:StatusMessage>texto directo</b:StatusMessage>
            #   2. <b:ErrorMessageList><b:ErrorMessage><c:string>…</c:string></b:ErrorMessage></b:ErrorMessageList>
            #   3. <b:ErrorMessage><c:string>…</c:string></b:ErrorMessage>  (sin wrapper List)
            errors = []
            for e in inner.iter():
                tag = e.tag or ""
                # Caso 1: elemento "Error*" con texto directo
                if "Error" in tag and e.text and e.text.strip():
                    errors.append(e.text.strip())
                # Casos 2 y 3: ErrorMessageList o ErrorMessage que contiene c:string
                if "ErrorMessageList" in tag or "ErrorMessage" in tag:
                    for sub in e.iter():
                        stag = sub.tag or ""
                        # c:string → {http://schemas.microsoft.com/2003/10/Serialization/Arrays}string
                        if (stag.endswith("}string") or stag == "string") and sub.text and sub.text.strip():
                            errors.append(sub.text.strip())
            # Deduplicar manteniendo orden
            seen: set = set()
            deduped = []
            for err in errors:
                if err not in seen:
                    seen.add(err)
                    deduped.append(err)
            result["errors"] = deduped

            result["success"] = result["status_code"] == "00" or bool(result["xml_document_key"] or result["zip_key"])

        except Exception as ex:
            result["error"] = f"Error parseando respuesta: {ex}"

        return result

    # ============================================================
    # Métodos públicos de envío / consulta
    # ============================================================

    def send_bill_sync(self, zip_base64: str, filename: str) -> dict[str, Any]:
        """
        Envío síncrono (SendBillSync). El más usado para facturas ya en habilitación.
        """
        action = DIAN_ACTION_BASE + "SendBillSync"

        body = f"""<wcf:SendBillSync>
    <wcf:fileName>{filename}</wcf:fileName>
    <wcf:contentFile>{zip_base64}</wcf:contentFile>
</wcf:SendBillSync>"""

        envelope = self._build_soap_envelope(action, body)
        signed_envelope = self._envelope_sign(envelope)

        raw = self._send_to_dian(signed_envelope, action)
        raw_str = raw.decode("utf-8", errors="replace")

        parsed = self._parse_dian_response(raw_str, "SendBillSyncResponse")

        return {
            "success": parsed.get("success", False),
            "status_code": parsed.get("status_code"),
            "status_description": parsed.get("status_description"),
            "status_message": parsed.get("status_message"),
            "xml_document_key": parsed.get("xml_document_key"),
            "errors": parsed.get("errors", []),
            "raw_request": signed_envelope,
            "raw_response": raw_str,
            "http_status": 200,  # si llegó aquí
        }

    def get_status(self, track_id: str) -> dict[str, Any]:
        """
        Consulta estado por CUFE o TrackId (GetStatus).
        Útil después de un envío asíncrono o para re-chequear.
        """
        action = DIAN_ACTION_BASE + "GetStatus"

        body = f"""<wcf:GetStatus>
    <wcf:trackId>{track_id}</wcf:trackId>
</wcf:GetStatus>"""

        envelope = self._build_soap_envelope(action, body)
        signed_envelope = self._envelope_sign(envelope)

        raw = self._send_to_dian(signed_envelope, action)
        raw_str = raw.decode("utf-8", errors="replace")

        parsed = self._parse_dian_response(raw_str, "GetStatusResponse")

        return {
            "success": parsed.get("success", False),
            "status_code": parsed.get("status_code"),
            "status_description": parsed.get("status_description"),
            "status_message": parsed.get("status_message"),
            "xml_document_key": parsed.get("xml_document_key"),
            "xml_base64_bytes": parsed.get("xml_base64_bytes"),
            "errors": parsed.get("errors", []),
            "raw_response": raw_str,
        }

    def get_status_zip(self, zip_key: str) -> dict[str, Any]:
        """
        Consulta resultado de un TestSet (GetStatusZip).
        Se usa después de SendTestSetAsync.
        """
        action = DIAN_ACTION_BASE + "GetStatusZip"

        body = f"""<wcf:GetStatusZip>
    <wcf:trackId>{zip_key}</wcf:trackId>
</wcf:GetStatusZip>"""

        envelope = self._build_soap_envelope(action, body)
        signed_envelope = self._envelope_sign(envelope)

        raw = self._send_to_dian(signed_envelope, action)
        raw_str = raw.decode("utf-8", errors="replace")

        parsed = self._parse_dian_response(raw_str, "GetStatusZipResponse")

        return {
            "success": parsed.get("success", False),
            "status_code": parsed.get("status_code"),
            "status_description": parsed.get("status_description"),
            "status_message": parsed.get("status_message"),
            "zip_key": parsed.get("zip_key"),
            "errors": parsed.get("errors", []),
            "raw_response": raw_str,
        }


    def send_event_update_status(self, zip_base64: str, filename: str) -> dict[str, Any]:
        """
        Envia un evento RADIAN (ApplicationResponse firmado y empaquetado en ZIP)
        usando SendEventUpdateStatus. Usado para 030/031/032/033 del adquiriente.
        """
        action = DIAN_ACTION_BASE + "SendEventUpdateStatus"

        body = f"""<wcf:SendEventUpdateStatus>
    <wcf:fileName>{filename}</wcf:fileName>
    <wcf:contentFile>{zip_base64}</wcf:contentFile>
</wcf:SendEventUpdateStatus>"""

        envelope = self._build_soap_envelope(action, body)
        signed_envelope = self._envelope_sign(envelope)

        raw = self._send_to_dian(signed_envelope, action)
        raw_str = raw.decode("utf-8", errors="replace")

        parsed = self._parse_dian_response(raw_str, "SendEventUpdateStatusResponse")

        return {
            "success":           parsed.get("success", False),
            "status_code":       parsed.get("status_code"),
            "status_description":parsed.get("status_description"),
            "status_message":    parsed.get("status_message"),
            "xml_document_key":  parsed.get("xml_document_key"),
            "errors":            parsed.get("errors", []),
            "raw_response":      raw_str,
        }

    # ── Nómina electrónica ──────────────────────────────────────────────────

    def send_nomina_sync(self, zip_base64: str, filename: str) -> dict[str, Any]:
        """
        Envío síncrono de nómina electrónica (SendNominaSync).
        Mismo endpoint que facturas, diferente acción y cuerpo SOAP.
        """
        action = DIAN_ACTION_BASE + "SendNominaSync"

        body = f"""<wcf:SendNominaSync>
    <wcf:fileName>{filename}</wcf:fileName>
    <wcf:contentFile>{zip_base64}</wcf:contentFile>
</wcf:SendNominaSync>"""

        envelope = self._build_soap_envelope(action, body)
        signed_envelope = self._envelope_sign(envelope)

        raw = self._send_to_dian(signed_envelope, action)
        raw_str = raw.decode("utf-8", errors="replace")

        parsed = self._parse_dian_response(raw_str, "SendNominaSyncResponse")

        return {
            "success":            parsed.get("success", False),
            "status_code":        parsed.get("status_code"),
            "status_description": parsed.get("status_description"),
            "status_message":     parsed.get("status_message"),
            "xml_document_key":   parsed.get("xml_document_key"),
            "errors":             parsed.get("errors", []),
            "raw_request":        signed_envelope,
            "raw_response":       raw_str,
            "http_status":        200,
        }

    def send_test_set_async(self, zip_base64: str, filename: str, test_set_id: str) -> dict[str, Any]:
        """
        Envío de nómina en ambiente de habilitación (SendTestSetAsync).
        """
        action = DIAN_ACTION_BASE + "SendTestSetAsync"

        body = f"""<wcf:SendTestSetAsync>
    <wcf:fileName>{filename}</wcf:fileName>
    <wcf:contentFile>{zip_base64}</wcf:contentFile>
    <wcf:testSetId>{test_set_id}</wcf:testSetId>
</wcf:SendTestSetAsync>"""

        envelope = self._build_soap_envelope(action, body)
        signed_envelope = self._envelope_sign(envelope)

        raw = self._send_to_dian(signed_envelope, action)
        raw_str = raw.decode("utf-8", errors="replace")

        parsed = self._parse_dian_response(raw_str, "SendTestSetAsyncResponse")

        return {
            "success":            parsed.get("success", False),
            "status_code":        parsed.get("status_code"),
            "status_description": parsed.get("status_description"),
            "status_message":     parsed.get("status_message"),
            "zip_key":            parsed.get("zip_key"),
            "errors":             parsed.get("errors", []),
            "raw_request":        signed_envelope,
            "raw_response":       raw_str,
            "http_status":        200,
        }


