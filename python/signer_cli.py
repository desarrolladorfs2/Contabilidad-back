"""
CLI wrapper para python-signer.
Recibe JSON {xml_base64, pfx_base64, password} por stdin.
Escribe JSON {success, signed_xml_base64} por stdout.
"""
import sys
import json
import base64
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SIGNER_DIR = os.path.join(SCRIPT_DIR, 'lib', 'python-signer')
sys.path.insert(0, os.path.abspath(SIGNER_DIR))

def main():
    payload = json.loads(sys.stdin.read())
    try:
        from app.signer import DIANXMLSigner
        xml_bytes = base64.b64decode(payload['xml_base64'])
        pfx_bytes = base64.b64decode(payload['pfx_base64'])
        password  = payload['password']

        signer = DIANXMLSigner(pfx_bytes, password)
        signed_xml = signer.sign_document(xml_bytes)

        # Build zip with signed XML
        import zipfile, io, uuid
        filename = payload.get('filename', f'signed_{uuid.uuid4().hex[:8]}')
        # Strip .xml extension if already present to avoid double extension (e.g. foo.xml.xml)
        base_filename = filename[:-4] if filename.lower().endswith('.xml') else filename
        zip_buf = io.BytesIO()
        with zipfile.ZipFile(zip_buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(f'{base_filename}.xml', signed_xml)
        zip_b64 = base64.b64encode(zip_buf.getvalue()).decode()

        print(json.dumps({
            'success': True,
            'signed_xml_base64': base64.b64encode(signed_xml).decode(),
            'zip_base64': zip_b64,
            'signed_filename': filename,
        }))

    except Exception as e:
        import traceback
        print(json.dumps({'success': False, 'error': str(e), 'traceback': traceback.format_exc()}))

if __name__ == '__main__':
    main()
