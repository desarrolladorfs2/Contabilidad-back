import { Router, Response } from 'express';
import { AppDataSource } from '../../config/database';
import { ConciliacionBancaria } from '../../entities/contabilidad/ConciliacionBancaria';
import { CuentaTesoreria } from '../../entities/tesoreria/CuentaTesoreria';
import { MovimientoTesoreria } from '../../entities/tesoreria/MovimientoTesoreria';
import { authMiddleware, requireRole, AuthRequest } from '../../middleware/auth.middleware';

const router = Router();
router.use(authMiddleware);

const repo      = () => AppDataSource.getRepository(ConciliacionBancaria);
const cuentaRepo = () => AppDataSource.getRepository(CuentaTesoreria);
const movRepo    = () => AppDataSource.getRepository(MovimientoTesoreria);

/**
 * Saldo según libros (sistema) de una cuenta a una fecha de corte:
 * saldo_inicial + movimientos conciliados con fecha <= fecha_corte.
 * Traslados: salen de la cuenta origen y entran a la cuenta destino.
 */
async function saldoLibrosAFecha(cuenta: CuentaTesoreria, fechaCorte: string): Promise<number> {
  let saldo = +cuenta.saldo_inicial;
  const movsOrigen = await movRepo().createQueryBuilder('m')
    .where('m.cuenta_id = :cid', { cid: cuenta.id })
    .andWhere('m.estado = :e', { e: 'conciliado' })
    .andWhere('m.fecha <= :fc', { fc: fechaCorte })
    .getMany();
  for (const m of movsOrigen) {
    if (m.tipo === 'ingreso') saldo += +m.valor;
    else if (m.tipo === 'egreso') saldo -= +m.valor;
    else if (m.tipo === 'traslado') saldo -= +m.valor;
  }
  const movsDestino = await movRepo().createQueryBuilder('m')
    .where('m.cuenta_destino_id = :cid', { cid: cuenta.id })
    .andWhere('m.estado = :e', { e: 'conciliado' })
    .andWhere('m.tipo = :t', { t: 'traslado' })
    .andWhere('m.fecha <= :fc', { fc: fechaCorte })
    .getMany();
  for (const m of movsDestino) saldo += +m.valor;
  return saldo;
}

// GET /api/tesoreria/conciliaciones?cuenta_id=&periodo=
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { cuenta_id, periodo } = req.query as Record<string, string>;
    const qb = repo().createQueryBuilder('c')
      .leftJoinAndSelect('c.cuenta', 'cuenta')
      .leftJoinAndSelect('c.cerrada_por', 'cerrada_por')
      .where('c.company_id = :cid', { cid })
      .orderBy('c.periodo', 'DESC');
    if (cuenta_id) qb.andWhere('c.cuenta_id = :cuenta_id', { cuenta_id });
    if (periodo)   qb.andWhere('c.periodo = :periodo', { periodo });
    const items = await qb.getMany();
    res.json(items);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error listando conciliaciones' });
  }
});

// GET /api/tesoreria/conciliaciones/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const c = await repo().findOne({
      where: { id: req.params.id, company_id: req.user!.companyId },
      relations: ['cuenta', 'cerrada_por'],
    });
    if (!c) { res.status(404).json({ error: 'Conciliación no encontrada' }); return; }
    const movimientos = await movRepo().find({ where: { conciliacion_id: c.id }, order: { fecha: 'ASC' } as any });
    res.json({ ...c, movimientos });
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo conciliación' });
  }
});

// POST /api/tesoreria/conciliaciones  (abrir/actualizar periodo en proceso)
router.post('/', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { cuenta_id, periodo, fecha_extracto, saldo_extracto, observaciones } = req.body;
    if (!cuenta_id || !periodo || !fecha_extracto || saldo_extracto === undefined) {
      res.status(400).json({ error: 'cuenta_id, periodo, fecha_extracto y saldo_extracto son obligatorios' }); return;
    }
    const cuenta = await cuentaRepo().findOne({ where: { id: cuenta_id, company_id: cid } });
    if (!cuenta) { res.status(404).json({ error: 'Cuenta no encontrada' }); return; }

    const saldo_libros = await saldoLibrosAFecha(cuenta, fecha_extracto);
    const diferencia = +saldo_extracto - saldo_libros;

    // Upsert: una conciliación por cuenta+periodo (indice unico)
    let c = await repo().findOne({ where: { cuenta_id, periodo, company_id: cid } });
    if (c) {
      if (c.estado === 'conciliada') { res.status(400).json({ error: 'Este período ya fue conciliado y cerrado' }); return; }
      Object.assign(c, { fecha_extracto, saldo_extracto: +saldo_extracto, saldo_libros, diferencia, observaciones });
    } else {
      c = repo().create({
        company_id: cid, cuenta_id, periodo, fecha_extracto,
        saldo_extracto: +saldo_extracto, saldo_libros, diferencia,
        estado: 'en_proceso', observaciones,
      });
    }
    await repo().save(c);
    res.status(201).json(c);
  } catch (e: any) {
    if (e?.message?.includes('UNIQUE')) {
      res.status(409).json({ error: 'Ya existe una conciliación para esa cuenta y período' }); return;
    }
    console.error(e);
    res.status(500).json({ error: 'Error creando la conciliación' });
  }
});

// PUT /api/tesoreria/conciliaciones/:id
router.put('/:id', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const c = await repo().findOne({ where: { id: req.params.id, company_id: cid } });
    if (!c) { res.status(404).json({ error: 'Conciliación no encontrada' }); return; }
    if (c.estado === 'conciliada') { res.status(400).json({ error: 'No se puede modificar una conciliación cerrada' }); return; }

    const cuenta = await cuentaRepo().findOne({ where: { id: c.cuenta_id, company_id: cid } });
    if (!cuenta) { res.status(404).json({ error: 'Cuenta no encontrada' }); return; }

    const { fecha_extracto, saldo_extracto, observaciones } = req.body;
    if (fecha_extracto !== undefined) c.fecha_extracto = fecha_extracto;
    if (saldo_extracto !== undefined) c.saldo_extracto = +saldo_extracto;
    if (observaciones !== undefined) c.observaciones = observaciones;

    c.saldo_libros = await saldoLibrosAFecha(cuenta, c.fecha_extracto);
    c.diferencia   = +c.saldo_extracto - c.saldo_libros;

    await repo().save(c);
    res.json(c);
  } catch (e) {
    res.status(500).json({ error: 'Error actualizando la conciliación' });
  }
});

// POST /api/tesoreria/conciliaciones/:id/cerrar
router.post('/:id/cerrar', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const c = await repo().findOne({ where: { id: req.params.id, company_id: cid } });
    if (!c) { res.status(404).json({ error: 'Conciliación no encontrada' }); return; }
    if (c.estado === 'conciliada') { res.status(400).json({ error: 'Esta conciliación ya está cerrada' }); return; }

    const forzar = !!req.body?.forzar;
    if (Math.abs(+c.diferencia) > 0.01 && !forzar) {
      res.status(400).json({
        error: 'La diferencia entre el saldo del extracto y el saldo en libros no es cero. Ajusta los movimientos pendientes o cierra forzando la diferencia.',
        diferencia: c.diferencia,
      });
      return;
    }

    // Vincular los movimientos conciliados de esta cuenta hasta la fecha del extracto que aun no pertenecen a otra conciliacion
    await movRepo().createQueryBuilder()
      .update(MovimientoTesoreria)
      .set({ conciliacion_id: c.id })
      .where('cuenta_id = :cid', { cid: c.cuenta_id })
      .andWhere('estado = :e', { e: 'conciliado' })
      .andWhere('fecha <= :fc', { fc: c.fecha_extracto })
      .andWhere('conciliacion_id IS NULL')
      .execute();

    c.estado = 'conciliada';
    c.cerrada_por_id = req.user!.id;
    c.fecha_cierre = new Date().toISOString().slice(0, 10);
    if (req.body?.observaciones) c.observaciones = req.body.observaciones;
    await repo().save(c);
    res.json(c);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error cerrando la conciliación' });
  }
});

// POST /api/tesoreria/conciliaciones/:id/reabrir
router.post('/:id/reabrir', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const c = await repo().findOne({ where: { id: req.params.id, company_id: cid } });
    if (!c) { res.status(404).json({ error: 'Conciliación no encontrada' }); return; }
    if (c.estado !== 'conciliada') { res.status(400).json({ error: 'Esta conciliación no está cerrada' }); return; }

    await movRepo().update({ conciliacion_id: c.id } as any, { conciliacion_id: undefined as any });
    c.estado = 'en_proceso';
    c.cerrada_por_id = undefined;
    c.fecha_cierre = undefined;
    await repo().save(c);
    res.json(c);
  } catch (e) {
    res.status(500).json({ error: 'Error reabriendo la conciliación' });
  }
});

// DELETE /api/tesoreria/conciliaciones/:id  (solo si sigue en proceso)
router.delete('/:id', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const c = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!c) { res.status(404).json({ error: 'Conciliación no encontrada' }); return; }
    if (c.estado === 'conciliada') { res.status(400).json({ error: 'No se puede eliminar una conciliación cerrada. Reábrela primero.' }); return; }
    await repo().remove(c);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando la conciliación' });
  }
});

export default router;
