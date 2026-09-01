"""
Modelos de dominio para RIPS y datos de salud (Sector Salud Colombia).

Diseñados a partir de:
- Tu script funcional "Convertir Excel a JSON 2.py"
- Estructura oficial JSON RIPS (Res. 2275/2023 + actualizaciones)
- Campos health del módulo Jorels l10n_co_edi_jorels_health
"""

from typing import Optional, Literal, Any
from pydantic import BaseModel, Field, field_validator, model_validator
from datetime import date


# ============================================================
# CATÁLOGOS / TIPOS (se pueden expandir con tablas oficiales)
# ============================================================

TipoDocumentoIdentificacion = Literal["CC", "CE", "TI", "RC", "PA", "MS", "AS", "NI", "CD", "PT", "SC"]
TipoUsuario = Literal["01", "02", "03", "04", "05"]  # Cotizante, Beneficiario, etc.
CodSexo = Literal["M", "F", "I"]
CodZonaTerritorial = Literal["01", "02"]  # Urbana, Rural
Incapacidad = Literal["SI", "NO"]

ConceptoRecaudo = Literal["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", ""]  # Copago, Cuota moderadora, etc.

TipoDiagnosticoPrincipal = Literal["1", "2", "3", "01", "02", "03"]  # 1=Impresión diagnóstica, 2=Confirmado, 3=... (acepta con/sin cero)

ModalidadGrupoServicio = Literal["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", ""]

GrupoServicios = Literal["01", "02", "03", "04", "05"]  # Consulta, Procedimiento, etc.

FinalidadTecnologiaSalud = Literal["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", ""]  # Ampliado según catálogos reales 2025-2026

CausaMotivoAtencion = Literal["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "40", ""]  # Ampliado para soportar datos reales de plantillas Subsidiado/Contributivo

ViaIngresoServicioSalud = Literal["01", "02", "03", "04", "05", "06", ""]

TipoMedicamento = Literal["01", "02", "03", "04"]  # Pos, No pos, etc.

TipoOS = Literal["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", ""]


# ============================================================
# MODELOS DE SERVICIOS RIPS (por tipo)
# ============================================================

class RipsServicioBase(BaseModel):
    codPrestador: str = Field(..., min_length=1, max_length=20)
    numAutorizacion: Optional[str] = None
    idMIPRES: Optional[str] = None
    tipoDocumentoIdentificacion: TipoDocumentoIdentificacion
    numDocumentoIdentificacion: str
    vrServicio: int = Field(..., ge=0)
    conceptoRecaudo: ConceptoRecaudo = ""
    valorPagoModerador: int = Field(0, ge=0)
    numFEVPagoModerador: Optional[str] = None
    consecutivo: int = Field(..., gt=0)

    @field_validator("numAutorizacion")
    @classmethod
    def normalize_autorizacion(cls, v: Optional[str]) -> str:
        if v is None or str(v).strip() == "" or str(v).lower() == "null":
            return "null"
        return str(v).strip()


class RipsServicioConsulta(RipsServicioBase):
    fechaInicioAtencion: str = Field(..., description="YYYY-MM-DD HH:MM:SS o YYYY-MM-DD")
    codConsulta: str = Field(..., min_length=1)
    modalidadGrupoServicioTecSal: ModalidadGrupoServicio
    grupoServicios: GrupoServicios
    codServicio: int = 0
    finalidadTecnologiaSalud: FinalidadTecnologiaSalud
    causaMotivoAtencion: CausaMotivoAtencion
    codDiagnosticoPrincipal: str = Field(..., min_length=3)
    codDiagnosticoRelacionado1: Optional[str] = None
    codDiagnosticoRelacionado2: Optional[str] = None
    codDiagnosticoRelacionado3: Optional[str] = None
    tipoDiagnosticoPrincipal: TipoDiagnosticoPrincipal


class RipsServicioProcedimiento(RipsServicioBase):
    fechaInicioAtencion: str
    codProcedimiento: str = Field(..., min_length=1)
    viaIngresoServicioSalud: ViaIngresoServicioSalud
    modalidadGrupoServicioTecSal: ModalidadGrupoServicio
    grupoServicios: GrupoServicios
    codServicio: int = 0
    finalidadTecnologiaSalud: FinalidadTecnologiaSalud
    codDiagnosticoPrincipal: str = Field(..., min_length=3)
    codDiagnosticoRelacionado: Optional[str] = None


class RipsServicioMedicamento(RipsServicioBase):
    fechaDispensAdmon: str
    codDiagnosticoPrincipal: str = Field(..., min_length=3)
    codDiagnosticoRelacionado: Optional[str] = None
    tipoMedicamento: TipoMedicamento
    codTecnologiaSalud: str  # CUM
    nomTecnologiaSalud: str
    concentracionMedicamento: int = 0
    unidadMedida: int = 0
    formaFarmaceutica: Optional[str] = None
    unidadMinDispensa: int = 0
    cantidadMedicamento: int = Field(..., ge=0)  # Algunas plantillas reales envían 0 para ciertos registros (se filtran después)
    diasTratamiento: int = 0
    vrUnitMedicamento: int = Field(..., ge=0)


class RipsServicioOtro(RipsServicioBase):
    fechaSuministroTecnologia: str
    tipoOS: TipoOS
    codTecnologiaSalud: str
    nomTecnologiaSalud: str
    cantidadOS: int = Field(..., ge=0)  # Algunas plantillas reales envían 0
    vrUnitOS: int = Field(..., ge=0)


# ============================================================
# USUARIO + SERVICIOS
# ============================================================

class RipsServiciosUsuario(BaseModel):
    consultas: list[RipsServicioConsulta] = Field(default_factory=list)
    procedimientos: list[RipsServicioProcedimiento] = Field(default_factory=list)
    medicamentos: list[RipsServicioMedicamento] = Field(default_factory=list)
    otrosServicios: list[RipsServicioOtro] = Field(default_factory=list)

    @model_validator(mode="after")
    def remove_empty(self) -> "RipsServiciosUsuario":
        data = self.model_dump(exclude_unset=True)
        for key in ["consultas", "procedimientos", "medicamentos", "otrosServicios"]:
            if key in data and not data[key]:
                setattr(self, key, [])
        return self


class RipsUsuario(BaseModel):
    tipoDocumentoIdentificacion: TipoDocumentoIdentificacion
    numDocumentoIdentificacion: str
    tipoUsuario: TipoUsuario
    fechaNacimiento: str  # YYYY-MM-DD
    codSexo: CodSexo
    codPaisResidencia: str = "170"  # Colombia por defecto
    codMunicipioResidencia: str
    codZonaTerritorialResidencia: CodZonaTerritorial = "01"
    incapacidad: Incapacidad = "NO"
    consecutivo: int = Field(..., gt=0)
    codPaisOrigen: str = "170"
    servicios: RipsServiciosUsuario = Field(default_factory=RipsServiciosUsuario)

    @model_validator(mode="after")
    def cleanup_empty_services(self) -> "RipsUsuario":
        if self.servicios:
            cleaned = {}
            for k, v in self.servicios.model_dump().items():
                if v:  # only keep non-empty lists
                    cleaned[k] = v
            self.servicios = RipsServiciosUsuario(**cleaned) if cleaned else RipsServiciosUsuario()
        return self


# ============================================================
# SALIDA RIPS COMPLETA (el JSON que se genera)
# ============================================================

class RipsOutput(BaseModel):
    """
    Estructura completa del JSON RIPS según formato oficial.
    Este es el objeto que se serializa a JSON y se adjunta a la factura.
    """
    numDocumentoIdObligado: str
    numFactura: str
    tipoNota: Optional[str] = None
    numNota: Optional[str] = None
    usuarios: list[RipsUsuario] = Field(..., min_length=1)

    model_config = {"populate_by_name": True}


# ============================================================
# DATOS DE SALUD PARA LA FACTURA (inspirado directamente en Jorels)
# ============================================================

SsOperation = Literal[
    "ss_cufe", "ss_cude", "ss_pos", "ss_snum",
    "ss_recaudo", "ss_reporte", "ss_sinaporte"
]

class HealthInvoiceData(BaseModel):
    """
    Metadatos de salud que se asocian a una factura electrónica.

    Corresponde conceptualmente a los campos que Jorels agrega a account.move:
    - ei_health_provider_ref
    - ei_health_payment_method_id
    - ei_health_type_coverage_id
    - ei_health_contract / policy
    - ei_health_partner_id (paciente/usuario)
    - ei_operation (ss_*)
    """

    # === Operación de salud (define si va la sección health en el JSON de envío) ===
    operation: Optional[SsOperation] = None

    # === Prestador de servicios de salud (REPS / SGSSS) ===
    provider_ref: Optional[str] = Field(
        None,
        description="Código prestador asignado en el REPS o por MinSalud"
    )

    # === Modalidad de pago y cobertura ===
    # Estos normalmente serían códigos de catálogos (los definimos como str por ahora)
    payment_method_code: Optional[str] = None
    type_coverage_code: Optional[str] = None

    # Contrato o Póliza (solo uno de los dos)
    contract: Optional[str] = None
    policy: Optional[str] = None

    # === Usuario / paciente principal de la factura ===
    # (puede ser diferente del adquiriente comercial)
    health_user: Optional[dict[str, Any]] = Field(
        None,
        description="Datos básicos del usuario de salud (id, nombre, dirección, municipio, etc.)"
    )

    # === Diagnósticos principales a nivel de factura (si aplica) ===
    main_diagnoses: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_contract_or_policy(self) -> "HealthInvoiceData":
        if self.contract and self.policy:
            raise ValueError("Debe proporcionar contract O policy, no ambos.")
        return self

    def should_include_health_section(self) -> bool:
        """True si la operación es de tipo ss_* y hay datos suficientes."""
        if not self.operation or not self.operation.startswith("ss_"):
            return False
        return bool(self.provider_ref and self.payment_method_code and self.type_coverage_code)


# ============================================================
# REQUEST EXTENDIDO PARA EL GENERADOR DE XML (futuro uso)
# ============================================================

class HealthAwareInvoiceRequest(BaseModel):
    """
    Placeholder para cuando extendamos InvoiceGenerationRequest del dian-xml-builder.
    Por ahora es solo documentación de la dirección.
    """
    # ... campos normales de factura ...
    health: Optional[HealthInvoiceData] = None
    rips: Optional[RipsOutput] = None   # o referencia al archivo generado
