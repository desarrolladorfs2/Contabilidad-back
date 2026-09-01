"""
akribeia_health_edi

Módulo propio de Akribeia para Facturación Electrónica DIAN + RIPS (Sector Salud - Colombia).

Inspirado en l10n_co_edi_jorels_health (Jorels) pero implementado de forma
independiente para integrarse con SP_Dian_V1 y tus flujos actuales.

Uso principal:
- Generar JSON RIPS válidos (oficial MinSalud/SISPRO)
- Manejar metadatos de salud para facturas (campos ei_health_* + sección "health")
- Relacionar Factura (CUFE) <-> RIPS (numFactura)
"""

__version__ = "0.1.0"
__author__ = "Akribeia (custom fork)"

from .rips_generator import (
    generate_rips_json,
    generate_rips_dict,
    load_from_excel_template,
)
from .models import (
    RipsOutput,
    RipsUsuario,
    RipsServicioConsulta,
    RipsServicioProcedimiento,
    RipsServicioMedicamento,
    RipsServicioOtro,
    HealthInvoiceData,
)
from .health_section import build_health_section, enrich_invoice_json_request

__all__ = [
    "generate_rips_json",
    "generate_rips_dict",
    "load_from_excel_template",
    "RipsOutput",
    "RipsUsuario",
    "RipsServicioConsulta",
    "RipsServicioProcedimiento",
    "RipsServicioMedicamento",
    "RipsServicioOtro",
    "HealthInvoiceData",
    "build_health_section",
    "enrich_invoice_json_request",
]
