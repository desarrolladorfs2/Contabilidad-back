"""
Generador de JSON RIPS (Sector Salud Colombia).

Refactor limpio y reutilizable del script original que ya funciona:
"C:/Users/Alejandro Vargas/Documents/Proyecto_Akribeia_CRM/Rips a Json/Convertir Excel a JSON 2.py"

Características:
- Funciones puras (sin GUI, sin side effects)
- Soporte para cargar desde la plantilla Excel actual (compatibilidad)
- Validación con Pydantic
- Fácil de llamar desde SP_Dian_V1, scripts, API, etc.
- Genera exactamente la misma estructura que tu script probado
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

import pandas as pd
from pydantic import ValidationError

from .models import (
    RipsOutput,
    RipsUsuario,
    RipsServicioConsulta,
    RipsServicioProcedimiento,
    RipsServicioMedicamento,
    RipsServicioOtro,
    RipsServiciosUsuario,
)


# ============================================================
# CARGA DESDE EXCEL (tu plantilla actual - compatibilidad total)
# ============================================================

REQUIRED_SHEETS = ["Factura", "Usuarios", "Consultas", "Procedimientos", "Medicamentos", "OtrosServicios"]

REQUIRED_COLUMNS = {
    "Factura": ["numDocumentoIdObligado", "numFactura", "tipoNota", "numNota"],
    "Usuarios": [
        "Usuario", "tipoDocumentoIdentificacion", "numDocumentoIdentificacion", "tipoUsuario",
        "fechaNacimiento", "codSexo", "codPaisResidencia", "codMunicipioResidencia",
        "codZonaTerritorialResidencia", "incapacidad", "consecutivo", "codPaisOrigen"
    ],
    "Consultas": [
        "Usuario", "codPrestador", "fechaInicioAtencion", "numAutorizacion", "codConsulta",
        "modalidadGrupoServicioTecSal", "grupoServicios", "codServicio", "finalidadTecnologiaSalud",
        "causaMotivoAtencion", "codDiagnosticoPrincipal", "codDiagnosticoRelacionado1",
        "codDiagnosticoRelacionado2", "codDiagnosticoRelacionado3", "tipoDiagnosticoPrincipal",
        "tipoDocumentoIdentificacion", "numDocumentoIdentificacion", "vrServicio",
        "conceptoRecaudo", "valorPagoModerador", "numFEVPagoModerador", "consecutivo"
    ],
    "Procedimientos": [
        "Usuario", "codPrestador", "fechaInicioAtencion", "idMIPRES", "numAutorizacion",
        "codProcedimiento", "viaIngresoServicioSalud", "modalidadGrupoServicioTecSal",
        "grupoServicios", "codServicio", "finalidadTecnologiaSalud",
        "tipoDocumentoIdentificacion", "numDocumentoIdentificacion", "codDiagnosticoPrincipal",
        "codDiagnosticoRelacionado", "vrServicio", "conceptoRecaudo", "valorPagoModerador",
        "numFEVPagoModerador", "consecutivo"
    ],
    "Medicamentos": [
        "Usuario", "codPrestador", "numAutorizacion", "idMIPRES", "fechaDispensAdmon",
        "codDiagnosticoPrincipal", "codDiagnosticoRelacionado", "tipoMedicamento",
        "codTecnologiaSalud", "nomTecnologiaSalud", "concentracionMedicamento", "unidadMedida",
        "formaFarmaceutica", "unidadMinDispensa", "cantidadMedicamento", "diasTratamiento",
        "tipoDocumentoIdentificacion", "numDocumentoIdentificacion", "vrUnitMedicamento",
        "vrServicio", "conceptoRecaudo", "valorPagoModerador", "numFEVPagoModerador", "consecutivo"
    ],
    "OtrosServicios": [
        "Usuario", "codPrestador", "numAutorizacion", "idMIPRES", "fechaSuministroTecnologia",
        "tipoOS", "codTecnologiaSalud", "nomTecnologiaSalud", "cantidadOS",
        "tipoDocumentoIdentificacion", "numDocumentoIdentificacion", "vrUnitOS", "vrServicio",
        "conceptoRecaudo", "valorPagoModerador", "numFEVPagoModerador", "consecutivo"
    ],
}


def load_from_excel_template(file_path: str | Path) -> dict[str, pd.DataFrame]:
    """
    Lee la plantilla Excel multi-hoja y valida que tenga las columnas esperadas.

    Devuelve un dict con los DataFrames ya normalizados (columnas stripped).
    Lanza ValueError con mensajes claros si falta algo (igual que tu GUI original).
    """
    file_path = Path(file_path)
    if not file_path.exists():
        raise FileNotFoundError(f"No se encontró el archivo: {file_path}")

    xl = pd.ExcelFile(file_path)
    missing_sheets = [s for s in REQUIRED_SHEETS if s not in xl.sheet_names]
    if missing_sheets:
        raise ValueError(f"Hojas faltantes en el Excel: {', '.join(missing_sheets)}")

    sheets: dict[str, pd.DataFrame] = {}
    for sheet_name in REQUIRED_SHEETS:
        df = xl.parse(sheet_name, header=0, dtype=str)
        df.columns = [col.strip() for col in df.columns]
        sheets[sheet_name] = df

    # Validación de columnas (igual que el script original)
    for sheet_name, df in sheets.items():
        expected = REQUIRED_COLUMNS[sheet_name]
        actual = df.columns.tolist()
        missing = [c for c in expected if c not in actual]
        if missing:
            raise ValueError(
                f"Columnas faltantes en hoja '{sheet_name}': {missing}\n"
                f"Columnas encontradas: {actual}"
            )

    return sheets


# ============================================================
# CONVERSIÓN A MODELOS (lógica extraída del script que ya funciona)
# ============================================================

def _safe_int(val: Any, default: int = 0) -> int:
    try:
        if pd.isna(val) or str(val).strip() == "":
            return default
        return int(float(val))
    except Exception:
        return default


def _safe_str(val: Any, default: str = "") -> str:
    if pd.isna(val):
        return default
    s = str(val).strip()
    return s if s else default


def _normalize_optional(val: Any) -> Optional[str]:
    if pd.isna(val):
        return None
    s = str(val).strip()
    if not s or s.lower() == "null":
        return None
    return s


def _build_consultas(df: pd.DataFrame, usuario_id: str) -> list[RipsServicioConsulta]:
    consultas = []
    sub = df[df["Usuario"] == usuario_id]
    for idx, row in enumerate(sub.itertuples(index=False), start=1):
        r = {col: getattr(row, col) for col in sub.columns}
        entry = RipsServicioConsulta(
            codPrestador=_safe_str(r.get("codPrestador")),
            fechaInicioAtencion=_safe_str(r.get("fechaInicioAtencion")),
            numAutorizacion=_normalize_optional(r.get("numAutorizacion")),
            codConsulta=_safe_str(r.get("codConsulta")),
            modalidadGrupoServicioTecSal=_safe_str(r.get("modalidadGrupoServicioTecSal")),
            grupoServicios=_safe_str(r.get("grupoServicios")),
            codServicio=_safe_int(r.get("codServicio")),
            finalidadTecnologiaSalud=_safe_str(r.get("finalidadTecnologiaSalud")),
            causaMotivoAtencion=_safe_str(r.get("causaMotivoAtencion")),
            codDiagnosticoPrincipal=_safe_str(r.get("codDiagnosticoPrincipal")),
            codDiagnosticoRelacionado1=_normalize_optional(r.get("codDiagnosticoRelacionado1")),
            codDiagnosticoRelacionado2=_normalize_optional(r.get("codDiagnosticoRelacionado2")),
            codDiagnosticoRelacionado3=_normalize_optional(r.get("codDiagnosticoRelacionado3")),
            tipoDiagnosticoPrincipal=_safe_str(r.get("tipoDiagnosticoPrincipal")),
            tipoDocumentoIdentificacion=_safe_str(r.get("tipoDocumentoIdentificacion")),
            numDocumentoIdentificacion=_safe_str(r.get("numDocumentoIdentificacion")),
            vrServicio=_safe_int(r.get("vrServicio")),
            conceptoRecaudo=_safe_str(r.get("conceptoRecaudo")),
            valorPagoModerador=_safe_int(r.get("valorPagoModerador")),
            numFEVPagoModerador=_normalize_optional(r.get("numFEVPagoModerador")),
            consecutivo=idx,
        )
        # Solo agregar si tiene datos reales (misma lógica que tu script)
        if any(getattr(entry, f) for f in entry.model_fields if f not in {
            "numAutorizacion", "codDiagnosticoRelacionado1", "codDiagnosticoRelacionado2",
            "codDiagnosticoRelacionado3", "numFEVPagoModerador"
        }):
            consultas.append(entry)
    return consultas


def _build_procedimientos(df: pd.DataFrame, usuario_id: str) -> list[RipsServicioProcedimiento]:
    items = []
    sub = df[df["Usuario"] == usuario_id]
    for idx, row in enumerate(sub.itertuples(index=False), start=1):
        r = {col: getattr(row, col) for col in sub.columns}
        entry = RipsServicioProcedimiento(
            codPrestador=_safe_str(r.get("codPrestador")),
            fechaInicioAtencion=_safe_str(r.get("fechaInicioAtencion")),
            idMIPRES=_normalize_optional(r.get("idMIPRES")),
            numAutorizacion=_normalize_optional(r.get("numAutorizacion")),
            codProcedimiento=_safe_str(r.get("codProcedimiento")),
            viaIngresoServicioSalud=_safe_str(r.get("viaIngresoServicioSalud")),
            modalidadGrupoServicioTecSal=_safe_str(r.get("modalidadGrupoServicioTecSal")),
            grupoServicios=_safe_str(r.get("grupoServicios")),
            codServicio=_safe_int(r.get("codServicio")),
            finalidadTecnologiaSalud=_safe_str(r.get("finalidadTecnologiaSalud")),
            tipoDocumentoIdentificacion=_safe_str(r.get("tipoDocumentoIdentificacion")),
            numDocumentoIdentificacion=_safe_str(r.get("numDocumentoIdentificacion")),
            codDiagnosticoPrincipal=_safe_str(r.get("codDiagnosticoPrincipal")),
            codDiagnosticoRelacionado=_normalize_optional(r.get("codDiagnosticoRelacionado")),
            vrServicio=_safe_int(r.get("vrServicio")),
            conceptoRecaudo=_safe_str(r.get("conceptoRecaudo")),
            valorPagoModerador=_safe_int(r.get("valorPagoModerador")),
            numFEVPagoModerador=_normalize_optional(r.get("numFEVPagoModerador")),
            consecutivo=idx,
        )
        if any(getattr(entry, f) for f in entry.model_fields if f not in {
            "idMIPRES", "numAutorizacion", "codDiagnosticoRelacionado", "numFEVPagoModerador"
        }):
            items.append(entry)
    return items


def _build_medicamentos(df: pd.DataFrame, usuario_id: str) -> list[RipsServicioMedicamento]:
    items = []
    sub = df[df["Usuario"] == usuario_id]
    for idx, row in enumerate(sub.itertuples(index=False), start=1):
        r = {col: getattr(row, col) for col in sub.columns}
        entry = RipsServicioMedicamento(
            codPrestador=_safe_str(r.get("codPrestador")),
            numAutorizacion=_normalize_optional(r.get("numAutorizacion")),
            idMIPRES=_normalize_optional(r.get("idMIPRES")),
            fechaDispensAdmon=_safe_str(r.get("fechaDispensAdmon")),
            codDiagnosticoPrincipal=_safe_str(r.get("codDiagnosticoPrincipal")),
            codDiagnosticoRelacionado=_normalize_optional(r.get("codDiagnosticoRelacionado")),
            tipoMedicamento=_safe_str(r.get("tipoMedicamento")),
            codTecnologiaSalud=_safe_str(r.get("codTecnologiaSalud")),
            nomTecnologiaSalud=_safe_str(r.get("nomTecnologiaSalud")),
            concentracionMedicamento=_safe_int(r.get("concentracionMedicamento")),
            unidadMedida=_safe_int(r.get("unidadMedida")),
            formaFarmaceutica=_normalize_optional(r.get("formaFarmaceutica")),
            unidadMinDispensa=_safe_int(r.get("unidadMinDispensa")),
            cantidadMedicamento=_safe_int(r.get("cantidadMedicamento")),
            diasTratamiento=_safe_int(r.get("diasTratamiento")),
            tipoDocumentoIdentificacion=_safe_str(r.get("tipoDocumentoIdentificacion")),
            numDocumentoIdentificacion=_safe_str(r.get("numDocumentoIdentificacion")),
            vrUnitMedicamento=_safe_int(r.get("vrUnitMedicamento")),
            vrServicio=_safe_int(r.get("vrServicio")),
            conceptoRecaudo=_safe_str(r.get("conceptoRecaudo")),
            valorPagoModerador=_safe_int(r.get("valorPagoModerador")),
            numFEVPagoModerador=_normalize_optional(r.get("numFEVPagoModerador")),
            consecutivo=idx,
        )
        if any(getattr(entry, f) for f in entry.model_fields if f not in {
            "numAutorizacion", "idMIPRES", "codDiagnosticoRelacionado", "formaFarmaceutica", "numFEVPagoModerador"
        }):
            items.append(entry)
    return items


def _build_otros(df: pd.DataFrame, usuario_id: str) -> list[RipsServicioOtro]:
    items = []
    sub = df[df["Usuario"] == usuario_id]
    for idx, row in enumerate(sub.itertuples(index=False), start=1):
        r = {col: getattr(row, col) for col in sub.columns}
        entry = RipsServicioOtro(
            codPrestador=_safe_str(r.get("codPrestador")),
            numAutorizacion=_normalize_optional(r.get("numAutorizacion")),
            idMIPRES=_normalize_optional(r.get("idMIPRES")),
            fechaSuministroTecnologia=_safe_str(r.get("fechaSuministroTecnologia")),
            tipoOS=_safe_str(r.get("tipoOS")),
            codTecnologiaSalud=_safe_str(r.get("codTecnologiaSalud")),
            nomTecnologiaSalud=_safe_str(r.get("nomTecnologiaSalud")),
            cantidadOS=_safe_int(r.get("cantidadOS")),
            tipoDocumentoIdentificacion=_safe_str(r.get("tipoDocumentoIdentificacion")),
            numDocumentoIdentificacion=_safe_str(r.get("numDocumentoIdentificacion")),
            vrUnitOS=_safe_int(r.get("vrUnitOS")),
            vrServicio=_safe_int(r.get("vrServicio")),
            conceptoRecaudo=_safe_str(r.get("conceptoRecaudo")),
            valorPagoModerador=_safe_int(r.get("valorPagoModerador")),
            numFEVPagoModerador=_normalize_optional(r.get("numFEVPagoModerador")),
            consecutivo=idx,
        )
        if any(getattr(entry, f) for f in entry.model_fields if f not in {
            "numAutorizacion", "idMIPRES", "numFEVPagoModerador"
        }):
            items.append(entry)
    return items


def convert_sheets_to_rips(sheets: dict[str, pd.DataFrame]) -> RipsOutput:
    """
    Convierte los DataFrames (ya validados) en el modelo RipsOutput.
    Lógica 100% equivalente a tu script original que ya genera JSONs correctos.
    """
    factura = sheets["Factura"].iloc[0] if not sheets["Factura"].empty else {}
    output_data = {
        "numDocumentoIdObligado": _safe_str(factura.get("numDocumentoIdObligado")),
        "numFactura": _safe_str(factura.get("numFactura")),
        "tipoNota": _normalize_optional(factura.get("tipoNota")),
        "numNota": _normalize_optional(factura.get("numNota")),
        "usuarios": [],
    }

    usuarios_df = sheets["Usuarios"]
    consultas_df = sheets["Consultas"]
    proc_df = sheets["Procedimientos"]
    meds_df = sheets["Medicamentos"]
    otros_df = sheets["OtrosServicios"]

    grouped = usuarios_df.groupby("Usuario")
    user_counter = 1

    for usuario_id in sorted(grouped.groups.keys()):
        urow = grouped.get_group(usuario_id).iloc[0]
        u = {col: getattr(urow, col) for col in usuarios_df.columns}

        usuario = RipsUsuario(
            tipoDocumentoIdentificacion=_safe_str(u.get("tipoDocumentoIdentificacion")),
            numDocumentoIdentificacion=_safe_str(u.get("numDocumentoIdentificacion")),
            tipoUsuario=_safe_str(u.get("tipoUsuario")),
            fechaNacimiento=_safe_str(u.get("fechaNacimiento")),
            codSexo=_safe_str(u.get("codSexo")),
            codPaisResidencia=_safe_str(u.get("codPaisResidencia"), "170"),
            codMunicipioResidencia=_safe_str(u.get("codMunicipioResidencia")),
            codZonaTerritorialResidencia=_safe_str(u.get("codZonaTerritorialResidencia"), "01"),
            incapacidad=_safe_str(u.get("incapacidad"), "NO"),
            consecutivo=user_counter,
            codPaisOrigen=_safe_str(u.get("codPaisOrigen"), "170"),
            servicios=RipsServiciosUsuario(
                consultas=_build_consultas(consultas_df, usuario_id),
                procedimientos=_build_procedimientos(proc_df, usuario_id),
                medicamentos=_build_medicamentos(meds_df, usuario_id),
                otrosServicios=_build_otros(otros_df, usuario_id),
            ),
        )

        # Solo incluir si tiene servicios o identificación
        if usuario.servicios or usuario.numDocumentoIdentificacion:
            output_data["usuarios"].append(usuario)
            user_counter += 1

    return RipsOutput(**output_data)


# ============================================================
# API PÚBLICA PRINCIPAL
# ============================================================

def generate_rips_json(
    *,
    excel_path: str | Path | None = None,
    sheets: dict[str, pd.DataFrame] | None = None,
    output_path: str | Path | None = None,
    pretty: bool = True,
) -> str:
    """
    Genera el JSON RIPS completo (string).

    Uso recomendado:

    # Desde Excel (compatibilidad con tu herramienta actual)
    json_str = generate_rips_json(excel_path="Plantilla_....xlsx")

    # Desde datos ya cargados (para integrar con facturación)
    json_str = generate_rips_json(sheets=mis_dataframes)

    Si se pasa output_path, también guarda el archivo.
    """
    if excel_path:
        sheets = load_from_excel_template(excel_path)
    elif sheets is None:
        raise ValueError("Debes proporcionar excel_path o sheets")

    rips_model = convert_sheets_to_rips(sheets)

    # Validación final (por si acaso)
    if not rips_model.usuarios:
        raise ValueError("No se encontraron usuarios válidos con servicios en los datos.")

    indent = 4 if pretty else None
    json_str = rips_model.model_dump_json(indent=indent, exclude_none=True)

    if output_path:
        Path(output_path).write_text(json_str, encoding="utf-8")

    return json_str


def generate_rips_dict(
    *,
    excel_path: str | Path | None = None,
    sheets: dict[str, pd.DataFrame] | None = None,
) -> dict[str, Any]:
    """Versión que devuelve dict Python (útil para manipular antes de guardar)."""
    if excel_path:
        sheets = load_from_excel_template(excel_path)
    elif sheets is None:
        raise ValueError("Debes proporcionar excel_path o sheets")

    rips_model = convert_sheets_to_rips(sheets)
    return rips_model.model_dump(exclude_none=True)


# ============================================================
# CLI simple para pruebas rápidas (opcional)
# ============================================================

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Uso: python -m akribeia_health_edi.rips_generator <archivo.xlsx> [salida.json]")
        sys.exit(1)

    excel = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else None

    try:
        result = generate_rips_json(excel_path=excel, output_path=out)
        print("✅ JSON RIPS generado correctamente.")
        if out:
            print(f"   Guardado en: {out}")
        else:
            print(result[:500] + "..." if len(result) > 500 else result)
    except Exception as e:
        print(f"❌ Error: {e}")
        sys.exit(1)
