import { Router, Response } from 'express';
import { AppDataSource } from '../config/database';
import { Factura } from '../entities/Invoice';
import { PagoFactura, TipoPagoFactura } from '../entities/InvoicePayment';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';

const router = Router();
router.use(authMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// CARTERA
// GET /api/ventas/cartera?status=pendiente|parcial|pagada&overdue=true
// ─────────────────────────────────────────────────────────────────────────────
router.get('/cartera', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { status, overdue, page = '1', limit = '50', search } = req.query as Record<string, string>;

    const qb = AppDataSource.getRepository(Factura)
      .createQueryBuilder('inv')
      .where('inv.company_id = :cid', { cid })
      .andWhere("inv.estado IN ('aprobada','aceptada')")
      .orderBy('inv.fecha_vencimiento', 'ASC')
      .addOrderBy('inv.fecha_emision', 'DESC');

    if (status) qb.andWhere('inv.estado_pago = :ps', { ps: status });
    if (search) qb.andWhere(
      '(inv.numero_factura LIKE :s OR inv.cliente_nombre LIKE :s OR inv.cliente_nit LIKE :s)',
      { s: `%${search}%` }
    );

    const today = new Date().toISOString().slice(0, 10);
    if (overdue === 'true') {
      qb.andWhere("inv.estado_pago != 'pagada'")
        .andWhere('inv.fecha_vencimiento < :today', { today });
    }

    qb.skip((+page - 1) * +limit).take(+limit);
    const [items, total] = await qb.getManyAndCount();

    // Adjuntar cuotas a cada factura
    const payRepo = AppDataSource.getRepository(PagoFactura);
    const ids = items.map(i => i.id);
    let payments: PagoFactura[] = [];
    if (ids.length) {
      payments = await payRepo
        .createQueryBuilder('p')
        .where('p.factura_id IN (:...ids)', { ids })
        .orderBy('p.cuota_numero', 'ASC')
        .getMany();
    }
    const paymentsMap = new Map<string, PagoFactura[]>();
    for (const p of payments) {
      const arr = paymentsMap.get(p.factura_id) ?? [];
      arr.push(p);
      paymentsMap.set(p.factura_id, arr);
    }

    const result = items.map(inv => ({
      ...inv,
      payments: paymentsMap.get(inv.id) ?? [],
      is_overdue: inv.fecha_vencimiento
        ? inv.estado_pago !== 'pagada' && inv.fecha_vencimiento < today
        : false,
      days_overdue: inv.fecha_vencimiento && inv.estado_pago !== 'pagada'
        ? Math.max(0, Math.floor((Date.now() - new Date(inv.fecha_vencimiento).getTime()) / 86400000))
        : 0,
    }));

    res.json({ items: result, total, page: +page, limit: +limit });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error cargando cartera' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// RESUMEN CARTERA (para dashboard de ventas)
// GET /api/ventas/resumen
// ─────────────────────────────────────────────────────────────────────────────
router.get('/resumen', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid   = req.user!.companyId;
    const today = new Date().toISOString().slice(0, 10);

    const rows = await AppDataSource.getRepository(Factura)
      .createQueryBuilder('inv')
      .select('inv.estado_pago', 'estado_pago')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(CAST(inv.total AS FLOAT)), 0)', 'total')
      .addSelect('COALESCE(SUM(CAST(inv.total_pagado AS FLOAT)), 0)', 'total_pagado')
      .where('inv.company_id = :cid', { cid })
      .andWhere("inv.estado IN ('aprobada','aceptada')")
      .groupBy('inv.estado_pago')
      .getRawMany<{ estado_pago: string; count: string; total: string; total_pagado: string }>();

    const overdueCount = await AppDataSource.getRepository(Factura)
      .createQueryBuilder('inv')
      .where('inv.company_id = :cid', { cid })
      .andWhere("inv.estado IN ('aprobada','aceptada')")
      .andWhere("inv.estado_pago != 'pagada'")
      .andWhere('inv.fecha_vencimiento < :today', { today })
      .getCount();

    const summary: Record<string, { count: number; total: number; pendiente: number }> = {};
    for (const r of rows) {
      summary[r.estado_pago] = {
        count: +r.count,
        total: +r.total,
        pendiente: +r.total - +r.total_pagado,
      };
    }

    res.json({ summary, overdue_count: overdueCount });
  } catch (e) {
    res.status(500).json({ error: 'Error cargando resumen' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PAGOS / CUOTAS POR FACTURA
// GET  /api/ventas/facturas/:id/pagos
// POST /api/ventas/facturas/:id/pagos   (crear cuotas en lote)
// PUT  /api/ventas/pagos/:pid           (marcar como pagada)
// DELETE /api/ventas/pagos/:pid
// ─────────────────────────────────────────────────────────────────────────────

router.get('/facturas/:id/pagos', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const inv = await AppDataSource.getRepository(Factura).findOne({
      where: { id: req.params.id, company_id: req.user!.companyId },
    });
    if (!inv) { res.status(404).json({ error: 'Factura no encontrada' }); return; }

    const payments = await AppDataSource.getRepository(PagoFactura).find({
      where: { factura_id: req.params.id },
      order: { cuota_numero: 'ASC', fecha_vencimiento: 'ASC' },
    });
    res.json(payments);
  } catch (e) {
    res.status(500).json({ error: 'Error cargando pagos' });
  }
});

/** Crear o reemplazar cuotas de una factura */
router.post('/facturas/:id/pagos', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const inv = await AppDataSource.getRepository(Factura).findOne({
      where: { id: req.params.id, company_id: req.user!.companyId },
    });
    if (!inv) { res.status(404).json({ error: 'Factura no encontrada' }); return; }

    const payRepo = AppDataSource.getRepository(PagoFactura);
    const { cuotas, condicion_pago, medio_pago, fecha_vencimiento } = req.body as {
      cuotas: { cuota_numero: number; valor: number; fecha_vencimiento: string; notas?: string }[];
      condicion_pago?: string;
      medio_pago?: string;
      fecha_vencimiento?: string;
    };

    // Borrar cuotas previas no pagadas
    const existing = await payRepo.find({ where: { factura_id: inv.id } });
    const unpaid   = existing.filter(p => !p.esta_pagado);
    if (unpaid.length) await payRepo.remove(unpaid);

    // Crear nuevas cuotas
    const created = await payRepo.save(
      cuotas.map(c => payRepo.create({
        factura_id:       inv.id,
        company_id:       req.user!.companyId,
        cuota_numero:     c.cuota_numero,
        tipo:             (c.cuota_numero === 0 ? 'abono' : 'cuota') as TipoPagoFactura,
        valor:            c.valor,
        fecha_vencimiento: c.fecha_vencimiento,
        notas:            c.notas,
        esta_pagado:      false,
      }))
    );

    // Actualizar campos de pago en la factura
    const updates: Partial<Factura> = {};
    if (condicion_pago)    updates.condicion_pago    = condicion_pago;
    if (medio_pago)        updates.medio_pago        = medio_pago;
    if (fecha_vencimiento) updates.fecha_vencimiento = fecha_vencimiento;
    if (cuotas.length)     updates.numero_cuotas     = cuotas.length;
    await AppDataSource.getRepository(Factura).save({ ...inv, ...updates });

    res.status(201).json(created);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error guardando cuotas' });
  }
});

/** Marcar cuota como pagada (o desmarcar) */
router.put('/pagos/:pid', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const payRepo = AppDataSource.getRepository(PagoFactura);
    const payment = await payRepo.findOne({ where: { id: req.params.pid } });
    if (!payment) { res.status(404).json({ error: 'Pago no encontrado' }); return; }

    const inv = await AppDataSource.getRepository(Factura).findOne({
      where: { id: payment.factura_id, company_id: req.user!.companyId },
    });
    if (!inv) { res.status(403).json({ error: 'Sin permiso' }); return; }

    const { esta_pagado, fecha_pago, notas, valor_pagado, valor } = req.body as {
      esta_pagado: boolean; fecha_pago?: string; notas?: string; valor_pagado?: number; valor?: number;
    };
    payment.esta_pagado  = esta_pagado;
    payment.fecha_pago   = esta_pagado ? (fecha_pago || new Date().toISOString().slice(0, 10)) : undefined;
    payment.valor_pagado = esta_pagado && valor_pagado != null ? valor_pagado : undefined;
    if (notas !== undefined) payment.notas = notas;
    if (valor !== undefined) payment.valor = valor;
    await payRepo.save(payment);

    // Recalcular total_pagado y estado_pago de la factura
    await recalcEstadoPago(inv.id);

    res.json(payment);
  } catch (e) {
    res.status(500).json({ error: 'Error actualizando pago' });
  }
});

router.delete('/pagos/:pid', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const payRepo = AppDataSource.getRepository(PagoFactura);
    const payment = await payRepo.findOne({ where: { id: req.params.pid } });
    if (!payment) { res.status(404).json({ error: 'Pago no encontrado' }); return; }
    const inv = await AppDataSource.getRepository(Factura).findOne({
      where: { id: payment.factura_id, company_id: req.user!.companyId },
    });
    if (!inv) { res.status(403).json({ error: 'Sin permiso' }); return; }
    const facturaId = payment.factura_id;
    await payRepo.remove(payment);
    await recalcEstadoPago(facturaId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando pago' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: recalcular total_pagado y estado_pago de una factura
// ─────────────────────────────────────────────────────────────────────────────
async function recalcEstadoPago(facturaId: string): Promise<void> {
  const invRepo  = AppDataSource.getRepository(Factura);
  const payRepo  = AppDataSource.getRepository(PagoFactura);
  const inv      = await invRepo.findOneOrFail({ where: { id: facturaId } });
  const payments = await payRepo.find({ where: { factura_id: facturaId } });

  // Usar valor_pagado si fue registrado, si no usar valor planificado
  const totalPagado = payments.filter(p => p.esta_pagado).reduce(
    (s, p) => s + +(p.valor_pagado != null ? p.valor_pagado : p.valor), 0
  );
  const allPaid   = payments.length > 0 && payments.every(p => p.esta_pagado);
  const anyPaid   = payments.some(p => p.esta_pagado);

  let estadoPago = 'pendiente';
  if (allPaid || totalPagado >= +inv.total * 0.999) estadoPago = 'pagada';
  else if (anyPaid) estadoPago = 'parcial';

  await invRepo.save({ ...inv, total_pagado: totalPagado, estado_pago: estadoPago });
}

export default router;
