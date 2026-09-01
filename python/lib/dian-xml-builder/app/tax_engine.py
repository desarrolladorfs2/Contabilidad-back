"""
Motor de impuestos para Facturación Electrónica DIAN.

Inspirado fuertemente en la lógica de Odoo (l10n_co_electronic_invoice_self),
pero desacoplado y simplificado para uso standalone.

Reglas clave implementadas:
- IVA (01) e INC (04) son normalmente excluyentes en la misma línea.
- Soporte para impuestos por unidad (32, 34, 22, 23, 24...).
- Agrupación correcta por tipo de impuesto para generar múltiples TaxTotal.
- Cálculo de TaxExclusiveAmount correcto.
"""

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from .constants import TAX_CODES, PER_UNIT_TAX_CODES, WITHHOLDING_TAX_CODES


@dataclass
class TaxDetail:
    tax_type: str          # "01", "04", "ZA", "32", etc.
    tax_name: str
    rate: float            # porcentaje o valor por unidad
    taxable_amount: float  # base gravable
    tax_amount: float
    is_per_unit: bool = False
    base_unit_measure: float = 1.0
    line_id: int | None = None


@dataclass
class LineTaxResult:
    line_id: int
    line_extension: float          # Valor neto después de descuento (base)
    tax_details: list[TaxDetail] = field(default_factory=list)
    total_tax: float = 0.0


@dataclass
class InvoiceTaxSummary:
    lines: list[LineTaxResult]
    # Totales por tipo de impuesto (solo los que aplican)
    totals_by_type: dict[str, dict[str, Any]] = field(default_factory=dict)

    # === Distinción importante (adaptada de la versión JS que funcionaba) ===
    grand_line_extension: float = 0.0      # Valor bruto total de todas las líneas (incluye excluidos ZA)
    grand_tax_exclusive: float = 0.0       # Solo la porción gravable (sin excluidos) - va en TaxExclusiveAmount

    grand_tax_inclusive: float = 0.0
    total_iva: float = 0.0
    total_inc: float = 0.0
    total_ica: float = 0.0
    total_other_taxes: float = 0.0


def calculate_line_taxes(
    line_id: int,
    quantity: float,
    unit_price: float,
    discount_percent: float,
    tax_type: str,
    tax_rate: float,
    per_unit_amount: float | None = None,
    base_unit_measure: float | None = None,
) -> LineTaxResult:
    """
    Calcula los impuestos de una sola línea.

    Regla importante:
    - Si tax_type == "ZA" → sin impuesto (Excluido)
    - Si tax_type == "04" (INC) → normalmente no se cobra IVA en esa línea.
    - Impuestos por unidad usan per_unit_amount * cantidad (o base_unit_measure).
    """
    gross = quantity * unit_price
    discount = gross * (discount_percent / 100.0)
    line_extension = round(gross - discount, 2)

    result = LineTaxResult(
        line_id=line_id,
        line_extension=line_extension,
    )

    if tax_type == "ZA":
        # Excluido de IVA - no genera TaxTotal
        return result

    is_per_unit = tax_type in PER_UNIT_TAX_CODES

    if is_per_unit:
        # Impuestos especiales (bolsas, combustibles, licores, saludables)
        unit_qty = base_unit_measure or quantity
        tax_amt = round((per_unit_amount or tax_rate) * unit_qty, 2)

        result.tax_details.append(
            TaxDetail(
                tax_type=tax_type,
                tax_name=TAX_CODES.get(tax_type, "Impuesto Especial"),
                rate=per_unit_amount or tax_rate,
                taxable_amount=0.0,  # Para per-unit la base suele ser 0 o la cantidad
                tax_amount=tax_amt,
                is_per_unit=True,
                base_unit_measure=unit_qty,
                line_id=line_id,
            )
        )
        result.total_tax = tax_amt

    else:
        # Impuesto porcentual normal (01 IVA, 04 INC, 03 ICA, etc.)
        if tax_rate == 0:
            # No generamos TaxDetail para tasa 0%. Esto evita crear
            # TaxSubtotal con Percent 0.00 en el encabezado, que suele causar FAU04
            # cuando hay mezcla de tasas + excluidos. La línea igual contribuye
            # correctamente a LineExtensionAmount / TaxExclusiveAmount.
            pass
        else:
            tax_amount = round(line_extension * (tax_rate / 100.0), 2)

            result.tax_details.append(
                TaxDetail(
                    tax_type=tax_type,
                    tax_name=TAX_CODES.get(tax_type, "Impuesto"),
                    rate=tax_rate,
                    taxable_amount=line_extension,
                    tax_amount=tax_amount,
                    line_id=line_id,
                )
            )
            result.total_tax = tax_amount

    return result


def aggregate_invoice_taxes(lines: list[LineTaxResult]) -> InvoiceTaxSummary:
    """
    Agrupa todos los impuestos de las líneas.

    Produce la estructura necesaria para generar:
    - Múltiples <cac:TaxTotal> a nivel de documento
    - TaxExclusiveAmount correcto
    - Valores para el CUFE (ValImp1=IVA, ValImp2=INC, ValImp3=ICA)
    """
    summary = InvoiceTaxSummary(lines=lines)

    grouped: dict[str, dict[float, dict]] = defaultdict(lambda: defaultdict(lambda: {
        "taxable": 0.0,
        "tax_amount": 0.0,
        "rate": 0.0,
        "name": "",
        "is_per_unit": False,
    }))

    full_line_extension = 0.0          # Todas las líneas (como el "subtotal" de la versión JS vieja)
    tax_exclusive = 0.0                # Solo líneas gravables (como "taxExclusiveAmount" de la versión JS)
    total_iva = 0.0
    total_inc = 0.0
    total_ica = 0.0
    total_other = 0.0

    for line in lines:
        full_line_extension += line.line_extension

        has_real_tax = False

        for td in line.tax_details:
            if td.tax_type in WITHHOLDING_TAX_CODES:
                continue

            key = td.rate if not td.is_per_unit else "per_unit"
            g = grouped[td.tax_type][key]

            g["taxable"] += td.taxable_amount
            g["tax_amount"] += td.tax_amount
            g["rate"] = td.rate
            g["name"] = td.tax_name
            g["is_per_unit"] = td.is_per_unit

            has_real_tax = True

            if td.tax_type == "01":
                total_iva += td.tax_amount
            elif td.tax_type == "04":
                total_inc += td.tax_amount
            elif td.tax_type == "03":
                total_ica += td.tax_amount
            else:
                total_other += td.tax_amount

        # Adaptado del comportamiento de SP_Dian_V1_Varios_ItemsV2:
        # Solo las líneas que realmente generan impuestos van al TaxExclusiveAmount del encabezado.
        # Las líneas "Excluido de IVA" (ZA) aportan al LineExtensionAmount pero NO al TaxExclusiveAmount.
        if has_real_tax:
            tax_exclusive += line.line_extension

    # Convertir a estructura más cómoda
    summary.totals_by_type = {}
    for tax_code, rates in grouped.items():
        summary.totals_by_type[tax_code] = {
            "name": TAX_CODES.get(tax_code, tax_code),
            "groups": list(rates.values()),
            "total_amount": sum(g["tax_amount"] for g in rates.values()),
        }

    summary.grand_line_extension = round(full_line_extension, 2)
    summary.grand_tax_exclusive = round(tax_exclusive, 2)
    summary.total_iva = round(total_iva, 2)
    summary.total_inc = round(total_inc, 2)
    summary.total_ica = round(total_ica, 2)
    summary.total_other_taxes = round(total_other, 2)

    # Adaptado para cumplir FAU06:
    # "Valor Bruto más tributos" debe considerar el Valor Bruto completo de la factura
    # (incluyendo líneas excluidas que tienen valor comercial) + todos los tributos.
    # Esto es más consistente con lo que hacía la versión JS antigua.
    all_taxes = total_iva + total_inc + total_ica + total_other
    summary.grand_tax_inclusive = round(full_line_extension + all_taxes, 2)

    return summary


def get_cufe_tax_values(summary: InvoiceTaxSummary) -> dict[str, str]:
    """
    Devuelve los valores exactos que van en la cadena del CUFE:
    {
        "codImp1": "01",
        "valImp1": "1234.56",   # IVA
        "codImp2": "04",
        "valImp2": "89.10",     # INC
        "codImp3": "03",
        "valImp3": "0.00",      # ICA
    }
    """
    return {
        "codImp1": "01",
        "valImp1": f"{summary.total_iva:.2f}",
        "codImp2": "04",
        "valImp2": f"{summary.total_inc:.2f}",
        "codImp3": "03",
        "valImp3": f"{summary.total_ica:.2f}",
    }
