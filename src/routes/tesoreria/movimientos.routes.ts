import { Router, Response } from 'express';
import { AppDataSource } from '../../config/database';
import { MovimientoTesoreria } from '../../entities/tesoreria/MovimientoTesoreria';
import { CuentaTesoreria } from '../../entities/tesoreria/CuentaTesoreria';
import { authMiddleware, requireRole, AuthRequest } from '../../middleware/auth.middleware';

const router = Router();
router.use(authMiddleware);

const repo      = () => AppDataSource.getRepository(MovimientoTesoreria);
const cuentaRepo = () => AppDataSource.getRepository(CuentaTesoreria);

async function recalcSaldo(cuentaId: string): Promise<void> {
  const cuenta = await cuentaRepo().findOne({ where: { id: cuentaId } });
  if (!cuenta) return;
  const movs = await repo().find({ where: { cuenta_id: cuentaId, estado: 'conciliado' as any } });
  let saldo = +cuenta.saldo_inicial;
  for (const m of movs) {
    if (m.tipo === 'ingreso') saldo += +m.valor;
    else if (m.tipo === 'egreso') saldo -= +m.valor;
  }
  // saldo_actual removed - saldo calculado en tiempo real desde movimientos
}

// GET /api/tesoreria/movimientos
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { cuenta_id, tipo, estado, fecha_desde, fecha_hasta, categoria, q = '', page = '1', limit = '30' } = req.query as Record<string, string>;

    const base = repo().createQueryBuilder('m').where('m.company_id = :cid', { cid });
    if (cuenta_id)   base.andWhere('m.cuenta_id = :cuenta_id', { cuenta_id });
    if (tipo)        base.andWhere('m.tipo = :tipo', { tipo });
    if (estado)      base.andWhere('m.estado = :estado', { estado });
    if (fecha_desde) base.andWhere('m.fecha >= :fd', { fd: fecha_desde });
    if (fecha_hasta) base.andWhere('m.fecha <= :fh', { fh: fecha_hasta });
    if (categoria)   base.andWhere('m.categoria = :categoria', { categoria });
    if (q)           base.andWhere('(m.concepto LIKE :q OR m.referencia LIKE :q OR m.tercero_nit LIKE :q)', { q: `%${q}%` });

    const [items, total] = await base.clone()
      .orderBy('m.fecha', 'DESC')
      .addOrderBy('m.created_at', 'DESC')
      .skip((+page - 1) * +limit)
      .take(+limit)
      .getManyAndCount();

    // Agregados filtrados por el mismo período/cuenta
    const agg = await base.clone()
      .select('m.tipo', 'tipo')
      .addSelect('m.estado', 'estado')
      .addSelect('COALESCE(SUM(CAST(m.valor AS FLOAT)), 0)', 'suma')
      .groupBy('m.tipo')
      .addGroupBy('m.estado')
      .getRawMany<{ tipo: string; estado: string; suma: string }>();

    let total_ingresos = 0, total_egresos = 0, pendientes = 0;
    for (const row of agg) {
      if (row.tipo === 'ingreso') total_ingresos += +row.suma;
      if (row.tipo === 'egreso')  total_egresos  += +row.suma;
      if (row.estado === 'pendiente') pendientes++;
    }
    // pendientes = count de movimientos con estado pendiente en el filtro
    const pendientesCount = await base.clone()
      .andWhere('m.estado = :ep', { ep: 'pendiente' })
      .getCount();

    res.json({
      items,
      total,
      page:  +page,
      limit: +limit,
      agregados: {
        total_ingresos,
        total_egresos,
        pendientes: pendientesCount,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error listando movimientos' });
  }
});

// GET /api/tesoreria/movimientos/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const mov = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!mov) { res.status(404).json({ error: 'Movimiento no encontrado' }); return; }
    res.json(mov);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo movimiento' });
  }
});

// POST /api/tesoreria/movimientos
router.post('/', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const cuenta = await cuentaRepo().findOne({ where: { id: req.body.cuenta_id, company_id: cid } });
    if (!cuenta) { res.status(404).json({ error: 'Cuenta no encontrada' }); return; }
    const mov = Object.assign(new MovimientoTesoreria(), { ...req.body, company_id: cid });
    await repo().save(mov);
    if (mov.estado === 'conciliado') await recalcSaldo(mov.cuenta_id);
    res.status(201).json(mov);
  } catch (e) {
    res.status(500).json({ error: 'Error creando movimiento' });
  }
});

// PUT /api/tesoreria/movimientos/:id
router.put('/:id', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const mov = await repo().findOne({ where: { id: req.params.id, company_id: cid } });
    if (!mov) { res.status(404).json({ error: 'Movimiento no encontrado' }); return; }
    if (mov.estado === 'conciliado') { res.status(400).json({ error: 'No se puede modificar un movimiento conciliado' }); return; }
    const prevCuentaId = mov.cuenta_id;
    Object.assign(mov, req.body);
    await repo().save(mov);
    await recalcSaldo(prevCuentaId);
    if (mov.cuenta_id !== prevCuentaId) await recalcSaldo(mov.cuenta_id);
    res.json(mov);
  } catch (e) {
    res.status(500).json({ error: 'Error actualizando movimiento' });
  }
});

// POST /api/tesoreria/movimientos/:id/conciliar
router.post('/:id/conciliar', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const mov = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!mov) { res.status(404).json({ error: 'Movimiento no encontrado' }); return; }
    mov.estado = 'conciliado';
    await repo().save(mov);
    await recalcSaldo(mov.cuenta_id);
    res.json(mov);
  } catch (e) {
    res.status(500).json({ error: 'Error conciliando movimiento' });
  }
});

// POST /api/tesoreria/movimientos/conciliar-lote
router.post('/conciliar-lote', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { ids = [], crear = [] } = req.body as { ids: string[]; crear: any[] };
    const cuentasAfectadas = new Set<string>();

    let conciliados = 0;
    for (const id of ids) {
      const mov = await repo().findOne({ where: { id, company_id: cid } });
      if (mov && mov.estado !== 'conciliado') {
        mov.estado = 'conciliado';
        await repo().save(mov);
        cuentasAfectadas.add(mov.cuenta_id);
        conciliados++;
      }
    }

    let creados = 0;
    for (const dto of crear) {
      const cuenta = await cuentaRepo().findOne({ where: { id: dto.cuenta_id, company_id: cid } });
      if (!cuenta) continue;
      const mov = Object.assign(new MovimientoTesoreria(), { ...dto, company_id: cid, estado: 'conciliado' });
      await repo().save(mov);
      cuentasAfectadas.add(mov.cuenta_id);
      creados++;
    }

    for (const cuentaId of cuentasAfectadas) {
      await recalcSaldo(cuentaId);
    }

    res.json({ ok: true, conciliados, creados });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error en conciliacion por lote' });
  }
});

// DELETE /api/tesoreria/movimientos/:id
router.delete('/:id', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const mov = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!mov) { res.status(404).json({ error: 'Movimiento no encontrado' }); return; }
    if (mov.estado === 'conciliado') { res.status(400).json({ error: 'No se puede eliminar un movimiento conciliado' }); return; }
    const cuentaId = mov.cuenta_id;
    await repo().remove(mov);
    await recalcSaldo(cuentaId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando movimiento' });
  }
});

export default router;
