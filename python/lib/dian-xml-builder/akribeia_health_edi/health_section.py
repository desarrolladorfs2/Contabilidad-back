"""
Generación de la sección 'health' para el JSON de factura (estilo Jorels).

Cuando la factura usa operación ss_* (SS-CUFE, SS-Recaudo, etc.),
muchos proveedores EDI esperan esta estructura dentro del payload JSON:

{
  "health": {
    "collections": [ { ... } ],
    "person": { ... }
  }
}

Este módulo genera exactamente esa estructura a partir de HealthInvoiceData.
"""

from typing import Any, Optional
from .models import HealthInvoiceData


def build_health_section(health: HealthInvoiceData) -> Optional[dict[str, Any]]:
    """
    Construye la sección 'health' lista para incluir en el JSON de envío
    a un proveedor EDI (o para tu propio procesamiento).

    Replica la lógica de get_json_request() del módulo Jorels.
    """
    if not health.should_include_health_section():
        return None

    section: dict[str, Any] = {}

    # === collections (datos de pago/cobertura del prestador) ===
    collection = {
        "provider_ref": health.provider_ref,
        "payment_method_code": health.payment_method_code,
        "type_coverage_code": health.type_coverage_code,
        "contract": health.contract,
        "policy": health.policy,
    }
    # Limpiar None
    collection = {k: v for k, v in collection.items() if v is not None}
    if collection:
        section["collections"] = [collection]

    # === person (usuario/paciente de salud) ===
    if health.health_user:
        person = {k: v for k, v in health.health_user.items() if v is not None}
        if person:
            section["person"] = person

    return section if section else None


def enrich_invoice_json_request(
    base_request: dict[str, Any],
    health: Optional[HealthInvoiceData],
) -> dict[str, Any]:
    """
    Toma el JSON normal de una factura y le inyecta la sección health
    si corresponde (exactamente como hace Jorels en get_json_request).

    Úsalo cuando prepares el payload para enviar a un servicio EDI JSON.
    """
    if not health or not health.should_include_health_section():
        return base_request

    health_section = build_health_section(health)
    if health_section:
        enriched = base_request.copy()
        enriched["health"] = health_section
        return enriched

    return base_request
