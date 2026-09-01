import { Router, Response } from 'express';
import { AppDataSource } from '../config/database';
import { ListaPrecio }   from '../entities/ListaPrecio';
import { ProductoPrecio } from '../entities/ProductoPrecio';
import { Producto } from '../entities/Producto';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';

const router = Router();
router.use(authMiddleware);

const repo  = () => AppDataSource.getRepository(ListaPrecio);
const ppRepo = () => AppDataSource.getRepository(ProductoPrecio);

// GET /api/listas-precio
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const items = await repo().find({
      where: { company_id: cid },
      order: { es_defecto: 'DESC', nombre: 'ASC' },
    });
    res.json(items);
  } catch { res.status(500).json({ error: 'Error listando listas de precio' }); }
});

// GET /api/listas-precio/:id  (incluye precios de productos)
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const l = await repo().findOne({
      where: { id: req.params.id, company_id: req.user!.companyId },
      relations: ['precios', 'precios.producto'],
    });
    if (!l) { res.status(404).json({ error: 'Lista no encontrada' }); return; }
    res.json(l);
  } catch { res.status(500).json({ error: 'Error obteniendo lista de precio' }); }
});

// POST /api/listas-precio
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { nombre, descripcion, moneda_codigo, es_defecto, activo, fecha_inicio, fecha_fin, notas } = req.body;
    if (!nombre) { res.status(400).json({ error: 'El nombre es obligatorio' }); return; }

    // Si es_defecto=true, desmarcar las otras
    if (es_defecto) {
      await repo().update({ company_id: cid, es_defecto: true }, { es_defecto: false });
    }

    const l = repo().create({
      company_id: cid, nombre: nombre.trim(), descripcion,
      moneda_codigo: moneda_codigo || 'COP',
      es_defecto: !!es_defecto, activo: activo !== false,
      fecha_inicio: fecha_inicio || undefined,
      fecha_fin: fecha_fin || undefined,
      notas,
    });
    await repo().save(l);
    res.status(201).json(l);
  } catch { res.status(500).json({ error: 'Error creando lista de precio' }); }
});

// PUT /api/listas-precio/:id
router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const l = await repo().findOne({ where: { id: req.params.id, company_id: cid } });
    if (!l) { res.status(404).json({ error: 'Lista no encontrada' }); return; }

    if (req.body.es_defecto && !l.es_defecto) {
      await repo().update({ company_id: cid, es_defecto: true }, { es_defecto: false });
    }

    const allowed = ['nombre','descripcion','moneda_codigo','es_defecto','activo','fecha_inicio','fecha_fin','notas'];
    allowed.forEach(k => { if (req.body[k] !== undefined) (l as any)[k] = req.body[k]; });
    await repo().save(l);
    res.json(l);
  } catch { res.status(500).json({ error: 'Error actualizando lista de precio' }); }
});

// DELETE /api/listas-precio/:id (soft delete)
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const l = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!l) { res.status(404).json({ error: 'Lista no encontrada' }); return; }
    l.activo = false;
    await repo().save(l);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Error eliminando lista de precio' }); }
});

// ── Precios de productos dentro de una lista ──────────────────────────────────

// GET /api/listas-precio/:id/precios
router.get('/:id/precios', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const l = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!l) { res.status(404).json({ error: 'Lista no encontrada' }); return; }
    const precios = await ppRepo().find({
      where: { lista_precio_id: l.id },
      relations: ['producto'],
      order: { created_at: 'ASC' } as any,
    });
    res.json(precios);
  } catch { res.status(500).json({ error: 'Error obteniendo precios' }); }
});

// POST /api/listas-precio/:id/precios
router.post('/:id/precios', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const l = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!l) { res.status(404).json({ error: 'Lista no encontrada' }); return; }

    const { producto_id, precio, descuento_pct } = req.body;
    if (!producto_id || precio === undefined) {
      res.status(400).json({ error: 'producto_id y precio son obligatorios' }); return;
    }

    // Hallazgo critico #5 (auditoria 2026-08-31): antes se aceptaba
    // producto_id del body sin verificar que perteneciera a la misma
    // empresa (multi-tenant) que la lista de precio. Con solo conocer o
    // adivinar el uuid de un producto de otra empresa se podia insertar una
    // fila en producto_precios, y el GET de al lado (con relations:
    // ['producto']) devolvia nombre/codigo/precio_base de ese producto
    // ajeno -- fuga de informacion entre empresas.
    const prod = await AppDataSource.getRepository(Producto).findOne({
      where: { id: producto_id, company_id: req.user!.companyId },
    });
    if (!prod) { res.status(404).json({ error: 'Producto no encontrado' }); return; }

    // Upsert
    let pp = await ppRepo().findOne({ where: { lista_precio_id: l.id, producto_id } });
    if (pp) {
      pp.precio = parseFloat(precio);
      pp.descuento_pct = parseFloat(descuento_pct) || 0;
    } else {
      pp = ppRepo().create({
        lista_precio_id: l.id, producto_id,
        precio: parseFloat(precio),
        descuento_pct: parseFloat(descuento_pct) || 0,
      });
    }
    await ppRepo().save(pp);
    res.status(201).json(pp);
  } catch (e: any) {
    if (e?.message?.includes('UNIQUE')) {
      res.status(409).json({ error: 'Ya existe precio para ese producto en esta lista' }); return;
    }
    res.status(500).json({ error: 'Error guardando precio' });
  }
});

// DELETE /api/listas-precio/:id/precios/:ppId
router.delete('/:id/precios/:ppId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const l = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!l) { res.status(404).json({ error: 'Lista no encontrada' }); return; }
    const pp = await ppRepo().findOne({ where: { id: req.params.ppId, lista_precio_id: l.id } });
    if (!pp) { res.status(404).json({ error: 'Precio no encontrado' }); return; }
    await ppRepo().remove(pp);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Error eliminando precio' }); }
});

export default router;
