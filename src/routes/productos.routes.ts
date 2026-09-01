import { Router, Response } from 'express';
import { AppDataSource } from '../config/database';
import { Producto } from '../entities/Producto';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';

const router = Router();
router.use(authMiddleware);

const repo = () => AppDataSource.getRepository(Producto);

// GET /api/productos?q=&tipo=&activo=
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { q = '', tipo, activo } = req.query as Record<string, string>;

    const qb = repo()
      .createQueryBuilder('p')
      .where('p.company_id = :cid', { cid })
      .orderBy('p.nombre', 'ASC');

    if (q) {
      qb.andWhere('(p.nombre LIKE :q OR p.codigo LIKE :q OR p.descripcion LIKE :q)', { q: `%${q}%` });
    }
    if (tipo) qb.andWhere('p.tipo = :tipo', { tipo });
    if (activo !== undefined && activo !== '') {
      qb.andWhere('p.activo = :activo', { activo: activo === 'true' ? 1 : 0 });
    }

    const items = await qb.getMany();
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: 'Error listando productos' });
  }
});

// GET /api/productos/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const p = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!p) { res.status(404).json({ error: 'Producto no encontrado' }); return; }
    res.json(p);
  } catch {
    res.status(500).json({ error: 'Error obteniendo producto' });
  }
});

// POST /api/productos
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const {
      codigo, tipo, nombre, descripcion,
      unidad_medida_codigo, precio_base,
      tipo_tributo_codigo, tarifa_iva, tarifa_inc,
      codigo_unspsc, codigo_partida_arancelaria,
      cuenta_venta, cuenta_costo, notas,
    } = req.body;

    if (!codigo || !nombre) {
      res.status(400).json({ error: 'Código y nombre son obligatorios' }); return;
    }

    const p = repo().create({
      company_id: cid,
      codigo: codigo.trim().toUpperCase(),
      tipo: tipo || 'servicio',
      nombre: nombre.trim(),
      descripcion,
      unidad_medida_codigo: unidad_medida_codigo || 'EA',
      precio_base: parseFloat(precio_base) || 0,
      tipo_tributo_codigo: tipo_tributo_codigo || 'ZZ',
      tarifa_iva: parseFloat(tarifa_iva) || 0,
      tarifa_inc: parseFloat(tarifa_inc) || 0,
      codigo_unspsc,
      codigo_partida_arancelaria,
      cuenta_venta,
      cuenta_costo,
      notas,
      activo: true,
    });

    await repo().save(p);
    res.status(201).json(p);
  } catch (e: any) {
    if (e?.message?.includes('UNIQUE')) {
      res.status(409).json({ error: 'Ya existe un producto con ese código en esta empresa' }); return;
    }
    res.status(500).json({ error: 'Error creando producto' });
  }
});

// PUT /api/productos/:id
router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const p = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!p) { res.status(404).json({ error: 'Producto no encontrado' }); return; }

    const allowed = [
      'codigo','tipo','nombre','descripcion','unidad_medida_codigo',
      'precio_base','tipo_tributo_codigo','tarifa_iva','tarifa_inc',
      'codigo_unspsc','codigo_partida_arancelaria','cuenta_venta','cuenta_costo',
      'notas','activo',
    ];
    allowed.forEach(k => {
      if (req.body[k] !== undefined) (p as any)[k] = req.body[k];
    });

    await repo().save(p);
    res.json(p);
  } catch (e: any) {
    if (e?.message?.includes('UNIQUE')) {
      res.status(409).json({ error: 'Ya existe un producto con ese código' }); return;
    }
    res.status(500).json({ error: 'Error actualizando producto' });
  }
});

// DELETE /api/productos/:id (soft: activo = false)
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const p = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!p) { res.status(404).json({ error: 'Producto no encontrado' }); return; }
    p.activo = false;
    await repo().save(p);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Error eliminando producto' });
  }
});

export default router;
