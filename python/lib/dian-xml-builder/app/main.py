"""
Servicio de Generación de XML UBL DIAN (sin firma) + Soporte Sector Salud.

Este módulo es independiente del firmador XAdES.
Genera XML DIAN 100% válido según el Anexo Técnico.

A partir de 2025 incluye soporte nativo para sector salud vía
akribeia_health_edi:
- Campos health (prestador, cobertura, contrato, operación ss_*)
- Generación de sección "health" (estilo Jorels)
- Preparado para generación de RIPS JSON vinculados por CUFE

Luego de generar el XML (+ RIPS cuando aplique), el frontend puede
enviarlo al firmador XAdES existente.
"""

import base64
import logging
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .builder import build_dian_invoice_xml
from .credit_note_builder import build_dian_credit_note_xml
from .constants import CORRECT_DIAN_AGENCY, CORRECT_PROFILE_ID
from .schemas import (
    InvoiceGenerationRequest,
    GenerationResponse,
    CreditNoteGenerationRequest,
    CreditNoteGenerationResponse,
    DebitNoteGenerationRequest,
    DebitNoteGenerationResponse,
)
from .pdf_generator import build_dian_invoice_pdf

# Import opcional del módulo de salud (robusto contra installs raros / namespace packages)
try:
    from akribeia_health_edi import (
        HealthInvoiceData,
        build_health_section,
        generate_rips_json,
        generate_rips_dict,
    )
    HEALTH_MODULE_AVAILABLE = True
except Exception:
    # Fallback: importar directamente del submódulo (útil cuando el __init__ del paquete no expone todo)
    try:
        from akribeia_health_edi.rips_generator import generate_rips_json, generate_rips_dict
        from akribeia_health_edi.health_section import build_health_section
        from akribeia_health_edi.models import HealthInvoiceData
        HEALTH_MODULE_AVAILABLE = True
    except Exception:
        HEALTH_MODULE_AVAILABLE = False
        HealthInvoiceData = None  # type: ignore
        build_health_section = None  # type: ignore
        generate_rips_json = None  # type: ignore
        generate_rips_dict = None  # type: ignore

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dian-xml-builder")

app = FastAPI(
    title="DIAN XML Builder Service",
    description="Generador de XML UBL 2.1 + Estructuras DIAN Colombia (sin firma). "
                "Diseñado para trabajar junto al firmador XAdES existente.",
    version="0.1.0",
)

# ==========================================
# CORS - Permitir llamadas desde el frontend (localhost:3000)
# ==========================================
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5500",   # Live Server / VSCode
        "http://127.0.0.1:5500",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "service": "dian-xml-builder",
        "features": ["IVA", "INC", "Impuestos especiales", "CUFE v2", "DianExtensions"],
        "cors_origins": ["http://localhost:3000", "http://127.0.0.1:3000"]
    }


@app.post("/generate-invoice-xml", response_model=GenerationResponse)
async def generate_invoice_xml(request: InvoiceGenerationRequest):
    """
    Genera el XML completo de una Factura Electrónica DIAN.

    El XML que retorna ya tiene:
    - Todos los TaxTotal correctos (pueden ser varios)
    - CUFE calculado
    - SoftwareSecurityCode
    - QR Code DIAN
    - DianExtensions completo

    Listo para ser enviado al firmador XAdES.
    """
    try:
        logger.info(f"Generando XML para factura {request.prefix}{request.number}")

        xml_string, metadata = build_dian_invoice_xml(request)

        xml_b64 = base64.b64encode(xml_string.encode("utf-8")).decode()

        # === SEGUNDA CAPA DE FORZADO (red de seguridad) ===
        # Aunque el builder ya debería entregar XML limpio, aplicamos una capa extra aquí.
        try:
            from .constants import CORRECT_DIAN_AGENCY_BYTES, CORRECT_PROFILE_ID_BYTES
            xml_raw = base64.b64decode(xml_b64)

            # Reemplazo por bytes (más confiable)
            xml_raw = xml_raw.replace(b"DIAN 2.1: Factura Electr\xc3\x83\xc2\xb3nica de Venta", CORRECT_PROFILE_ID_BYTES)
            xml_raw = xml_raw.replace(b"CO, DIAN (Direcci\xc3\x83\xc2\xb3n de Impuestos y Aduanas Nacionales)", CORRECT_DIAN_AGENCY_BYTES)

            xml_b64 = base64.b64encode(xml_raw).decode()
        except Exception as e:
            logger.warning(f"No se pudo aplicar segunda capa de forzado: {e}")

        logger.info(f"XML generado exitosamente. CUFE: {metadata['cufe'][:16]}...")

        # ============================================================
        # SOPORTE SECTOR SALUD (akribeia_health_edi) - Opción A
        # ============================================================
        rips_b64 = None
        rips_filename = None
        health_section = None
        rips_warnings = []

        invoice_number_str = f"{request.prefix}{request.number}"

        if request.health and HEALTH_MODULE_AVAILABLE:
            try:
                # Convertir el dict recibido a nuestro modelo validado
                health_data = HealthInvoiceData(**request.health)

                # 1. Generar sección "health" estilo Jorels (para JSON EDI si se usa)
                health_section = build_health_section(health_data)

                logger.info(f"Datos de salud recibidos para factura {invoice_number_str} "
                            f"(operation={health_data.operation})")

                # 2. Opción A: Generar RIPS + XML juntos (fase actual)
                #    Usamos la plantilla Excel como fuente de datos clínicos.
                #    Más adelante migraremos a generación nativa desde las líneas de factura.
                should_generate_rips = (
                    (request.rips_excel_path or request.generate_rips)
                    and generate_rips_json is not None
                )

                if should_generate_rips:
                    try:
                        if request.rips_excel_path:
                            logger.info(f"Generando RIPS desde Excel: {request.rips_excel_path}")
                            rips_dict = generate_rips_dict(excel_path=request.rips_excel_path)  # type: ignore
                        else:
                            # generate_rips=True sin path → por ahora no hace nada (se implementará después)
                            rips_dict = None

                        if rips_dict:
                            # === CRÍTICO: Forzamos el numFactura correcto de la factura ===
                            # El Excel puede tener otro número; la factura oficial siempre gana.
                            rips_dict["numFactura"] = invoice_number_str

                            # También sincronizamos numDocumentoIdObligado si hace sentido
                            # (normalmente viene del prestador en health o del issuer)
                            if not rips_dict.get("numDocumentoIdObligado"):
                                rips_dict["numDocumentoIdObligado"] = request.issuer.nit

                            # Serializamos el JSON final (limpio, sin None)
                            import json as _json
                            rips_json_str = _json.dumps(rips_dict, ensure_ascii=False, indent=2)

                            rips_b64 = base64.b64encode(rips_json_str.encode("utf-8")).decode()
                            rips_filename = f"RIPS_{invoice_number_str}.json"

                            logger.info(f"RIPS generado exitosamente para {invoice_number_str} → {rips_filename}")

                    except Exception as rips_err:
                        logger.warning(f"No se pudo generar RIPS desde Excel: {rips_err}")
                        rips_warnings.append(f"Error generando RIPS: {str(rips_err)}")

            except Exception as health_err:
                logger.warning(f"No se pudo procesar bloque health: {health_err}")
                rips_warnings.append(f"Error procesando datos de salud: {str(health_err)}")
                # No rompemos la generación de la factura por un error en salud

        response = GenerationResponse(
            success=True,
            xml_base64=xml_b64,
            cufe=metadata["cufe"],
            invoice_number=metadata["invoice_number"],
            health_section=health_section,
            rips_json_base64=rips_b64,
            rips_filename=rips_filename,
        )

        if rips_warnings:
            response.warnings.extend(rips_warnings)
            # Importante: si el usuario mandó datos de salud, estos warnings son muy relevantes
            logger.warning(f"Warnings de salud/RIPS para factura {invoice_number_str}: {rips_warnings}")

        return response

    except Exception as e:
        logger.exception("Error generando XML DIAN")
        raise HTTPException(
            status_code=400,
            detail=f"Error al generar el XML: {str(e)}"
        )


# Modelo simple para probar
class SimpleTestRequest(BaseModel):
    test_set_id: Optional[str] = None


@app.post("/test/simple-invoice")
async def test_simple_invoice(req: SimpleTestRequest = None):
    """
    Endpoint de prueba rápida que genera una factura de ejemplo
    con una línea en IVA y otra en INC.
    Útil para desarrollo.
    """
    sample = InvoiceGenerationRequest(
        prefix="SETP",
        number=990000999,
        issue_date="2025-04-15",
        software_id="56f2ae4e-9812-4fad-9255-08fcfcd5ccb0",
        software_pin="12345",
        technical_key_test="fc8eac422eba16e22ffd8c6f94b3f40a6e38162c",
        resolution_number="18760000001",
        resolution_prefix="SETP",
        issuer={
            "nit": "900108281",
            "name": "Empresa de Pruebas SAS",
            "city_code": "05001",
            "city_name": "Medellín",
            "tax_level_code": "O-99",
        },
        customer={
            "nit": "900123456",
            "name": "Cliente de Pruebas",
            "city_code": "11001",
            "city_name": "Bogotá",
            "tax_level_code": "R-99-PN",
        },
        lines=[
            {
                "description": "Desarrollo de módulo de facturación electrónica",
                "quantity": 1,
                "unit_price": 850000,
                "tax_type": "01",
                "tax_rate": 19.0,
                "unspsc": "81111501",
            },
            {
                "description": "Servicio de alimentación - INC",
                "quantity": 1,
                "unit_price": 45000,
                "tax_type": "04",
                "tax_rate": 8.0,
                "unspsc": "50100000",
            },
        ],
    )

    xml, meta = build_dian_invoice_xml(sample)
    return {
        "success": True,
        "cufe": meta["cufe"],
        "xml_preview": xml[:2000] + "...",
        "tax_summary": meta["tax_summary"],
    }


# ============================================================
# NOTA CRÉDITO
# ============================================================

@app.post("/generate-credit-note", response_model=CreditNoteGenerationResponse)
async def generate_credit_note(request: CreditNoteGenerationRequest):
    """
    Genera el XML completo de una Nota Crédito Electrónica DIAN (UBL 2.1).

    El XML retornado tiene:
    - DiscrepancyResponse con el concepto de corrección (tabla 13.1.5.2)
    - BillingReference con el número, CUFE y fecha de la factura original
    - CUDE calculado (SHA-384, mismo algoritmo que CUFE)
    - SoftwareSecurityCode
    - QR Code DIAN
    - DianExtensions sin InvoiceControl (las NC no llevan resolución)
    - CreditNoteLines con CreditedQuantity

    Listo para enviarse al firmador XAdES existente (/api/sign).
    """
    try:
        cn_id = f"{request.prefix}{request.number}"
        logger.info(f"Generando XML para nota crédito {cn_id} "
                    f"(referencia: {request.billing_reference.invoice_id})")

        xml_string, metadata = build_dian_credit_note_xml(request)

        xml_b64 = base64.b64encode(xml_string.encode("utf-8")).decode()

        # Segunda capa de forzado de literales (red de seguridad)
        try:
            from .constants import CORRECT_DIAN_AGENCY_BYTES, CORRECT_PROFILE_ID_BYTES
            xml_raw = base64.b64decode(xml_b64)
            xml_raw = xml_raw.replace(
                b"DIAN 2.1: Factura Electr\xc3\x83\xc2\xb3nica de Venta", CORRECT_PROFILE_ID_BYTES
            )
            xml_raw = xml_raw.replace(
                b"CO, DIAN (Direcci\xc3\x83\xc2\xb3n de Impuestos y Aduanas Nacionales)",
                CORRECT_DIAN_AGENCY_BYTES,
            )
            xml_b64 = base64.b64encode(xml_raw).decode()
        except Exception as e:
            logger.warning(f'No se pudo aplicar segunda capa de forzado en NC: {e}')

        logger.info(f"Nota crédito {cn_id} generada. CUDE: {metadata['cude'][:16]}...")

        return CreditNoteGenerationResponse(
            success=True,
            xml_base64=xml_b64,
            cude=metadata["cude"],
            credit_note_number=metadata["credit_note_number"],
        )

    except Exception as e:
        logger.exception("Error generando XML de nota crédito DIAN")
        raise HTTPException(
            status_code=400,
            detail=f"Error al generar la nota crédito: {str(e)}",
        )


# ============================================================
# NUEVO: Generación de PDF (Representación Gráfica DIAN)
# ============================================================

class PdfGenerationRequest(BaseModel):
    """Datos necesarios para generar el PDF. Reusa gran parte del payload del XML."""
    # Requeridos
    prefix: str
    number: int
    issue_date: str
    cufe: str
    issuer: dict
    customer: dict
    lines: list

    # Opcionales / extras
    environment: Optional[str] = "test"
    resolution_number: Optional[str] = None
    resolution_prefix: Optional[str] = None
    software_id: Optional[str] = None
    software_pin: Optional[str] = None
    technical_key_test: Optional[str] = None
    # Para fecha/hora completa si se tiene
    issue_datetime: Optional[str] = None
    # Forma/medio de pago y firma digital
    payment_means_id:  Optional[str] = None
    payment_method_id: Optional[str] = None
    signed_xml_b64:    Optional[str] = None


@app.post("/generate-invoice-pdf")
async def generate_invoice_pdf(req: PdfGenerationRequest):
    """
    Genera la Representación Gráfica en PDF según requisitos DIAN.
    Incluye todos los ítems, descuentos, impuestos (IVA/INC), CUFE y QR de validación.
    """
    try:
        logger.info(f"Generando PDF para factura {req.prefix}{req.number} (CUFE={req.cufe[:16]}...)")

        payload = req.dict(exclude={"cufe", "environment", "issue_datetime",
                                    "payment_means_id", "payment_method_id", "signed_xml_b64"})

        pdf_bytes = build_dian_invoice_pdf(
            payload=payload,
            cufe=req.cufe,
            environment=req.environment or "test",
            issue_datetime=req.issue_datetime,
            payment_means_id=req.payment_means_id,
            payment_method_id=req.payment_method_id,
            signed_xml_b64=req.signed_xml_b64,
        )

        pdf_b64 = base64.b64encode(pdf_bytes).decode()

        return {
            "success": True,
            "pdf_base64": pdf_b64,
            "filename": f"{req.prefix}{req.number}.pdf",
            "cufe": req.cufe,
        }

    except Exception as e:
        logger.exception("Error generando PDF DIAN")
        raise HTTPException(status_code=400, detail=f"Error al generar PDF: {str(e)}")

# ============================================================
# NUEVO: Genera XML Nota Debito
# ============================================================

@app.post("/generate-debit-note", response_model=DebitNoteGenerationResponse)
async def generate_debit_note(request: DebitNoteGenerationRequest):
    try:
        from .debit_note_builder import build_dian_debit_note_xml
        import base64

        xml_string, metadata = build_dian_debit_note_xml(request)
        xml_b64 = base64.b64encode(xml_string.encode("utf-8")).decode()

        logger.info(
            f"Nota debito {metadata['debit_note_number']} generada. "
            f"CUDE: {metadata['cude'][:16]}... "
            f"(referencia: {request.billing_reference.invoice_id})"
        )

        return DebitNoteGenerationResponse(
            success=True,
            xml_base64=xml_b64,
            cude=metadata["cude"],
            debit_note_number=metadata["debit_note_number"],
        )

    except Exception as e:
        logger.exception("Error generando XML de nota debito DIAN")
        raise HTTPException(
            status_code=400,
            detail=f"Error al generar la nota debito: {str(e)}",
        )


# ============================================================
# NUEVO: PDF Nota Credito
# ============================================================

class BillingReferenceInfo(BaseModel):
    invoice_id: Optional[str] = None
    invoice_date: Optional[str] = None
    invoice_uuid: Optional[str] = None

class CreditNotePdfRequest(BaseModel):
    prefix: str
    number: int
    issue_date: str
    cude: str
    issuer: dict
    customer: dict
    lines: list
    environment: Optional[str] = "test"
    issue_datetime: Optional[str] = None
    billing_reference: Optional[BillingReferenceInfo] = None
    concepto_code: Optional[str] = None
    concepto_desc: Optional[str] = None

@app.post("/generate-credit-note-pdf")
async def generate_credit_note_pdf(req: CreditNotePdfRequest):
    try:
        import base64
        logger.info(f"Generando PDF NC {req.prefix}{req.number} (CUDE={req.cude[:16]}...)")

        payload = {
            "prefix": req.prefix,
            "number": req.number,
            "issue_date": req.issue_date,
            "issuer": req.issuer,
            "customer": req.customer,
            "lines": req.lines,
        }

        pdf_bytes = build_dian_invoice_pdf(
            payload=payload,
            cufe=req.cude,
            environment=req.environment or "test",
            issue_datetime=req.issue_datetime,
            document_type="credit_note",
            billing_reference=req.billing_reference.dict() if req.billing_reference else None,
            concepto_code=req.concepto_code,
            concepto_desc=req.concepto_desc,
        )

        pdf_b64 = base64.b64encode(pdf_bytes).decode()
        return {
            "success": True,
            "pdf_base64": pdf_b64,
            "filename": f"{req.prefix}{req.number}.pdf",
        }

    except Exception as e:
        logger.exception("Error generando PDF Nota Credito")
        raise HTTPException(status_code=400, detail=f"Error al generar PDF NC: {str(e)}")


# ============================================================
# NUEVO: PDF Nota Debito
# ============================================================

class DebitNotePdfRequest(BaseModel):
    prefix: str
    number: int
    issue_date: str
    cude: str
    issuer: dict
    customer: dict
    lines: list
    environment: Optional[str] = "test"
    issue_datetime: Optional[str] = None
    billing_reference: Optional[BillingReferenceInfo] = None
    concepto_code: Optional[str] = None
    concepto_desc: Optional[str] = None

@app.post("/generate-debit-note-pdf")
async def generate_debit_note_pdf(req: DebitNotePdfRequest):
    try:
        import base64
        logger.info(f"Generando PDF ND {req.prefix}{req.number} (CUDE={req.cude[:16]}...)")

        payload = {
            "prefix": req.prefix,
            "number": req.number,
            "issue_date": req.issue_date,
            "issuer": req.issuer,
            "customer": req.customer,
            "lines": req.lines,
        }

        pdf_bytes = build_dian_invoice_pdf(
            payload=payload,
            cufe=req.cude,
            environment=req.environment or "test",
            issue_datetime=req.issue_datetime,
            document_type="debit_note",
            billing_reference=req.billing_reference.dict() if req.billing_reference else None,
            concepto_code=req.concepto_code,
            concepto_desc=req.concepto_desc,
        )

        pdf_b64 = base64.b64encode(pdf_bytes).decode()
        return {
            "success": True,
            "pdf_base64": pdf_b64,
            "filename": f"{req.prefix}{req.number}.pdf",
        }

    except Exception as e:
        logger.exception("Error generando PDF Nota Debito")
        raise HTTPException(status_code=400, detail=f"Error al generar PDF ND: {str(e)}")


# ============================================================
# RADIAN: Generación de ApplicationResponse (eventos adquiriente)
# ============================================================

class GenerateEventRequest(BaseModel):
    event_code: str                     # "030" | "031" | "032" | "033"
    invoice_id: str                     # Número de la factura ej: SETP990000153
    invoice_cufe: str                   # CUFE de la factura referenciada
    sender_nit: str                     # NIT del adquiriente (nosotros)
    sender_name: str                    # Nombre del adquiriente
    receiver_nit: Optional[str] = ""   # NIT del proveedor
    receiver_name: Optional[str] = ""  # Nombre del proveedor
    sent_events: Optional[list] = []   # Eventos ya enviados para esta factura
    note: Optional[str] = ""
    environment: Optional[str] = "test"

class GenerateEventResponse(BaseModel):
    success: bool
    xml_base64: Optional[str] = None
    event_id: Optional[str] = None
    event_code: Optional[str] = None
    event_description: Optional[str] = None
    issue_datetime: Optional[str] = None
    error: Optional[str] = None

@app.post("/generate-event", response_model=GenerateEventResponse)
async def generate_event(req: GenerateEventRequest):
    """
    Genera el XML ApplicationResponse UBL 2.1 para un evento RADIAN.
    Valida prerrequisitos antes de construir.
    """
    try:
        import base64
        from .application_response_builder import (
            build_application_response_xml,
            validate_event_prerequisites,
            RADIAN_EVENTS,
        )

        # Validar prerequisitos
        ok, err = validate_event_prerequisites(req.event_code, req.sent_events or [])
        if not ok:
            return GenerateEventResponse(success=False, error=err)

        xml_string, metadata = build_application_response_xml(
            event_code=req.event_code,
            invoice_id=req.invoice_id,
            invoice_cufe=req.invoice_cufe,
            sender_nit=req.sender_nit,
            sender_name=req.sender_name,
            receiver_nit=req.receiver_nit or "",
            receiver_name=req.receiver_name or "",
            note=req.note or "",
            environment=req.environment or "test",
        )

        xml_b64 = base64.b64encode(xml_string.encode("utf-8")).decode()
        logger.info(f"Evento {req.event_code} generado: {metadata['event_id']}")

        return GenerateEventResponse(
            success=True,
            xml_base64=xml_b64,
            event_id=metadata.get("event_id"),
            event_code=req.event_code,
            event_description=metadata.get("event_description"),
            issue_datetime=metadata.get("issue_datetime"),
        )

    except Exception as e:
        import traceback
        logger.error(f"Error generando evento: {e}\n{traceback.format_exc()}")
        return GenerateEventResponse(success=False, error=str(e))
