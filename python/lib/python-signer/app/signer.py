"""
Standalone DIAN XAdES Signer
Adaptado del módulo l10n_co_electronic_invoice_self de Odoo.
Usa xmlsig + cryptography para generar firmas compatibles con DIAN.
"""

import base64
import hashlib
import logging
import random
from datetime import datetime
from typing import Tuple

import pytz
import xmlsig
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.types import PrivateKeyTypes
from cryptography.hazmat.primitives.serialization import Encoding, pkcs12
from lxml import etree

from app import constants

_logger = logging.getLogger(__name__)


class DIANXMLSigner:
    """Firmador XAdES-EPES compatible con DIAN Colombia."""

    def __init__(self, pfx_bytes: bytes, password: str):
        """
        :param pfx_bytes: Contenido binario del archivo .pfx/.p12
        :param password: Contraseña del certificado
        """
        self.public_cert, self.private_key = self._load_pfx(pfx_bytes, password)

    @staticmethod
    def _load_pfx(pfx_bytes: bytes, password: str) -> Tuple[x509.Certificate, PrivateKeyTypes]:
        """Carga un PFX y devuelve (certificado, llave privada) usando cryptography."""
        try:
            private_key, cert, _additional_certs = pkcs12.load_key_and_certificates(
                pfx_bytes, password.encode() if isinstance(password, str) else password
            )
            if cert is None or private_key is None:
                raise ValueError("No se pudo extraer certificado o llave privada del PFX")
            return cert, private_key
        except Exception as e:
            _logger.error("Error cargando PFX: %s", e)
            raise

    def sign_document(self, xml_content: bytes) -> bytes:
        """Firma un XML de factura/nota según estándares DIAN."""
        try:
            return self._sign_ubl_document(xml_content)
        except Exception as e:
            _logger.exception("Error firmando documento DIAN")
            raise RuntimeError(f"Error al firmar el XML: {e}") from e

    def _sign_ubl_document(self, xml_content: bytes) -> bytes:
        signature_id = f"Signature{random.randint(10000, 99999)}"
        signed_properties_id = f"{signature_id}-SignedProperties{random.randint(10000, 99999)}"
        key_info_id = f"KeyInfo{random.randint(10000, 99999)}"
        reference_id = f"Reference{random.randint(10000, 99999)}"
        object_id = f"Object{random.randint(10000, 99999)}"

        etsi = "http://uri.etsi.org/01903/v1.3.2#"

        root = etree.fromstring(xml_content)

        # Crear firma base
        sign = xmlsig.template.create(
            c14n_method=xmlsig.constants.TransformInclC14N,
            sign_method=xmlsig.constants.TransformRsaSha256,
            name=signature_id,
            ns="ds",
        )

        # KeyInfo
        key_info = xmlsig.template.ensure_key_info(sign, name=key_info_id)
        x509_data = xmlsig.template.add_x509_data(key_info)
        xmlsig.template.x509_data_add_certificate(x509_data)
        xmlsig.template.add_key_value(key_info)

        # Referencias
        xmlsig.template.add_reference(
            sign,
            xmlsig.constants.TransformSha256,
            uri="#" + signed_properties_id,
            uri_type="http://uri.etsi.org/01903#SignedProperties",
        )
        xmlsig.template.add_reference(
            sign, xmlsig.constants.TransformSha256, uri="#" + key_info_id
        )
        ref = xmlsig.template.add_reference(
            sign, xmlsig.constants.TransformSha256, name=reference_id, uri=""
        )
        xmlsig.template.add_transform(ref, xmlsig.constants.TransformEnveloped)

        # Object + QualifyingProperties
        object_node = etree.SubElement(
            sign,
            etree.QName(xmlsig.constants.DSigNs, "Object"),
            nsmap={"etsi": etsi},
            attrib={xmlsig.constants.ID_ATTR: object_id},
        )

        qualifying_properties = etree.SubElement(
            object_node,
            etree.QName(etsi, "QualifyingProperties"),
            attrib={"Target": "#" + signature_id},
        )

        signed_properties = etree.SubElement(
            qualifying_properties,
            etree.QName(etsi, "SignedProperties"),
            attrib={xmlsig.constants.ID_ATTR: signed_properties_id},
        )

        signed_signature_properties = etree.SubElement(
            signed_properties, etree.QName(etsi, "SignedSignatureProperties")
        )

        # SigningTime (hora de Colombia)
        #
        # OJO: para eventos RADIAN (ApplicationResponse) la DIAN valida la
        # regla AAD09e — "la fecha de generación del evento es diferente a
        # la fecha de firma del evento" — comparando cbc:IssueDate/IssueTime
        # (fijados al construir el XML, unos segundos antes de llegar aquí a
        # firmar) contra este SigningTime. Antes se generaba con
        # datetime.now() en el momento de la firma, así que casi siempre
        # quedaba unos segundos por delante del IssueDate/IssueTime del
        # documento — suficiente para que la DIAN lo rechazara. Ahora se
        # reutiliza el IssueDate+IssueTime que ya trae el propio XML (si los
        # tiene) para que ambos coincidan exactamente; si el documento no
        # los trae (no debería pasar, pero por si acaso) se cae al reloj
        # actual como antes.
        cbc_ns = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
        bogota_tz = pytz.timezone("America/Bogota")
        signing_time = datetime.now(pytz.utc).astimezone(bogota_tz)
        issue_date_el = root.find(f"{{{cbc_ns}}}IssueDate")
        issue_time_el = root.find(f"{{{cbc_ns}}}IssueTime")
        if issue_date_el is not None and issue_date_el.text and issue_time_el is not None and issue_time_el.text:
            try:
                signing_time = datetime.fromisoformat(f"{issue_date_el.text.strip()}T{issue_time_el.text.strip()}")
            except ValueError:
                pass
        etree.SubElement(
            signed_signature_properties, etree.QName(etsi, "SigningTime")
        ).text = signing_time.isoformat(timespec="milliseconds")

        # SigningCertificate
        signing_certificate = etree.SubElement(
            signed_signature_properties, etree.QName(etsi, "SigningCertificate")
        )
        cert_el = etree.SubElement(signing_certificate, etree.QName(etsi, "Cert"))
        cert_digest = etree.SubElement(cert_el, etree.QName(etsi, "CertDigest"))

        etree.SubElement(
            cert_digest,
            etree.QName(xmlsig.constants.DSigNs, "DigestMethod"),
            attrib={"Algorithm": "http://www.w3.org/2001/04/xmlenc#sha256"},
        )

        cert_der = self.public_cert.public_bytes(Encoding.DER)
        hash_cert = hashlib.sha256(cert_der)
        etree.SubElement(
            cert_digest, etree.QName(xmlsig.constants.DSigNs, "DigestValue")
        ).text = base64.b64encode(hash_cert.digest()).decode()

        # IssuerSerial - ESTA ES LA PARTE CRÍTICA
        issuer_serial = etree.SubElement(cert_el, etree.QName(etsi, "IssuerSerial"))
        etree.SubElement(
            issuer_serial, etree.QName(xmlsig.constants.DSigNs, "X509IssuerName")
        ).text = xmlsig.utils.get_rdns_name(self.public_cert.issuer.rdns)

        etree.SubElement(
            issuer_serial, etree.QName(xmlsig.constants.DSigNs, "X509SerialNumber")
        ).text = str(self.public_cert.serial_number)

        # SignaturePolicyIdentifier
        sig_policy = etree.SubElement(
            signed_signature_properties, etree.QName(etsi, "SignaturePolicyIdentifier")
        )
        sig_policy_id = etree.SubElement(sig_policy, etree.QName(etsi, "SignaturePolicyId"))
        etree.SubElement(
            etree.SubElement(sig_policy_id, etree.QName(etsi, "SigPolicyId")),
            etree.QName(etsi, "Identifier"),
        ).text = constants.DEFAULT_POLICY_ID

        sig_policy_hash = etree.SubElement(sig_policy_id, etree.QName(etsi, "SigPolicyHash"))
        etree.SubElement(
            sig_policy_hash,
            etree.QName(xmlsig.constants.DSigNs, "DigestMethod"),
            attrib={"Algorithm": "http://www.w3.org/2001/04/xmlenc#sha256"},
        )
        etree.SubElement(
            sig_policy_hash, etree.QName(xmlsig.constants.DSigNs, "DigestValue")
        ).text = constants.POLICY_HASH_VALUE

        # SignerRole
        signer_role = etree.SubElement(
            signed_signature_properties, etree.QName(etsi, "SignerRole")
        )
        claimed = etree.SubElement(signer_role, etree.QName(etsi, "ClaimedRoles"))
        etree.SubElement(claimed, etree.QName(etsi, "ClaimedRole")).text = "supplier"

        # Agregar la firma al documento
        root.append(sign)

        # Firmar
        ctx = xmlsig.SignatureContext()
        ctx.x509 = self.public_cert
        ctx.public_key = self.public_cert.public_key()
        ctx.private_key = self.private_key
        ctx.sign(sign)

        # Mover la firma al ExtensionContent correcto:
        # - Factura/NC/ND UBL: 2 UBLExtensions → firma va en el segundo
        # - Nómina electrónica: 1 UBLExtension → firma va en el primero
        ext_ns = "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"
        ubl_extensions = root.find(f"{{{ext_ns}}}UBLExtensions")
        if ubl_extensions is not None:
            ubl_extensions_list = ubl_extensions.findall(f"{{{ext_ns}}}UBLExtension")
            # Elegir el índice: segundo si hay ≥2 (facturas), primero si hay 1 (nómina)
            target_idx = 1 if len(ubl_extensions_list) >= 2 else 0
            if len(ubl_extensions_list) > target_idx:
                ext_content = ubl_extensions_list[target_idx].find(f"{{{ext_ns}}}ExtensionContent")
                if ext_content is not None:
                    root.remove(sign)
                    ext_content.append(sign)

        return etree.tostring(
            root, xml_declaration=True, encoding="UTF-8", standalone=True
        )
