"""
Extensión / documentación de la integración entre akribeia_health_edi y el dian-xml-builder.

=== ESTADO ACTUAL (Opción A implementada) ===

Ya es posible generar **XML DIAN + JSON RIPS en una sola llamada** al endpoint
`/generate-invoice-xml` usando tu plantilla Excel actual como fuente de datos clínicos.

Campos nuevos en InvoiceGenerationRequest:
- health: dict con los metadatos de salud (prestador, operación ss_*, cobertura, contrato, etc.)
- rips_excel_path: str (ruta a tu Plantilla_JSON_RIPS_....xlsx)
- generate_rips: bool (para fases futuras)

Respuesta incluye:
- health_section (estilo Jorels, lista para inyectar en JSON EDI)
- rips_json_base64 + rips_filename (cuando se generó RIPS)
- El numFactura del RIPS se fuerza con el número oficial de la factura (prefijo + número)

Esto cumple el objetivo de Opción A:
"Una sola llamada → XML + RIPS vinculados por CUFE"

=== MIGRACIÓN FUTURA (Opción B) ===

Cuando estemos listos, eliminaremos la dependencia del Excel y generaremos
los RIPS directamente desde:
- Las líneas de la factura (InvoiceLineItem)
- Los datos de HealthInvoiceData (prestador, diagnósticos, usuario, etc.)
- Un nuevo modelo intermedio tipo HealthServiceLine

En ese momento `rips_excel_path` se volverá opcional / legacy.
"""

from __future__ import annotations

from typing import Optional, Any

# Import del nuevo módulo propio akribeia_health_edi (con fallbacks)
try:
    from akribeia_health_edi import HealthInvoiceData, generate_rips_json
except Exception:
    try:
        from akribeia_health_edi.models import HealthInvoiceData
        from akribeia_health_edi.rips_generator import generate_rips_json
    except Exception:
        HealthInvoiceData = None  # type: ignore
        generate_rips_json = None  # type: ignore


def attach_health_to_request(request: dict[str, Any], health: Optional[dict]) -> dict[str, Any]:
    """
    Ejemplo de cómo enriquecer el request que llega al /generate-invoice-xml
    con los datos de salud.
    """
    if not health:
        return request

    # Aquí puedes validar / convertir al modelo HealthInvoiceData
    # y guardarlo en request["_health"] o similar para que el builder lo use.
    request = dict(request)  # copia
    request["_health"] = health
    return request


# === NOTAS IMPORTANTES DE IMPLEMENTACIÓN (Opción A) ===
#
# - El RIPS generado siempre tiene numFactura = {prefix}{number} de la factura
#   (aunque el Excel tenga otro valor). Esto es intencional y correcto.
#
# - El CUFE de la factura es la llave de vinculación oficial entre XML y RIPS.
#
# - Para facturas de salud reales, normalmente enviarás después:
#     1. El ZIP con la factura firmada (.xml + .zip)
#     2. El archivo RIPS_{numero}.json por separado (o dentro del mismo ZIP en algunos casos)
#   al pagador (EPS, ADRES, etc.) según el contrato.

# También actualizamos el import para incluir generate_rips_dict (con fallback)
try:
    from akribeia_health_edi import generate_rips_dict  # noqa: F401
except Exception:
    try:
        from akribeia_health_edi.rips_generator import generate_rips_dict  # noqa: F401
    except Exception:
        pass
