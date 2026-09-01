import { Router, Response } from 'express';
import { AppDataSource } from '../../config/database';
import { CuentaTesoreria } from '../../entities/tesoreria/CuentaTesoreria';
import { MovimientoTesoreria } from '../../entities/tesoreria/MovimientoTesoreria';
import { authMiddleware, requireRole, AuthRequest } from '../../middleware/auth.middleware';

const router = Router();
router.use(authMiddleware);

const repo = () => AppDataSource.getRepository(CuentaTesoreria);
const movRepo = () => AppDataSource.getRepository(MovimientoTesoreria);

async function recalcSaldo(cuentaId: string): Promise<void> {
  const cuenta = await repo().findOne({ where: { id: cuentaId } });
  if (!cuenta) return;
  const movs = await movRepo().find({ where: { cuenta_id: cuentaId, estado: 'conciliado' as any } });
  let saldo = +cuenta.saldo_inicial;
  for (const m of movs) {
    if (m.tipo === 'ingreso') saldo += +m.valor;
    else if (m.tipo === 'egreso') saldo -= +m.valor;
  }
  // saldo_actual removed - saldo calculado en tiempo real desde movimientos
}

/**
 * Calcula el saldo actual de una cuenta en tiempo real, sin persistirlo:
 * saldo_inicial + movimientos conciliados (ingreso suma, egreso resta,
 * traslado sale de la cuenta origen y entra a la cuenta destino).
 */
async function calcularSaldoActual(cuenta: CuentaTesoreria): Promise<number> {
  let saldo = +cuenta.saldo_inicial;
  const movsOrigen = await movRepo().find({ where: { cuenta_id: cuenta.id, estado: 'conciliado' as any } });
  for (const m of movsOrigen) {
    if (m.tipo === 'ingreso') saldo += +m.valor;
    else if (m.tipo === 'egreso') saldo -= +m.valor;
    else if (m.tipo === 'traslado') saldo -= +m.valor; // sale de esta cuenta hacia cuenta_destino_id
  }
  const movsDestino = await movRepo().find({ where: { cuenta_destino_id: cuenta.id, estado: 'conciliado' as any, tipo: 'traslado' as any } });
  for (const m of movsDestino) saldo += +m.valor;
  return saldo;
}

// GET /api/tesoreria/cuentas
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const cuentas = await repo().find({ where: { company_id: cid }, order: { nombre: 'ASC' } });
    // Agregar saldo_pendiente (movimientos no conciliados)
    const result = await Promise.all(cuentas.map(async c => {
      const movsPendientes = await movRepo().find({ where: { cuenta_id: c.id, estado: 'pendiente' as any } });
      let pendienteIngresos = 0; let pendienteEgresos = 0;
      for (const m of movsPendientes) {
        if (m.tipo === 'ingreso') pendienteIngresos += +m.valor;
        else pendienteEgresos += +m.valor;
      }
      const saldo_actual = await calcularSaldoActual(c);
      return { ...c, saldo_actual, pendiente_ingresos: pendienteIngresos, pendiente_egresos: pendienteEgresos };
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'Error listando cuentas' });
  }
});

// GET /api/tesoreria/cuentas/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const c = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!c) { res.status(404).json({ error: 'Cuenta no encontrada' }); return; }
    const saldo_actual = await calcularSaldoActual(c);
    res.json({ ...c, saldo_actual });
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo cuenta' });
  }
});

// POST /api/tesoreria/cuentas
router.post('/', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const cuenta = Object.assign(new CuentaTesoreria(), { ...req.body, company_id: cid });
    await repo().save(cuenta);
    res.status(201).json(cuenta);
  } catch (e) {
    res.status(500).json({ error: 'Error creando cuenta' });
  }
});

// PUT /api/tesoreria/cuentas/:id
router.put('/:id', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cuenta = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!cuenta) { res.status(404).json({ error: 'Cuenta no encontrada' }); return; }
    Object.assign(cuenta, req.body);
    await repo().save(cuenta);
    await recalcSaldo(cuenta.id);
    res.json(await repo().findOne({ where: { id: cuenta.id } }));
  } catch (e) {
    res.status(500).json({ error: 'Error actualizando cuenta' });
  }
});

// DELETE /api/tesoreria/cuentas/:id
router.delete('/:id', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cuenta = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!cuenta) { res.status(404).json({ error: 'Cuenta no encontrada' }); return; }
    const movCount = await movRepo().count({ where: { cuenta_id: cuenta.id } });
    if (movCount > 0) { res.status(400).json({ error: 'La cuenta tiene movimientos registrados' }); return; }
    await repo().remove(cuenta);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando cuenta' });
  }
});

export default router;
