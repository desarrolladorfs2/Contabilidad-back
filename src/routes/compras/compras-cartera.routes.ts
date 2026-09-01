import { Router, Response } from 'express';
import { AppDataSource } from '../../config/database';
import { FacturaCompra } from '../../entities/FacturaCompra';
import { DocumentoSoporte } from '../../entities/compras/DocumentoSoporte';
import { PagoCompra, TipoPagoCompra, DocumentoCompraTipo } from '../../entities/compras/PagoCompra';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';

const router = Router();
router.use(authMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: normalizan FacturaCompra y DocumentoSoporte a una forma común,
// ya que TypeORM no puede hacer UNION nativo entre dos entidades distintas.
// ─────────────────────────────────────────────────────────────────────────────

function normalizarFc(fc: FacturaCompra) {
  return {
    documento_tipo: 'factura_compra' as DocumentoCompraTipo,
    documento_id: fc.id,
    numero: fc.invoice_number_str ? `${fc.invoice_prefix || ''}${fc.invoice_number_str}` : fc.id.slice(0, 8),
    fecha: fc.invoice_date,
    fecha_vencimiento: fc.due_date,
    proveedor_nit: fc.provider_nit,
    proveedor_nombre: fc.provider_name,
    total: +fc.total,
    condicion_pago: fc.condicion_pago,
    estado_pago: fc.estado_pago || 'pendiente',
    total_pagado: +(fc.total_pagado || 0),
    numero_cuotas: fc.numero_cuotas,
  };
}

function normalizarDs(ds: DocumentoSoporte) {
  return {
    documento_tipo: 'documento_soporte' as DocumentoCompraTipo,
    documento_id: ds.id,
    numero: ds.numero_ds,
    fecha: ds.fecha_emision,
    fecha_vencimiento: ds.fecha_vencimiento,
    proveedor_nit: ds.proveedor_nit,
    proveedor_nombre: ds.proveedor_nombre,
    total: +ds.total,
    condicion_pago: ds.condicion_pago,
    estado_pago: ds.estado_pago || 'pendiente',
    total_pagado: +(ds.total_pagado || 0),
    numero_cuotas: ds.numero_cuotas,
  };
}

async function findDocumento(cid: string, tipo: DocumentoCompraTipo, id: string) {
  if (tipo === 'factura_compra') {
    return AppDataSource.getRepository(FacturaCompra).findOne({ where: { id, company_id: cid } });
  }
  return AppDataSource.getRepository(DocumentoSoporte).findOne({ where: { id, company_id: cid } });
}

async function guardarDocumento(tipo: DocumentoCompraTipo, doc: FacturaCompra | DocumentoSoporte, updates: Record<string, unknown>) {
  if (tipo === 'factura_compra') {
    await AppDataSource.getRepository(FacturaCompra).save({ ...(doc as FacturaCompra), ...updates });
  } else {
    await AppDataSource.getRepository(DocumentoSoporte).save({ ...(doc as DocumentoSoporte), ...updates });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CARTERA CxP
// GET /api/compras/cartera?status=pendiente|parcial|pagada&overdue=true
// ─────────────────────────────────────────────────────────────────────────────
router.get('/cartera', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { status, overdue, search } = req.query as Record<string, string>;

    const fcQb = AppDataSource.getRepository(FacturaCompra)
      .createQueryBuilder('fc')
      .where('fc.company_id = :cid', { cid });
    if (status) fcQb.andWhere('fc.estado_pago = :ps', { ps: status });
    if (search) fcQb.andWhere('(fc.provider_name LIKE :s OR fc.provider_nit LIKE :s OR fc.invoice_number_str LIKE :s)', { s: `%${search}%` });
    const facturas = await fcQb.getMany();

    const dsQb = AppDataSource.getRepository(DocumentoSoporte)
      .createQueryBuilder('ds')
      .where('ds.company_id = :cid', { cid })
      .andWhere("ds.estado NOT IN ('borrador','anulado','rechazado')");
    if (status) dsQb.andWhere('ds.estado_pago = :ps', { ps: status });
    if (search) dsQb.andWhere('(ds.proveedor_nombre LIKE :s OR ds.proveedor_nit LIKE :s OR ds.numero_ds LIKE :s)', { s: `%${search}%` });
    const docs = await dsQb.getMany();

    const baseItems = [...facturas.map(normalizarFc), ...docs.map(normalizarDs)];

    const today = new Date().toISOString().slice(0, 10);
    let items = baseItems.map(it => ({
      ...it,
      is_overdue: it.fecha_vencimiento ? it.estado_pago !== 'pagada' && it.fecha_vencimiento < today : false,
      days_overdue: it.fecha_vencimiento && it.estado_pago !== 'pagada'
        ? Math.max(0, Math.floor((Date.now() - new Date(it.fecha_vencimiento).getTime()) / 86400000))
        : 0,
    }));
    if (overdue === 'true') items = items.filter(it => it.is_overdue);

    items.sort((a, b) => (a.fecha_vencimiento || '9999').localeCompare(b.fecha_vencimiento || '9999'));

    // Adjuntar cuotas
    const payRepo = AppDataSource.getRepository(PagoCompra);
    const payments = items.length
      ? await payRepo.createQueryBuilder('p')
          .where('p.documento_id IN (:...ids)', { ids: items.map(i => i.documento_id) })
          .orderBy('p.cuota_numero', 'ASC')
          .getMany()
      : [];
    const paymentsMap = new Map<string, PagoCompra[]>();
    for (const p of payments) {
      const key = `${p.documento_tipo}:${p.documento_id}`;
      const arr = paymentsMap.get(key) ?? [];
      arr.push(p);
      paymentsMap.set(key, arr);
    }
    const result = items.map(it => ({
      ...it,
      payments: paymentsMap.get(`${it.documento_tipo}:${it.documento_id}`) ?? [],
    }));

    res.json({ items: result, total: result.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error cargando cartera CxP' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// RESUMEN CARTERA CxP
// GET /api/compras/cartera/resumen
// ─────────────────────────────────────────────────────────────────────────────
router.get('/cartera/resumen', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const today = new Date().toISOString().slice(0, 10);

    const facturas = await AppDataSource.getRepository(FacturaCompra).find({ where: { company_id: cid } });
    const docs = await AppDataSource.getRepository(DocumentoSoporte).find({ where: { company_id: cid } });
    const items = [...facturas.map(normalizarFc), ...docs.map(normalizarDs)];

    const summary: Record<string, { count: number; total: number; pendiente: number }> = {};
    let overdueCount = 0;
    for (const it of items) {
      const key = it.estado_pago || 'pendiente';
      if (!summary[key]) summary[key] = { count: 0, total: 0, pendiente: 0 };
      summary[key].count++;
      summary[key].total += it.total;
      summary[key].pendiente += it.total - it.total_pagado;
      if (it.fecha_vencimiento && it.estado_pago !== 'pagada' && it.fecha_vencimiento < today) overdueCount++;
    }

    res.json({ summary, overdue_count: overdueCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error cargando resumen de cartera CxP' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PAGOS / CUOTAS POR DOCUMENTO
// GET    /api/compras/cartera/:tipo/:id/pagos
// POST   /api/compras/cartera/:tipo/:id/pagos   (crear cuotas en lote)
// PUT    /api/compras/cartera/pagos/:pid        (marcar como pagada)
// DELETE /api/compras/cartera/pagos/:pid
// ─────────────────────────────────────────────────────────────────────────────

function tipoValido(tipo: string): tipo is DocumentoCompraTipo {
  return tipo === 'factura_compra' || tipo === 'documento_soporte';
}

router.get('/cartera/:tipo/:id/pagos', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!tipoValido(req.params.tipo)) { res.status(400).json({ error: 'Tipo de documento inválido' }); return; }
    const doc = await findDocumento(req.user!.companyId, req.params.tipo, req.params.id);
    if (!doc) { res.status(404).json({ error: 'Documento no encontrado' }); return; }

    const payments = await AppDataSource.getRepository(PagoCompra).find({
      where: { documento_tipo: req.params.tipo, documento_id: req.params.id },
      order: { cuota_numero: 'ASC', fecha_vencimiento: 'ASC' },
    });
    res.json(payments);
  } catch (e) {
    res.status(500).json({ error: 'Error cargando pagos' });
  }
});

/** Crear o reemplazar cuotas de un documento de compra */
router.post('/cartera/:tipo/:id/pagos', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!tipoValido(req.params.tipo)) { res.status(400).json({ error: 'Tipo de documento inválido' }); return; }
    const cid = req.user!.companyId;
    const doc = await findDocumento(cid, req.params.tipo, req.params.id);
    if (!doc) { res.status(404).json({ error: 'Documento no encontrado' }); return; }

    const payRepo = AppDataSource.getRepository(PagoCompra);
    const { cuotas, condicion_pago, fecha_vencimiento } = req.body as {
      cuotas: { cuota_numero: number; valor: number; fecha_vencimiento: string; notas?: string }[];
      condicion_pago?: string;
      fecha_vencimiento?: string;
    };

    // Borrar cuotas previas no pagadas
    const existing = await payRepo.find({ where: { documento_tipo: req.params.tipo, documento_id: req.params.id } });
    const unpaid = existing.filter(p => !p.esta_pagado);
    if (unpaid.length) await payRepo.remove(unpaid);

    const created = await payRepo.save(
      cuotas.map(c => payRepo.create({
        documento_tipo:    req.params.tipo as DocumentoCompraTipo,
        documento_id:      req.params.id,
        company_id:        cid,
        cuota_numero:      c.cuota_numero,
        tipo:              (c.cuota_numero === 0 ? 'abono' : 'cuota') as TipoPagoCompra,
        valor:             c.valor,
        fecha_vencimiento: c.fecha_vencimiento,
        notas:             c.notas,
        esta_pagado:       false,
      }))
    );

    const updates: Record<string, unknown> = {};
    if (condicion_pago) updates.condicion_pago = condicion_pago;
    if (fecha_vencimiento) updates.fecha_vencimiento = fecha_vencimiento;
    if (cuotas.length) updates.numero_cuotas = cuotas.length;
    if (Object.keys(updates).length) await guardarDocumento(req.params.tipo, doc, updates);

    res.status(201).json(created);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error guardando cuotas' });
  }
});

/** Marcar cuota como pagada (o desmarcar) */
router.put('/cartera/pagos/:pid', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const payRepo = AppDataSource.getRepository(PagoCompra);
    const payment = await payRepo.findOne({ where: { id: req.params.pid } });
    if (!payment) { res.status(404).json({ error: 'Pago no encontrado' }); return; }

    const doc = await findDocumento(req.user!.companyId, payment.documento_tipo, payment.documento_id);
    if (!doc) { res.status(403).json({ error: 'Sin permiso' }); return; }

    const { esta_pagado, fecha_pago, notas, valor_pagado, valor, medio_pago_id } = req.body as {
      esta_pagado: boolean; fecha_pago?: string; notas?: string; valor_pagado?: number; valor?: number; medio_pago_id?: string;
    };
    payment.esta_pagado  = esta_pagado;
    payment.fecha_pago   = esta_pagado ? (fecha_pago || new Date().toISOString().slice(0, 10)) : undefined;
    payment.valor_pagado = esta_pagado && valor_pagado != null ? valor_pagado : undefined;
    if (notas !== undefined) payment.notas = notas;
    if (valor !== undefined) payment.valor = valor;
    if (medio_pago_id !== undefined) payment.medio_pago_id = medio_pago_id;
    await payRepo.save(payment);

    await recalcEstadoPagoCompra(payment.documento_tipo, payment.documento_id);

    res.json(payment);
  } catch (e) {
    res.status(500).json({ error: 'Error actualizando pago' });
  }
});

router.delete('/cartera/pagos/:pid', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const payRepo = AppDataSource.getRepository(PagoCompra);
    const payment = await payRepo.findOne({ where: { id: req.params.pid } });
    if (!payment) { res.status(404).json({ error: 'Pago no encontrado' }); return; }
    const doc = await findDocumento(req.user!.companyId, payment.documento_tipo, payment.documento_id);
    if (!doc) { res.status(403).json({ error: 'Sin permiso' }); return; }
    const { documento_tipo, documento_id } = payment;
    await payRepo.remove(payment);
    await recalcEstadoPagoCompra(documento_tipo, documento_id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando pago' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: recalcular total_pagado y estado_pago de un documento de compra
// ─────────────────────────────────────────────────────────────────────────────
async function recalcEstadoPagoCompra(tipo: DocumentoCompraTipo, documentoId: string): Promise<void> {
  const payRepo = AppDataSource.getRepository(PagoCompra);
  const payments = await payRepo.find({ where: { documento_tipo: tipo, documento_id: documentoId } });

  const totalPagado = payments.filter(p => p.esta_pagado).reduce(
    (s, p) => s + +(p.valor_pagado != null ? p.valor_pagado : p.valor), 0
  );
  const allPaid = payments.length > 0 && payments.every(p => p.esta_pagado);
  const anyPaid = payments.some(p => p.esta_pagado);

  let estadoPago = 'pendiente';

  if (tipo === 'factura_compra') {
    const repo = AppDataSource.getRepository(FacturaCompra);
    const doc = await repo.findOneOrFail({ where: { id: documentoId } });
    if (allPaid || totalPagado >= +doc.total * 0.999) estadoPago = 'pagada';
    else if (anyPaid) estadoPago = 'parcial';
    await repo.save({ ...doc, total_pagado: totalPagado, estado_pago: estadoPago });
  } else {
    const repo = AppDataSource.getRepository(DocumentoSoporte);
    const doc = await repo.findOneOrFail({ where: { id: documentoId } });
    if (allPaid || totalPagado >= +doc.total * 0.999) estadoPago = 'pagada';
    else if (anyPaid) estadoPago = 'parcial';
    await repo.save({ ...doc, total_pagado: totalPagado, estado_pago: estadoPago });
  }
}

export default router;
