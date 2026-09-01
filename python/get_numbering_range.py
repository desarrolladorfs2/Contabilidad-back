"""
GetNumberingRange - obtiene la clave técnica de producción reusando la
infraestructura SOAP/firma de DianTransmitter.

Prueba varias combinaciones de parámetros porque el error 303
("El código del software no corresponde al NIT") suele venir de enviar
mal accountCode / accountCodeT / softwareCode.
"""
import sys
from lxml import etree

TRANSMITTER_DIR = "/sessions/focused-sweet-babbage/mnt/Proyecto_Akribeia_CRM/SP_Dian_V2/backend/python/lib/dian-transmitter"
sys.path.insert(0, TRANSMITTER_DIR)

from dian_sender import DianTransmitter, DIAN_ACTION_BASE, NSD  # noqa: E402

CERT = "/sessions/focused-sweet-babbage/mnt/Proyecto_Akribeia_CRM/SP_Dian_V2/backend/uploads/certificates/d07e83f4-abc1-410b-8837-780a77f4a03c_1781234372375_certificado_akribeia.pfx"
PASSWORD = "Neurum2020*"

NIT = "900746052"          # sin DV
NIT_DV = "9007460521"      # con DV
SOFTWARE_ID = "1e032c89-6cba-4761-9d97-adbec23c1f1b"


def get_numbering_range(tx: DianTransmitter, account_code, account_code_t, software_code):
    action = DIAN_ACTION_BASE + "GetNumberingRange"
    body = f"""<wcf:GetNumberingRange>
    <wcf:accountCode>{account_code}</wcf:accountCode>
    <wcf:accountCodeT>{account_code_t}</wcf:accountCodeT>
    <wcf:softwareCode>{software_code}</wcf:softwareCode>
</wcf:GetNumberingRange>"""
    envelope = tx._build_soap_envelope(action, body)
    signed = tx._envelope_sign(envelope)
    raw = tx._send_to_dian(signed, action)
    return raw.decode("utf-8", errors="replace")


def dump(raw_xml):
    """Extrae rangos + clave técnica + código/descripcion de operación."""
    try:
        root = etree.fromstring(raw_xml.encode("utf-8"))
    except Exception as e:
        print("  No se pudo parsear:", e)
        print(raw_xml[:800])
        return
    # Buscar cualquier elemento relevante por local-name
    interesting = ["OperationCode", "OperationDescription", "ResolutionNumber",
                   "Prefix", "FromNumber", "ToNumber", "TechnicalKey",
                   "ValidDateFrom", "ValidDateTo", "faultstring", "Text"]
    found_any = False
    for el in root.iter():
        local = etree.QName(el).localname if el.tag else ""
        if local in interesting and el.text and el.text.strip():
            print(f"    {local}: {el.text.strip()}")
            found_any = True
    if not found_any:
        # imprimir el body crudo para diagnóstico
        print("    (sin campos conocidos) — cuerpo:")
        print("   ", raw_xml[:1200].replace("\n", " "))


def main():
    tx = DianTransmitter(environment="production", pfx_path=CERT, password=PASSWORD)

    # Confirmar identidad del certificado
    subj = tx.cert.subject.rfc4514_string()
    print("Certificado:", subj)
    print("=" * 70)

    combos = [
        ("accountCode=NIT, accountCodeT=NIT, sw=ID",      NIT,    NIT,    SOFTWARE_ID),
        ("accountCode=NIT, accountCodeT=NIT_DV, sw=ID",   NIT,    NIT_DV, SOFTWARE_ID),
        ("accountCode=NIT_DV, accountCodeT=NIT_DV, sw=ID",NIT_DV, NIT_DV, SOFTWARE_ID),
        ("accountCode=NIT_DV, accountCodeT=NIT, sw=ID",   NIT_DV, NIT,    SOFTWARE_ID),
    ]

    for label, ac, act, sw in combos:
        print(f"\n>>> {label}")
        print(f"    accountCode={ac}  accountCodeT={act}  softwareCode={sw}")
        try:
            raw = get_numbering_range(tx, ac, act, sw)
            dump(raw)
        except Exception as e:
            print("    ERROR en la llamada:", repr(e))


if __name__ == "__main__":
    main()
