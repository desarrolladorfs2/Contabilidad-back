/**
 * Backfill: puebla invoice_lineas con los datos de las facturas existentes
 * que guardaron sus líneas en el campo invoice.lines (JSON blob).
 *
 * Idempotente — si invoice_lineas ya tiene filas para una factura, la omite.
 * Se ejecuta automáticamente desde database.ts al arrancar el backend.
 */
import { DataSource } from 'typeorm';
import { Factura }       from '../entities/Invoice';
import { FacturaLinea }  from '../entities/InvoiceLinea';

function mapTaxType(taxType: string): string {
  const t = (taxType || '').toUpperCase();
  if (t === 'IVA') return '01';
  if (t === 'INC') return '04';
  if (t === 'ICA') return '03';
  return 'ZZ';
}

export async function backfillInvoiceLineas(ds: DataSource): Promise<void> {
  const invoiceRepo = ds.getRepository(Factura);
  const lineaRepo   = ds.getRepository(FacturaLinea);

  // Solo facturas que tienen JSON de líneas
  const invoices = await invoiceRepo
    .createQueryBuilder('i')
    .select(['i.id', 'i.numero_factura', 'i.lineas'])
    .where('i.lineas IS NOT NULL')
    .getMany();

  let total = 0;

  for (const inv of invoices) {
    // Idempotencia: si ya hay líneas para esta factura, saltar
    const existing = await lineaRepo.count({ where: { factura_id: inv.id } });
    if (existing > 0) continue;

    let rawLines: any[];
    try {
      rawLines = typeof inv.lineas === 'string' ? JSON.parse(inv.lineas) : (inv.lineas as any[]);
    } catch {
      console.warn(`[Backfill] invoice ${inv.numero_factura}: lines JSON inválido, omitiendo`);
      continue;
    }
    if (!Array.isArray(rawLines) || rawLines.length === 0) continue;

    const lineas = rawLines.map((l: any, idx: number) => {
      const tributo  = mapTaxType(l.tax_type ?? '');
      const esIva    = tributo === '01';
      const esInc    = tributo === '04';
      const precio   = Number(l.unit_price    ?? 0);
      const cantidad = Number(l.quantity       ?? 1);
      const dcto_pct = Number(l.discount_rate  ?? 0);
      const dcto_val = Number(l.discount_amount ?? (precio * cantidad * dcto_pct / 100));
      const subtotal = precio * cantidad - dcto_val;
      const valorIva = esIva ? Number(l.tax_amount ?? 0) : 0;
      const valorInc = esInc ? Number(l.tax_amount ?? 0) : 0;
      const total    = Number(l.line_total ?? (subtotal + valorIva + valorInc));

      return lineaRepo.create({
        factura_id:           inv.id,
        linea_numero:         idx + 1,
        descripcion:          String(l.description ?? '').substring(0, 500),
        cantidad,
        unidad_medida_codigo: String(l.unit_code ?? 'EA').substring(0, 10),
        precio_unitario:      precio,
        descuento_pct:        dcto_pct,
        descuento_valor:      dcto_val,
        subtotal,
        tipo_tributo_codigo:  tributo,
        tarifa_iva:           esIva ? Number(l.tax_rate ?? 0) : 0,
        tarifa_inc:           esInc ? Number(l.tax_rate ?? 0) : 0,
        valor_iva:            valorIva,
        valor_inc:            valorInc,
        total,
        codigo_unspsc:        l.unspsc_code ? String(l.unspsc_code).substring(0, 20) : undefined,
      });
    });

    await lineaRepo.save(lineas);
    total += lineas.length;
    console.log(`[Backfill] ${inv.numero_factura}: ${lineas.length} líneas migradas`);
  }

  if (total > 0) {
    console.log(`[Backfill] invoice_lineas: ${total} líneas migradas en total`);
  } else {
    console.log('[Backfill] invoice_lineas: ya estaba actualizado, nada que migrar');
  }
}
