import { Router, Response } from 'express';
import { AppDataSource } from '../../config/database';
import { CuentaPUC } from '../../entities/contabilidad/CuentaPUC';
import { authMiddleware, requireRole, AuthRequest } from '../../middleware/auth.middleware';

const NATURALEZA_POR_TIPO: Record<string, 'debito' | 'credito'> = {
  activo: 'debito', gasto: 'debito', costo: 'debito',
  pasivo: 'credito', patrimonio: 'credito', ingreso: 'credito',
  // 'orden' puede ser cualquiera de las dos según el contexto — no se valida.
};

/**
 * Valida los datos de una cuenta PUC antes de crear/actualizar — hallazgo #17:
 * código numérico, naturaleza coherente con el tipo, y padre_id existente en la
 * misma empresa (si se envía).
 */
async function validarCuenta(
  cid: string,
  data: { codigo?: string; tipo?: string; naturaleza?: string; padre_id?: string },
  idActual?: string,
): Promise<string | null> {
  if (data.codigo !== undefined && !/^\d+$/.test(String(data.codigo).trim())) {
    return 'El código de la cuenta debe ser numérico (ej: "1105")';
  }
  if (data.tipo && data.naturaleza) {
    const esperada = NATURALEZA_POR_TIPO[data.tipo];
    if (esperada && data.naturaleza !== esperada) {
      return `Una cuenta de tipo "${data.tipo}" debe tener naturaleza "${esperada}"`;
    }
  }
  if (data.padre_id) {
    const padre = await AppDataSource.getRepository(CuentaPUC)
      .findOne({ where: { id: data.padre_id, company_id: cid } });
    if (!padre) return 'La cuenta padre indicada no existe en esta empresa';
    if (idActual && padre.id === idActual) return 'Una cuenta no puede ser padre de sí misma';
    // Validación de jerarquía por prefijo — hallazgo #18: el código del hijo debe
    // empezar con el código del padre (convención estándar del PUC colombiano).
    if (data.codigo && !String(data.codigo).trim().startsWith(padre.codigo)) {
      return `El código "${data.codigo}" no es consistente con el de la cuenta padre "${padre.codigo}" (debe empezar con ese prefijo)`;
    }
  }
  return null;
}

const router = Router();
router.use(authMiddleware);

const repo = () => AppDataSource.getRepository(CuentaPUC);

// Seed PUC colombiano base
const PUC_BASE = [
  // Clase
  { codigo: '1', nombre: 'ACTIVO', tipo: 'activo', nivel: 1, naturaleza: 'debito' },
  { codigo: '2', nombre: 'PASIVO', tipo: 'pasivo', nivel: 1, naturaleza: 'credito' },
  { codigo: '3', nombre: 'PATRIMONIO', tipo: 'patrimonio', nivel: 1, naturaleza: 'credito' },
  { codigo: '4', nombre: 'INGRESOS', tipo: 'ingreso', nivel: 1, naturaleza: 'credito' },
  { codigo: '5', nombre: 'GASTOS', tipo: 'gasto', nivel: 1, naturaleza: 'debito' },
  { codigo: '6', nombre: 'COSTO DE VENTAS', tipo: 'costo', nivel: 1, naturaleza: 'debito' },
  { codigo: '7', nombre: 'COSTOS DE PRODUCCION', tipo: 'costo', nivel: 1, naturaleza: 'debito' },
  // Activos — Grupo
  { codigo: '11', nombre: 'EFECTIVO Y EQUIVALENTES', tipo: 'activo', nivel: 2, naturaleza: 'debito', codigo_padre: '1' },
  { codigo: '12', nombre: 'INVERSIONES E INSTRUMENTOS', tipo: 'activo', nivel: 2, naturaleza: 'debito', codigo_padre: '1' },
  { codigo: '13', nombre: 'DEUDORES COMERCIALES', tipo: 'activo', nivel: 2, naturaleza: 'debito', codigo_padre: '1' },
  { codigo: '15', nombre: 'PROPIEDADES PLANTA Y EQUIPO', tipo: 'activo', nivel: 2, naturaleza: 'debito', codigo_padre: '1' },
  { codigo: '16', nombre: 'INTANGIBLES', tipo: 'activo', nivel: 2, naturaleza: 'debito', codigo_padre: '1' },
  // Pasivos — Grupo
  { codigo: '21', nombre: 'OBLIGACIONES FINANCIERAS', tipo: 'pasivo', nivel: 2, naturaleza: 'credito', codigo_padre: '2' },
  { codigo: '22', nombre: 'PROVEEDORES', tipo: 'pasivo', nivel: 2, naturaleza: 'credito', codigo_padre: '2' },
  { codigo: '23', nombre: 'CUENTAS POR PAGAR', tipo: 'pasivo', nivel: 2, naturaleza: 'credito', codigo_padre: '2' },
  { codigo: '24', nombre: 'IMPUESTOS POR PAGAR', tipo: 'pasivo', nivel: 2, naturaleza: 'credito', codigo_padre: '2' },
  { codigo: '25', nombre: 'OBLIGACIONES LABORALES', tipo: 'pasivo', nivel: 2, naturaleza: 'credito', codigo_padre: '2' },
  // Patrimonio — Grupo
  { codigo: '31', nombre: 'CAPITAL SOCIAL', tipo: 'patrimonio', nivel: 2, naturaleza: 'credito', codigo_padre: '3' },
  { codigo: '36', nombre: 'RESULTADOS DEL EJERCICIO', tipo: 'patrimonio', nivel: 2, naturaleza: 'credito', codigo_padre: '3' },
  // Ingresos — Grupo
  { codigo: '41', nombre: 'INGRESOS OPERACIONALES', tipo: 'ingreso', nivel: 2, naturaleza: 'credito', codigo_padre: '4' },
  { codigo: '42', nombre: 'INGRESOS NO OPERACIONALES', tipo: 'ingreso', nivel: 2, naturaleza: 'credito', codigo_padre: '4' },
  // Gastos — Grupo
  { codigo: '51', nombre: 'GASTOS OPERACIONALES DE ADMINISTRACION', tipo: 'gasto', nivel: 2, naturaleza: 'debito', codigo_padre: '5' },
  { codigo: '52', nombre: 'GASTOS OPERACIONALES DE VENTAS', tipo: 'gasto', nivel: 2, naturaleza: 'debito', codigo_padre: '5' },
  { codigo: '53', nombre: 'GASTOS NO OPERACIONALES', tipo: 'gasto', nivel: 2, naturaleza: 'debito', codigo_padre: '5' },
  // Cuentas detalle importantes
  { codigo: '1105', nombre: 'CAJA GENERAL', tipo: 'activo', nivel: 3, naturaleza: 'debito', codigo_padre: '11' },
  { codigo: '1110', nombre: 'BANCOS', tipo: 'activo', nivel: 3, naturaleza: 'debito', codigo_padre: '11' },
  { codigo: '1305', nombre: 'CLIENTES', tipo: 'activo', nivel: 3, naturaleza: 'debito', codigo_padre: '13', requiere_tercero: true },
  { codigo: '1355', nombre: 'ANTICIPO A PROVEEDORES', tipo: 'activo', nivel: 3, naturaleza: 'debito', codigo_padre: '13' },
  { codigo: '2205', nombre: 'OBLIGACIONES CON EL ESTADO', tipo: 'pasivo', nivel: 3, naturaleza: 'credito', codigo_padre: '22' },
  { codigo: '2335', nombre: 'COSTOS Y GASTOS POR PAGAR', tipo: 'pasivo', nivel: 3, naturaleza: 'credito', codigo_padre: '23' },
  { codigo: '2365', nombre: 'RETENCION EN LA FUENTE', tipo: 'pasivo', nivel: 3, naturaleza: 'credito', codigo_padre: '24' },
  { codigo: '2367', nombre: 'IMPUESTO A LAS VENTAS POR PAGAR', tipo: 'pasivo', nivel: 3, naturaleza: 'credito', codigo_padre: '24' },
  { codigo: '2368', nombre: 'ICA POR PAGAR', tipo: 'pasivo', nivel: 3, naturaleza: 'credito', codigo_padre: '24' },
  { codigo: '4135', nombre: 'VENTAS DE SERVICIOS', tipo: 'ingreso', nivel: 3, naturaleza: 'credito', codigo_padre: '41', requiere_centro_costo: true },
  { codigo: '4175', nombre: 'VENTAS DE MERCANCIA', tipo: 'ingreso', nivel: 3, naturaleza: 'credito', codigo_padre: '41', requiere_centro_costo: true },
  { codigo: '5105', nombre: 'HONORARIOS', tipo: 'gasto', nivel: 3, naturaleza: 'debito', codigo_padre: '51', requiere_centro_costo: true },
  { codigo: '5110', nombre: 'SUELDOS Y SALARIOS', tipo: 'gasto', nivel: 3, naturaleza: 'debito', codigo_padre: '51', requiere_centro_costo: true },
  { codigo: '5115', nombre: 'PRESTACIONES SOCIALES', tipo: 'gasto', nivel: 3, naturaleza: 'debito', codigo_padre: '51', requiere_centro_costo: true },
  { codigo: '5135', nombre: 'SERVICIOS', tipo: 'gasto', nivel: 3, naturaleza: 'debito', codigo_padre: '51', requiere_centro_costo: true },
  { codigo: '5145', nombre: 'MANTENIMIENTO Y REPARACIONES', tipo: 'gasto', nivel: 3, naturaleza: 'debito', codigo_padre: '51', requiere_centro_costo: true },
  { codigo: '5195', nombre: 'DIVERSOS', tipo: 'gasto', nivel: 3, naturaleza: 'debito', codigo_padre: '51', requiere_centro_costo: true },
  { codigo: '6205', nombre: 'COMPRAS', tipo: 'costo', nivel: 3, naturaleza: 'debito', codigo_padre: '6', requiere_centro_costo: true },
];

// POST /api/contabilidad/puc/seed — crear PUC base para la empresa
router.post('/seed', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const existing = await repo().count({ where: { company_id: cid } });
    if (existing > 0) {
      res.json({ message: `El PUC ya tiene ${existing} cuentas. Use force=true para re-sembrar.`, existing });
      return;
    }
    // IMPORTANTE: la entidad CuentaPUC no tiene una columna "codigo_padre" — la
    // relación real es "padre_id" (uuid). PUC_BASE usa "codigo_padre" (texto) solo
    // como conveniencia de este seed; antes se pasaba tal cual a save() y TypeORM
    // lo descartaba en silencio, dejando el árbol del PUC completamente plano
    // (hallazgo #17/#18). Ahora se resuelve en dos pasadas: primero se insertan
    // todas las cuentas sin padre_id, luego se actualiza padre_id por código.
    const cuentasSinPadre = PUC_BASE.map(({ codigo_padre, ...c }) => ({
      ...c,
      company_id: cid,
      activa: true,
      requiere_tercero: (c as any).requiere_tercero ?? false,
      requiere_centro_costo: (c as any).requiere_centro_costo ?? false,
    }));
    const guardadas = await repo().save(cuentasSinPadre as any[]);
    const idPorCodigo = new Map(guardadas.map(c => [c.codigo, c.id]));

    const actualizaciones: Promise<unknown>[] = [];
    PUC_BASE.forEach((c, i) => {
      if (c.codigo_padre) {
        const padreId = idPorCodigo.get(c.codigo_padre);
        const propiaId = guardadas[i].id;
        if (padreId) {
          actualizaciones.push(repo().update({ id: propiaId }, { padre_id: padreId }));
        }
      }
    });
    await Promise.all(actualizaciones);

    res.json({ message: `PUC sembrado con ${guardadas.length} cuentas`, count: guardadas.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error sembrando PUC' });
  }
});

// GET /api/contabilidad/puc?q=&tipo=&nivel=
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { q = '', tipo, nivel } = req.query as Record<string, string>;
    const qb = repo()
      .createQueryBuilder('c')
      .where('c.company_id = :cid', { cid })
      .orderBy('c.codigo', 'ASC');
    if (q) qb.andWhere('(c.codigo LIKE :q OR c.nombre LIKE :q)', { q: `%${q}%` });
    if (tipo) qb.andWhere('c.tipo = :tipo', { tipo });
    if (nivel) qb.andWhere('c.nivel = :nivel', { nivel: +nivel });
    const items = await qb.getMany();
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: 'Error listando PUC' });
  }
});

// GET /api/contabilidad/puc/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!item) { res.status(404).json({ error: 'Cuenta no encontrada' }); return; }
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo cuenta' });
  }
});

// POST /api/contabilidad/puc
router.post('/', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const error = await validarCuenta(cid, req.body);
    if (error) { res.status(400).json({ error }); return; }
    const cuenta = repo().create({ ...req.body, company_id: cid });
    await repo().save(cuenta);
    res.status(201).json(cuenta);
  } catch (e) {
    res.status(500).json({ error: 'Error creando cuenta' });
  }
});

// PUT /api/contabilidad/puc/:id
router.put('/:id', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const cuenta = await repo().findOne({ where: { id: req.params.id, company_id: cid } });
    if (!cuenta) { res.status(404).json({ error: 'Cuenta no encontrada' }); return; }
    const merged = { ...cuenta, ...req.body };
    const error = await validarCuenta(cid, merged, cuenta.id);
    if (error) { res.status(400).json({ error }); return; }
    Object.assign(cuenta, req.body);
    await repo().save(cuenta);
    res.json(cuenta);
  } catch (e) {
    res.status(500).json({ error: 'Error actualizando cuenta' });
  }
});

// DELETE /api/contabilidad/puc/:id
router.delete('/:id', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cuenta = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!cuenta) { res.status(404).json({ error: 'Cuenta no encontrada' }); return; }
    await repo().remove(cuenta);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando cuenta' });
  }
});

export default router;
