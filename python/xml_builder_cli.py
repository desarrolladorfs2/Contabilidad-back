"""
CLI wrapper para dian-xml-builder.
Recibe JSON por stdin, escribe resultado JSON por stdout.
Uso: python xml_builder_cli.py <operation>
  operations: generate-invoice | generate-credit-note | generate-debit-note
              generate-invoice-pdf | generate-credit-note-pdf | generate-debit-note-pdf
              generate-event
              generate-ds | generate-ds-pdf
              generate-tirilla-pdf
"""
import sys
import json
import base64
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BUILDER_DIR = os.path.join(SCRIPT_DIR, 'lib', 'dian-xml-builder')
sys.path.insert(0, os.path.abspath(BUILDER_DIR))

def main():
    operation = sys.argv[1] if len(sys.argv) > 1 else 'generate-invoice'
    payload = json.loads(sys.stdin.read())

    try:
        if operation == 'generate-invoice':
            from app.schemas import InvoiceGenerationRequest
            from app.builder import build_dian_invoice_xml
            req = InvoiceGenerationRequest(**payload)
            xml_string, metadata = build_dian_invoice_xml(req)
            xml_b64 = base64.b64encode(xml_string.encode('utf-8')).decode()
            print(json.dumps({
                'success': True,
                'xml_base64': xml_b64,
                'cufe': metadata['cufe'],
                'invoice_number': metadata['invoice_number'],
            }))

        elif operation == 'generate-credit-note':
            from app.schemas import CreditNoteGenerationRequest
            from app.credit_note_builder import build_dian_credit_note_xml
            req = CreditNoteGenerationRequest(**payload)
            xml_string, metadata = build_dian_credit_note_xml(req)
            xml_b64 = base64.b64encode(xml_string.encode('utf-8')).decode()
            print(json.dumps({
                'success': True,
                'xml_base64': xml_b64,
                'cude': metadata['cude'],
                'credit_note_number': metadata['credit_note_number'],
            }))

        elif operation == 'generate-debit-note':
            from app.schemas import DebitNoteGenerationRequest
            from app.debit_note_builder import build_dian_debit_note_xml
            req = DebitNoteGenerationRequest(**payload)
            xml_string, metadata = build_dian_debit_note_xml(req)
            xml_b64 = base64.b64encode(xml_string.encode('utf-8')).decode()
            print(json.dumps({
                'success': True,
                'xml_base64': xml_b64,
                'cude': metadata['cude'],
                'debit_note_number': metadata['debit_note_number'],
            }))

        elif operation in ('generate-invoice-pdf', 'generate-credit-note-pdf', 'generate-debit-note-pdf'):
            from app.pdf_generator import build_dian_invoice_pdf
            doc_type = 'credit_note' if 'credit' in operation else ('debit_note' if 'debit' in operation else 'invoice')
            doc_type = payload.get('document_type', doc_type)  # permite override desde el payload
            pdf_bytes = build_dian_invoice_pdf(
                payload=payload,
                cufe=payload.get('cufe') or payload.get('cude', ''),
                environment=payload.get('environment', 'test'),
                issue_datetime=payload.get('issue_datetime'),
                document_type=doc_type,
                billing_reference=payload.get('billing_reference'),
                concepto_code=payload.get('concepto_code'),
                concepto_desc=payload.get('concepto_desc'),
                primary_color=payload.get('pdf_primary_color'),
                secondary_color=payload.get('pdf_secondary_color'),
                payment_means_id=payload.get('payment_means_id'),
                payment_method_id=payload.get('payment_method_id'),
                signed_xml_b64=payload.get('signed_xml_b64'),
                logo_base64=payload.get('logo_base64'),
            )
            pdf_b64 = base64.b64encode(pdf_bytes).decode()
            print(json.dumps({'success': True, 'pdf_base64': pdf_b64}))

        elif operation == 'generate-event':
            from app.application_response_builder import (
                build_application_response_xml,
                validate_event_prerequisites,
            )
            ok, err = validate_event_prerequisites(payload['event_code'], payload.get('sent_events', []))
            if not ok:
                print(json.dumps({'success': False, 'error': err}))
                return
            xml_string, metadata = build_application_response_xml(
                event_code=payload['event_code'],
                invoice_id=payload['invoice_id'],
                invoice_cufe=payload['invoice_cufe'],
                sender_nit=payload['sender_nit'],
                sender_name=payload['sender_name'],
                sender_tax_scheme_id=payload.get('sender_tax_scheme_id', '01'),
                sender_tax_scheme_name=payload.get('sender_tax_scheme_name', 'IVA'),
                receiver_nit=payload.get('receiver_nit', ''),
                receiver_name=payload.get('receiver_name', ''),
                receiver_tax_scheme_id=payload.get('receiver_tax_scheme_id', '01'),
                receiver_tax_scheme_name=payload.get('receiver_tax_scheme_name', 'IVA'),
                evento_numero=payload.get('evento_numero', '1'),
                software_pin=payload.get('software_pin', ''),
                software_id=payload.get('software_id', ''),
                note=payload.get('note', ''),
                environment=payload.get('environment', 'test'),
                motivo_categoria=payload.get('motivo_categoria', ''),
                motivo_descripcion=payload.get('motivo_descripcion', ''),
                persona_receptora=payload.get('persona_receptora'),
            )
            xml_b64 = base64.b64encode(xml_string.encode('utf-8')).decode()
            print(json.dumps({'success': True, 'xml_base64': xml_b64, **metadata}))

        # ── Documento Soporte (DS) ─────────────────────────────────────────────
        elif operation == 'generate-ds':
            from app.ds_builder import DsGenerationRequest, build_dian_ds_xml
            req = DsGenerationRequest(**payload)
            xml_string, metadata = build_dian_ds_xml(req)
            xml_b64 = base64.b64encode(xml_string.encode('utf-8')).decode()
            print(json.dumps({
                'success': True,
                'xml_base64': xml_b64,
                'cuds': metadata['cuds'],
                'ds_number': metadata['ds_number'],
            }))

        elif operation == 'generate-ds-pdf':
            from app.pdf_generator import build_dian_invoice_pdf
            # Tipo de documento soporte para el PDF
            doc_type = payload.get('document_type', 'ds')
            pdf_bytes = build_dian_invoice_pdf(
                payload=payload,
                cufe=payload.get('cufe') or payload.get('cuds') or payload.get('cude', ''),
                environment=payload.get('environment', 'test'),
                issue_datetime=payload.get('issue_datetime'),
                document_type=doc_type,
                billing_reference=payload.get('billing_reference'),
                concepto_code=payload.get('concepto_code'),
                concepto_desc=payload.get('concepto_desc'),
                primary_color=payload.get('pdf_primary_color'),
                secondary_color=payload.get('pdf_secondary_color'),
                payment_means_id=payload.get('payment_means_id'),
                payment_method_id=payload.get('payment_method_id'),
                signed_xml_b64=payload.get('signed_xml_b64'),
                logo_base64=payload.get('logo_base64'),
            )
            pdf_b64 = base64.b64encode(pdf_bytes).decode()
            print(json.dumps({'success': True, 'pdf_base64': pdf_b64}))

        elif operation == 'generate-tirilla-pdf':
            from app.pdf_generator import build_tirilla_pdf
            pdf_bytes = build_tirilla_pdf(
                payload=payload,
                cufe=payload.get('cufe', ''),
                environment=payload.get('environment', 'test'),
            )
            pdf_b64 = base64.b64encode(pdf_bytes).decode()
            print(json.dumps({'success': True, 'pdf_base64': pdf_b64}))

        else:
            print(json.dumps({'success': False, 'error': f'Unknown operation: {operation}'}))

    except Exception as e:
        import traceback
        print(json.dumps({'success': False, 'error': str(e), 'traceback': traceback.format_exc()}))

if __name__ == '__main__':
    main()
