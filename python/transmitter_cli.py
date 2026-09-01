"""
CLI wrapper para dian-transmitter.
Recibe JSON por stdin, escribe resultado JSON por stdout.

Operaciones:
  send-bill-sync  : SendBillSync a DIAN (factura/nota de crédito/débito)
  send-event      : SendEventUpdateStatus (eventos RADIAN)
  get-status      : GetStatus (consulta por trackId/CUFE)
  get-status-zip  : GetStatusZip (consulta TestSet asíncrono)
"""
import sys
import json
import base64
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TRANSMITTER_DIR = os.path.join(SCRIPT_DIR, 'lib', 'dian-transmitter')
sys.path.insert(0, os.path.abspath(TRANSMITTER_DIR))

def main():
    operation = sys.argv[1] if len(sys.argv) > 1 else 'send-bill-sync'
    payload = json.loads(sys.stdin.read())

    try:
        from dian_sender import DianTransmitter

        # Normalizar ambiente: la BD guarda '2'=habilitación, '1'=producción
        # dian_sender.py espera 'test' o 'production'
        _env_raw = payload.get('environment', 'test')
        env = {'1': 'production', '2': 'test'}.get(str(_env_raw), _env_raw)
        pfx_base64 = payload.get('pfx_base64')
        password = payload.get('password', '')

        if pfx_base64:
            pfx_bytes = base64.b64decode(pfx_base64)
            tx = DianTransmitter(environment=env, pfx_bytes=pfx_bytes, password=password)
        else:
            # Usar ruta del PFX configurada
            pfx_path = payload.get('pfx_path') or os.environ.get('DEFAULT_PFX_PATH', '')
            if not pfx_path or not os.path.exists(pfx_path):
                print(json.dumps({'success': False, 'error': 'No se encontró certificado PFX para transmitir a DIAN'}))
                return
            tx = DianTransmitter(environment=env, pfx_path=pfx_path, password=password)

        if operation == 'send-bill-sync':
            result = tx.send_bill_sync(
                zip_base64=payload['zip_base64'],
                filename=payload['filename'],
            )
        elif operation == 'send-event':
            result = tx.send_event_update_status(
                zip_base64=payload['zip_base64'],
                filename=payload['filename'],
            )
        elif operation == 'get-status':
            result = tx.get_status(track_id=payload['track_id'])
        elif operation == 'get-status-zip':
            result = tx.get_status_zip(zip_key=payload['zip_key'])
        else:
            print(json.dumps({'success': False, 'error': f'Unknown operation: {operation}'}))
            return

        # Truncar raw_request/raw_response para no sobrecargar el pipe
        result.pop('raw_request', None)
        if not payload.get('include_raw'):
            result.pop('raw_response', None)

        result['success'] = result.get('success', False)
        print(json.dumps(result))

    except Exception as e:
        import traceback
        print(json.dumps({'success': False, 'error': str(e), 'traceback': traceback.format_exc()}))

if __name__ == '__main__':
    main()
