import { Router, Response } from 'express';
import { In } from 'typeorm';
import { AppDataSource } from '../../config/database';
import { CentroCosto } from '../../entities/contabilidad/CentroCosto';
import { Sede } from '../../entities/contabilidad/Sede';
import { PresupuestoCentroCosto } from '../../entities/contabilidad/PresupuestoCentroCosto';
import { LineaAsiento } from '../../entities/contabilidad/LineaAsiento';
import { authMiddleware, requireRole, AuthRequest } from '../../middleware/auth.middleware';

const router = Router();
router.use(authMiddleware);

const repo = () => AppDataSource.getRepository(CentroCosto);
const sedeRepo = () => AppDataSource.getRepository(Sede);
const presupuestoRepo = () => AppDataSource.getRepository(PresupuestoCentroCosto);
const lineaAsientoRepo = () => AppDataSource.getRepository(LineaAsiento);

async function nextCodigo(cid: string): Promise<string> {
  const centros = await repo()
    .createQueryBuilder('c')
    .select('c.codigo', 'codigo')
    .where('c.company_id = :cid AND c.codigo LIKE :p', { cid, p: 'CC-%' })
    .getRawMany<{ codigo: string }>();
  let max = 0;
  for (const c of centros) {
    // Solo cuenta codigos que siguen estrictamente el patron "CC-NNN" — un codigo
    // personalizado (ej. "CC-VENTAS-BOG") no debe contarse como numero de secuencia
    // ni afectar el siguiente consecutivo — hallazgo #20.
    const m = /^CC-(\d+)$/.exec(c.codigo);
    if (!m) continue;
    const num = parseInt(m[1], 10);
    if (!isNaN(num) && num > max) max = num;
  }
  return `CC-${String(max + 1).padStart(3, '0')}`;
}

/** Agrega el arreglo `ciudades` (nombres de municipio unicos, derivados de las sedes asociadas) a cada centro. */
function conCiudadesDerivadas(item: CentroCosto): CentroCosto & { ciudades: string[] } {
  const ciudades = Array.from(
    new Set((item.sedes || []).map(s => s.municipio?.nombre).filter((n): n is string => !!n))
  );
  return { ...item, ciudades };
}

/**
 * Verifica que `padreId` no cree un ciclo: ni sea el propio centro, ni sea
 * (transitivamente) uno de sus descendientes.
 */
async function creariaCiclo(cid: string, centroId: string, padreId: string): Promise<boolean> {
  if (padreId === centroId) return true;
  const todos = await repo().find({ where: { company_id: cid }, select: ['id', 'padre_id'] });
  const hijosDe = new Map<string, string[]>();
  for (const c of todos) {
    if (!c.padre_id) continue;
    if (!hijosDe.has(c.padre_id)) hijosDe.set(c.padre_id, []);
    hijosDe.get(c.padre_id)!.push(c.id);
  }
  const stack = [...(hijosDe.get(centroId) || [])];
  while (stack.length) {
    const actual = stack.pop()!;
    if (actual === padreId) return true;
    stack.push(...(hijosDe.get(actual) || []));
  }
  return false;
}

// GET /api/contabilidad/centros-costo/next-codigo
router.get('/next-codigo', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json({ codigo: await nextCodigo(req.user!.companyId) });
  } catch (e) {
    res.status(500).json({ error: 'Error generando codigo' });
  }
});

// GET /api/contabilidad/centros-costo
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { q = '', activo } = req.query as Record<string, string>;
    const qb = repo()
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.sedes', 'sede')
      .leftJoinAndSelect('sede.municipio', 'municipio')
      .where('c.company_id = :cid', { cid })
      .orderBy('c.codigo', 'ASC');
    if (q) qb.andWhere('(c.codigo LIKE :q OR c.nombre LIKE :q OR sede.nombre LIKE :q OR municipio.nombre LIKE :q)', { q: `%${q}%` });
    if (activo !== undefined && activo !== '') qb.andWhere('c.activo = :a', { a: activo === 'true' });
    const items = await qb.getMany();
    res.json(items.map(conCiudadesDerivadas));
  } catch (e) {
    res.status(500).json({ error: 'Error listando centros de costo' });
  }
});

// POST /api/contabilidad/centros-costo
router.post('/', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const codigo = req.body.codigo?.trim() || await nextCodigo(cid);
    const existe = await repo().findOne({ where: { company_id: cid, codigo } });
    if (existe) { res.status(400).json({ error: `El codigo "${codigo}" ya existe` }); return; }
    if (!req.body.nombre?.trim()) {
      res.status(400).json({ error: 'El nombre es obligatorio' }); return;
    }
    const { sede_ids, ...body } = req.body;
    if (body.padre_id) {
      const padre = await repo().findOne({ where: { id: body.padre_id, company_id: cid } });
      if (!padre) { res.status(400).json({ error: 'El centro de costo padre seleccionado no existe' }); return; }
    }
    let sedes: Sede[] = [];
    if (Array.isArray(sede_ids) && sede_ids.length) {
      sedes = await sedeRepo().findBy({ id: In(sede_ids), company_id: cid });
      if (sedes.length !== sede_ids.length) {
        res.status(400).json({ error: 'Una o mas sedes seleccionadas no existen' }); return;
      }
    }
    const item = Object.assign(new CentroCosto(), { ...body, codigo, company_id: cid, activo: true, sedes });
    await repo().save(item);
    const guardado = await repo().findOne({ where: { id: item.id }, relations: ['sedes', 'sedes.municipio'] });
    res.status(201).json(conCiudadesDerivadas(guardado!));
  } catch (e) {
    res.status(500).json({ error: 'Error creando centro de costo' });
  }
});

// PUT /api/contabilidad/centros-costo/:id
router.put('/:id', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const item = await repo().findOne({ where: { id: req.params.id, company_id: cid } });
    if (!item) { res.status(404).json({ error: 'Centro de costo no encontrado' }); return; }
    if (req.body.codigo && req.body.codigo !== item.codigo) {
      const existe = await repo().findOne({ where: { company_id: cid, codigo: req.body.codigo } });
      if (existe) { res.status(400).json({ error: `El codigo "${req.body.codigo}" ya existe` }); return; }
    }
    const { sede_ids, ...body } = req.body;
    if (body.padre_id) {
      if (await creariaCiclo(cid, item.id, body.padre_id)) {
        res.status(400).json({ error: 'El centro de costo padre seleccionado generaria un ciclo en la jerarquia (no puede ser el mismo centro ni un descendiente suyo)' });
        return;
      }
      const padre = await repo().findOne({ where: { id: body.padre_id, company_id: cid } });
      if (!padre) { res.status(400).json({ error: 'El centro de costo padre seleccionado no existe' }); return; }
    }
    Object.assign(item, body);
    if (Array.isArray(sede_ids)) {
      if (sede_ids.length) {
        const sedes = await sedeRepo().findBy({ id: In(sede_ids), company_id: cid });
        if (sedes.length !== sede_ids.length) {
          res.status(400).json({ error: 'Una o mas sedes seleccionadas no existen' }); return;
        }
        item.sedes = sedes;
      } else {
        item.sedes = [];
      }
    }
    await repo().save(item);
    const guardado = await repo().findOne({ where: { id: item.id }, relations: ['sedes', 'sedes.municipio'] });
    res.json(conCiudadesDerivadas(guardado!));
  } catch (e) {
    res.status(500).json({ error: 'Error actualizando centro de costo' });
  }
});

// DELETE /api/contabilidad/centros-costo/:id
// Requiere ?confirmar_presupuestos=true si el centro tiene presupuestos asociados,
// ya que la relacion PresupuestoCentroCosto.centro_costo es onDelete: CASCADE y
// borrarían silenciosamente el historico presupuestal — hallazgo #21.
router.delete('/:id', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!item) { res.status(404).json({ error: 'Centro de costo no encontrado' }); return; }
    const tieneHijos = await repo().count({ where: { padre_id: item.id } });
    if (tieneHijos > 0) {
      res.status(400).json({ error: 'No se puede eliminar: este centro de costo tiene centros hijos asociados' });
      return;
    }
    const presupuestosCount = await presupuestoRepo().count({ where: { centro_costo_id: item.id } });
    // Hallazgo #25: además de los presupuestos (que se borran en cascada), avisar
    // cuántas líneas de asiento quedarán con el centro de costo vaciado (SET NULL),
    // perdiendo la trazabilidad de a qué CC pertenecía ese gasto/ingreso ya contabilizado.
    const asientosCount = await lineaAsientoRepo().count({ where: { centro_costo_id: item.id } });
    const confirmar = String((req.query as Record<string, string>).confirmar_presupuestos || '') === 'true';
    if ((presupuestosCount > 0 || asientosCount > 0) && !confirmar) {
      const partes: string[] = [];
      if (presupuestosCount > 0) partes.push(`${presupuestosCount} presupuesto(s) que se eliminarán permanentemente`);
      if (asientosCount > 0) partes.push(`${asientosCount} línea(s) de asiento contable que quedarán sin centro de costo asignado`);
      res.status(400).json({
        error: `Este centro de costo tiene ${partes.join(' y ')}. Repita la solicitud con ?confirmar_presupuestos=true para continuar.`,
        presupuestos_asociados: presupuestosCount,
        asientos_asociados: asientosCount,
      });
      return;
    }
    await repo().remove(item);
    res.json({ ok: true, presupuestos_eliminados: presupuestosCount, asientos_afectados: asientosCount });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando centro de costo' });
  }
});

export default router;
