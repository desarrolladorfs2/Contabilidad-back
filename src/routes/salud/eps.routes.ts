import { Router, Response } from 'express';
import { AppDataSource } from '../../config/database';
import { Eps } from '../../entities/salud/Eps';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import { Like } from 'typeorm';

const router = Router();
router.use(authMiddleware);

const repo = () => AppDataSource.getRepository(Eps);

// GET /api/salud/eps?page=1&limit=20&q=&tipo=
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { page = '1', limit = '20', q = '', tipo } = req.query as Record<string, string>;
    const cid = req.user!.companyId;

    const qb = repo().createQueryBuilder('e')
      .where('e.company_id = :cid', { cid })
      .orderBy('e.nombre', 'ASC')
      .skip((+page - 1) * +limit)
      .take(+limit);

    if (q) qb.andWhere('(e.nombre LIKE :q OR e.nit LIKE :q OR e.nombre_comercial LIKE :q)', { q: `%${q}%` });
    if (tipo) qb.andWhere('e.tipo = :tipo', { tipo });

    const [items, total] = await qb.getManyAndCount();
    res.json({ items, total, page: +page, limit: +limit });
  } catch { res.status(500).json({ error: 'Error listando EPS' }); }
});

// GET /api/salud/eps/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!item) { res.status(404).json({ error: 'EPS no encontrada' }); return; }
    res.json(item);
  } catch { res.status(500).json({ error: 'Error' }); }
});

// POST /api/salud/eps
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const dup = await repo().findOne({ where: { nit: req.body.nit, company_id: cid } });
    if (dup) { res.status(409).json({ error: `Ya existe una EPS con NIT ${req.body.nit}` }); return; }
    const item = repo().create({ ...req.body, company_id: cid });
    await repo().save(item);
    res.status(201).json(item);
  } catch { res.status(500).json({ error: 'Error creando EPS' }); }
});

// PUT /api/salud/eps/:id
router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!item) { res.status(404).json({ error: 'EPS no encontrada' }); return; }
    repo().merge(item, req.body);
    await repo().save(item);
    res.json(item);
  } catch { res.status(500).json({ error: 'Error actualizando EPS' }); }
});

// DELETE /api/salud/eps/:id
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!item) { res.status(404).json({ error: 'EPS no encontrada' }); return; }
    await repo().remove(item);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Error eliminando EPS' }); }
});

export default router;
