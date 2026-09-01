"""
Esquemas de entrada (Pydantic) para el generador de XML DIAN.

El frontend (app.js) enviará un JSON que cumpla con este contrato.
Diseñado para ser simple pero completo para soportar IVA + INC + casos especiales.
"""

from typing import Literal, Optional, Any
from pydantic import BaseModel, Field, field_validator

# Soft import of akribeia_health_edi (our custom health module).
# This allows the builder to work even if the health package is not installed yet.
try:
    from akribeia_health_edi import HealthInvoiceData
except Exception:
    try:
        from akribeia_health_edi.models import HealthInvoiceData
    except Exception:
        HealthInvoiceData = None  # type: ignore[assignment, misc]


TaxType = Literal["01", "03", "04", "ZA", "22", "23", "24", "32", "34", "35", "ZY"]


class Party(BaseModel):
    """Emisor o Receptor"""
    nit: str = Field(..., min_length=1, max_length=20, description="NIT o número de documento sin DV")
    dv: Optional[str] = Field(None, description="Dígito de verificación (calculado si no se envía)")
    name: str = Field(..., min_length=3, max_length=200)
    trade_name: Optional[str] = None
    city_code: str = Field("11001", description="Código DANE de la ciudad (5 dígitos)")
    city_name: str = "Bogotá"
    department_code: str = "11"
    department_name: str = "Bogotá"
    country_code: str = "CO"
    address: str = "Carrera 1 # 1-1"
    tax_level_code: str = Field("R-99-PN", description="Código de responsabilidad fiscal. Válidos: O-13, O-15, O-23, O-47, R-99-PN (tabla 13.2.6.1 DIAN)")
    tax_level_list_name: str = Field("05", description="Atributo listName del TaxLevelCode. '05' es el valor histórico genérico; salud usa 'No aplica' (emisor) o '49' (EPS receptora)")
    tax_scheme_id: str = Field("01", description="01=IVA (normalmente)")
    tax_scheme_name: str = "IVA"
    email: Optional[str] = Field(None, description="Correo electrónico para recepción de documentos electrónicos (FAJ71)")
    phone: Optional[str] = Field(None, description="Teléfono de contacto (Contact/Telephone en UBL)")
    document_type: str = Field("31", description="Código tipo doc DIAN tabla 6.3.4: 13=CC, 31=NIT, 22=CE, 41=PP, 12=TI, 11=RC, 47=PEP, 91=NUIP")
    person_type: str = Field("1", description="AdditionalAccountID: 1=Persona jurídica, 2=Persona natural")
    # Campos requeridos por FAK61 cuando person_type='2' (persona natural)
    first_name: Optional[str] = Field(None, description="Primer nombre (cac:Person/FirstName)")
    middle_name: Optional[str] = Field(None, description="Segundo nombre (cac:Person/MiddleName)")
    family_name: Optional[str] = Field(None, description="Primer apellido (cac:Person/FamilyName)")
    second_family_name: Optional[str] = Field(None, description="Segundo apellido (cac:Person/SecondFamilyName)")


class InvoiceLineItem(BaseModel):
    """
    Una línea de la factura.
    Soporta la regla clave: INC (04) y IVA (01) son mutuamente excluyentes en la misma línea.
    """
    id: Optional[int] = None
    description: str = Field(..., min_length=1, max_length=500)
    quantity: float = Field(1.0, gt=0)
    unit_price: float = Field(..., ge=0)
    unit_code: str = Field("EA", description="Código UNSPSC de unidad (ver tabla 13.3.6)")
    unspsc: str = Field("43231500", description="Código UNSPSC del producto/servicio")

    # === Impuesto principal de la línea ===
    tax_type: TaxType = Field("01", description="01=IVA, 04=INC, ZA=Excluido, 32/34=consumo especial, etc.")
    tax_rate: float = Field(0.0, description="Porcentaje (19.0, 5.0, 8.0 para INC, etc). 0 si es ZA o por unidad")

    # Para impuestos por unidad (combustible, bolsas, licores, saludables)
    base_unit_measure: Optional[float] = Field(
        None, description="Cantidad base para impuestos por unidad (ej: 1.0 para bolsas)"
    )
    per_unit_amount: Optional[float] = Field(
        None, description="Valor por unidad para impuestos tipo 22,23,24,32,34"
    )

    discount_percent: float = Field(0.0, ge=0, le=100)

    # === SAL-020: identificación real del ítem para facturas de salud (Res. 948/2026) ===
    # Cuando vienen presentes, sustituyen la identificación genérica UNSPSC por la
    # identificación real del servicio (CUPS/CUM + código del pagador) confirmada
    # contra el XML NS82845. Si no vienen, el comportamiento es idéntico al anterior
    # (no afecta facturas normales, NC, ND, ni Documento Soporte).
    health_item_code: Optional[str] = Field(
        None, description="Código real del ítem para salud (ej: CUPS + código del pagador, ej. '890244SURA')"
    )
    health_item_scheme_name: str = Field(
        "Estándar de adopción del contribuyente",
        description="schemeName de StandardItemIdentification cuando se usa health_item_code",
    )
    authorization_number: Optional[str] = Field(
        None, description="Número de autorización del servicio — va en BuyersItemIdentification, no en la descripción"
    )
    unit_text: Optional[str] = Field(None, description="Unidad en texto libre para AdditionalItemProperty (ej: 'UND')")

    @field_validator("tax_rate")
    @classmethod
    def validate_tax_rate(cls, v: float, info) -> float:
        tax_type = info.data.get("tax_type")
        if tax_type == "ZA" and v != 0:
            return 0.0
        if tax_type in {"01", "04"} and v < 0:
            raise ValueError("tax_rate debe ser >= 0 para IVA e INC")
        return v


class InvoiceGenerationRequest(BaseModel):
    """
    Payload principal que envía el frontend para generar el XML DIAN.
    """
    # === Identificación del documento ===
    prefix: str = Field(..., max_length=10)
    number: int = Field(..., gt=0)
    issue_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$", description="YYYY-MM-DD")
    issue_time: Optional[str] = Field(None, description="HH:MM:SS-05:00 (calculado si no viene)")

    # === Datos del emisor (Obligado a Facturar) ===
    issuer: Party

    # === Datos del adquiriente ===
    customer: Party

    # === Configuración técnica DIAN ===
    software_id: str
    software_pin: str
    technical_key_test: str = Field(..., description="Clave técnica de prueba (o producción)")
    resolution_number: str
    resolution_start_date: str = "2019-01-19"
    resolution_end_date: str = "2030-01-19"
    resolution_prefix: str
    resolution_from: int = 990000000
    resolution_to: int = 995000000

    # === Ambiente ===
    environment: Literal["1", "2"] = Field("2", description="1=Producción, 2=Pruebas")

    # === Tipo de operación / CustomizationID ===
    customization_id: str = Field(
        "10",
        description=(
            "CustomizationID del documento UBL. "
            "10=Factura electrónica de venta (comercial, por defecto). "
            "Para sector salud: SS-Recaudo (PGP), SS-CUFE (Evento), SS-POS, "
            "SS-SNUM, SS-Reporte, SS-SinAporte."
        )
    )

    # === Líneas ===
    lines: list[InvoiceLineItem] = Field(..., min_length=1)

    # === Periodo de facturación (SS-Recaudo / PGP) ===
    invoice_period_start: Optional[str] = Field(None, description="Fecha inicio del periodo facturado (YYYY-MM-DD). Requerido para PGP/SS-Recaudo.")
    invoice_period_end:   Optional[str] = Field(None, description="Fecha fin del periodo facturado (YYYY-MM-DD). Requerido para PGP/SS-Recaudo.")

    # === Medio de pago ===
    payment_means_code: str = Field("10", description="Código medio de pago DIAN tabla 13.3.4.1. Usar ZZZ para PGP/EPS (instrumento no definido).")
    payment_means_id: Optional[str] = Field(
        None,
        description="Valor de cbc:ID dentro de PaymentMeans (tabla Forma de Pago 6.3.4.1 DIAN: '1'=Contado, '2'=Crédito). "
                    "Para facturas de salud (EPS) normalmente viene en health['forma_pago_eps']; este campo se usa "
                    "para documentos no-salud (p.ej. factura de pago por usuario/copago) donde no aplica 'health'. "
                    "Si no se envía, se usa '1' por defecto."
    )

    # === Datos opcionales ===
    note: Optional[str] = "Factura generada con SP_Dian V2 (Python)"
    currency: str = "COP"

    # === Metadatos para el proceso ===
    test_set_id: Optional[str] = None  # Solo para habilitación

    # === Soporte Sector Salud (akribeia_health_edi) ===
    # Cuando se envía, el builder puede generar también los RIPS JSON
    # y enriquecer el XML con información de salud.
    health: Optional[dict[str, Any]] = Field(
        None,
        description="Datos específicos de salud (prestador, cobertura, contrato, operación ss_*, paciente, etc.). "
                    "Se recomienda usar la estructura de HealthInvoiceData de akribeia_health_edi."
    )

    # === Opción A: Generación combinada XML + RIPS (fase actual) ===
    # Permite generar factura + RIPS en una sola llamada usando tu plantilla Excel actual.
    # Más adelante migraremos a generación nativa desde las líneas de la factura.
    rips_excel_path: Optional[str] = Field(
        None,
        description="Ruta al archivo Excel con plantilla RIPS (hojas: Factura, Usuarios, Consultas, etc.). "
                    "Si se envía junto con 'health', el builder genera XML + JSON RIPS en una sola respuesta."
    )
    generate_rips: bool = Field(
        False,
        description="Forzar generación de RIPS aunque no se envíe rips_excel_path (se usará en fases futuras)."
    )

    class Config:
        json_schema_extra = {
            "example": {
                "prefix": "SETP",
                "number": 990000123,
                "issue_date": "2025-04-15",
                "issuer": {
                    "nit": "900108281",
                    "name": "Mi Empresa SAS",
                    "city_code": "05001",
                    "city_name": "Medellín",
                },
                "customer": {
                    "nit": "900123456",
                    "name": "Cliente Ejemplo",
                },
                "software_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
                "software_pin": "12345",
                "technical_key_test": "fc8eac422eba16e22ffd8c6f94b3f40a6e38162c",
                "resolution_number": "18760000001",
                "resolution_prefix": "SETP",
                "lines": [
                    {
                        "description": "Desarrollo de software",
                        "quantity": 1,
                        "unit_price": 850000,
                        "tax_type": "01",
                        "tax_rate": 19.0,
                    },
                    {
                        "description": "Servicio de restaurante",
                        "quantity": 1,
                        "unit_price": 45000,
                        "tax_type": "04",
                        "tax_rate": 8.0,
                    }
                ]
            }
        }


class GenerationResponse(BaseModel):
    success: bool
    xml_base64: Optional[str] = None
    cufe: Optional[str] = None
    invoice_number: Optional[str] = None
    error: Optional[str] = None
    warnings: list[str] = []

    # === Salud / RIPS (nuevo) ===
    rips_json_base64: Optional[str] = Field(
        None,
        description="JSON RIPS generado (base64) cuando se proporcionó información de salud."
    )
    rips_filename: Optional[str] = Field(
        None,
        description="Nombre sugerido para el archivo RIPS (ej: RIPS_FE-123456.json)"
    )
    health_section: Optional[dict[str, Any]] = Field(
        None,
        description="Sección 'health' lista para incluir en JSON de envío EDI (estilo Jorels)."
    )


# ============================================================
# NOTA CRÉDITO
# ============================================================

# Códigos de concepto de corrección según tabla 13.1.5.2 DIAN
# ResponseCode válidos para DiscrepancyResponse
CONCEPTO_NOTA_CREDITO = {
    "1": "Devolución parcial de los bienes y/o no aceptación parcial del servicio",
    "2": "Anulación de factura electrónica",
    "3": "Rebaja o descuento parcial",
    "4": "Ajuste de precio",
    "5": "Otros",
}


class BillingReference(BaseModel):
    """Referencia a la factura original que se está corrigiendo."""
    invoice_id: str = Field(..., description="Número de la factura original (ej: SETP990000015)")
    invoice_uuid: str = Field(..., description="CUFE de la factura original (SHA-384)")
    invoice_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$", description="Fecha de la factura original YYYY-MM-DD")


class CreditNoteGenerationRequest(BaseModel):
    """
    Payload para generar el XML de una Nota Crédito Electrónica DIAN.

    Diferencias clave vs InvoiceGenerationRequest:
    - Incluye BillingReference (referencia a la factura que corrige)
    - Incluye DiscrepancyResponse (concepto de corrección)
    - El documento raíz es CreditNote, no Invoice
    - CUDE en lugar de CUFE
    - No lleva InvoiceControl (sin resolución/autorización)
    """
    # === Identificación del documento ===
    prefix: str = Field(..., max_length=10, description="Prefijo de la nota crédito (ej: NC, NCTE)")
    number: int = Field(..., gt=0)
    issue_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$", description="YYYY-MM-DD")
    issue_time: Optional[str] = Field(None, description="HH:MM:SS-05:00 (calculado si no viene)")

    # === Referencia a la factura original (obligatorio) ===
    billing_reference: BillingReference

    # === Concepto de corrección (tabla 13.1.5.2) ===
    discrepancy_code: str = Field(
        "1",
        description="Código de concepto: 1=Devolución parcial, 2=Anulación, 3=Descuento, 4=Ajuste precio, 5=Otros"
    )
    discrepancy_description: Optional[str] = Field(
        None,
        description="Descripción del motivo (si None, se usa el texto oficial del concepto)"
    )

    # === Datos del emisor y receptor ===
    issuer: Party
    customer: Party

    # === Configuración técnica DIAN ===
    software_id: str
    software_pin: str
    technical_key_test: str = Field(..., description="Clave técnica de prueba (o producción)")

    # === Ambiente ===
    environment: Literal["1", "2"] = Field("2", description="1=Producción, 2=Pruebas")

    # === Líneas de la nota crédito ===
    lines: list[InvoiceLineItem] = Field(..., min_length=1)

    # === Datos opcionales ===
    note: Optional[str] = None
    currency: str = "COP"

    # === Sector Salud (opcional) ===
    # Si viene informado, se agrega la extensión CustomTagGeneral (Resolución 948:2026)
    # igual que en la factura de evento/PGP. No aplica a NC fuera del módulo de salud.
    health: Optional[dict] = None

    class Config:
        json_schema_extra = {
            "example": {
                "prefix": "NC",
                "number": 1,
                "issue_date": "2025-06-02",
                "billing_reference": {
                    "invoice_id": "SETP990000015",
                    "invoice_uuid": "e988c01fe2901d1bbf37911758961f7083b6e5c58400552b309549d6fbaa6402c8ff67b51d3c6f4ed478dc94b0c8b0fc",
                    "invoice_date": "2025-05-20"
                },
                "discrepancy_code": "1",
                "discrepancy_description": "Devolución de producto defectuoso",
                "issuer": {
                    "nit": "900108281",
                    "name": "Mi Empresa SAS",
                },
                "customer": {
                    "nit": "900123456",
                    "name": "Cliente Ejemplo",
                },
                "software_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
                "software_pin": "12345",
                "technical_key_test": "fc8eac422eba16e22ffd8c6f94b3f40a6e38162c",
                "lines": [
                    {
                        "description": "Devolución parcial - Servicio de software",
                        "quantity": 1,
                        "unit_price": 100000,
                        "tax_type": "01",
                        "tax_rate": 19.0,
                    }
                ]
            }
        }


class CreditNoteGenerationResponse(BaseModel):
    success: bool
    xml_base64: Optional[str] = None
    cude: Optional[str] = None          # Código Único de Documento Electrónico (nota crédito)
    credit_note_number: Optional[str] = None
    error: Optional[str] = None
    warnings: list[str] = []


# ============================================================
# NOTA DÉBITO
# ============================================================

# Códigos de concepto según tabla 13.1.5.3 DIAN (Nota Débito)
CONCEPTO_NOTA_DEBITO = {
    "1": "Intereses",
    "2": "Gastos por cobrar",
    "3": "Cambio del valor",
    "4": "Otros",
}


class DebitNoteGenerationRequest(BaseModel):
    """
    Payload para generar el XML de una Nota Débito Electrónica DIAN.

    La Nota Débito AUMENTA el valor de una factura previamente emitida.
    Casos de uso: cobro de intereses, gastos adicionales, ajuste de precio al alza.

    Diferencias clave vs Nota Crédito:
    - Root element: DebitNote (namespace DebitNote-2)
    - CustomizationID: 32 (tabla 13.1.5.3)
    - ProfileID: DIAN 2.1: Nota Débito de Factura Electrónica de Venta
    - Líneas: DebitNoteLine + DebitedQuantity
    - Totales: RequestedMonetaryTotal (en lugar de LegalMonetaryTotal)
    - CUDE: mismo algoritmo SHA-384 con Software PIN
    """
    # === Identificación del documento ===
    prefix: str = Field(..., max_length=10, description="Prefijo de la nota débito (ej: ND, NDTE)")
    number: int = Field(..., gt=0)
    issue_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$", description="YYYY-MM-DD")
    issue_time: Optional[str] = Field(None, description="HH:MM:SS-05:00 (calculado si no viene)")

    # === Referencia a la factura original (obligatorio) ===
    billing_reference: BillingReference

    # === Concepto de ajuste (tabla 13.1.5.3) ===
    discrepancy_code: str = Field(
        "3",
        description="1=Intereses, 2=Gastos por cobrar, 3=Cambio del valor, 4=Otros"
    )
    discrepancy_description: Optional[str] = Field(None)

    # === Datos del emisor y receptor ===
    issuer: Party
    customer: Party

    # === Configuración técnica DIAN ===
    software_id: str
    software_pin: str
    technical_key_test: str = Field(..., description="Clave técnica (solo para compatibilidad; CUDE usa PIN)")

    # === Ambiente ===
    environment: Literal["1", "2"] = Field("2", description="1=Producción, 2=Pruebas")

    # === Líneas de la nota débito ===
    lines: list[InvoiceLineItem] = Field(..., min_length=1)

    # === Datos opcionales ===
    note: Optional[str] = None
    currency: str = "COP"

    # === Sector Salud (opcional) ===
    # Si viene informado, se agrega la extensión CustomTagGeneral (Resolución 948:2026)
    # igual que en la factura de evento/PGP. No aplica a ND fuera del módulo de salud.
    health: Optional[dict] = None


class DebitNoteGenerationResponse(BaseModel):
    success: bool
    xml_base64: Optional[str] = None
    cude: Optional[str] = None
    debit_note_number: Optional[str] = None
    error: Optional[str] = None
    warnings: list[str] = []

