import { Router, Response } from 'express';
import { AppDataSource } from '../../config/database';
import { Sede } from '../../entities/contabilidad/Sede';
import { Municipio } from '../../entities/catalogo/Municipio';
import { User } from '../../entities/User';
import { authMiddleware, requireRole, AuthRequest } from '../../middleware/auth.middleware';

const router = Router();
router.use(authMiddleware);

const repo = () => AppDataSource.getRepository(Sede);
const municipioRepo = () => AppDataSource.getRepository(Municipio);
const userRepo = () => AppDataSource.getRepository(User);

// GET /api/contabilidad/sedes/usuarios-responsables — lista mínima (id, nombre) de
// usuarios activos de la empresa, para el select de "responsable" en el form de Sedes.
// Se expone aquí (en vez de /admin/usuarios, que exige rol admin/superadmin) porque
// crear/editar sedes ya está permitido a 'operator' — hallazgo #43.
router.get('/usuarios-responsables', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const usuarios = await userRepo().find({
      where: { company_id: cid, is_active: true },
      select: ['id', 'name', 'email'],
      order: { name: 'ASC' },
    });
    res.json(usuarios);
  } catch (e) {
    res.status(500).json({ error: 'Error listando usuarios' });
  }
});

async function nextCodigo(cid: string): Promise<string> {
  const sedes = await repo()
    .createQueryBuilder('s')
    .select('s.codigo', 'codigo')
    .where('s.company_id = :cid AND s.codigo LIKE :p', { cid, p: 'SD-%' })
    .getRawMany<{ codigo: string }>();
  let max = 0;
  for (const s of sedes) {
    const num = parseInt(s.codigo.replace('SD-', ''), 10);
    if (!isNaN(num) && num > max) max = num;
  }
  return `SD-${String(max + 1).padStart(3, '0')}`;
}

// GET /api/contabilidad/sedes/next-codigo
router.get('/next-codigo', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json({ codigo: await nextCodigo(req.user!.companyId) });
  } catch (e) {
    res.status(500).json({ error: 'Error generando codigo' });
  }
});

// GET /api/contabilidad/sedes
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { q = '', activo } = req.query as Record<string, string>;
    const qb = repo()
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.municipio', 'municipio')
      .leftJoinAndSelect('s.responsable', 'responsable')
      .where('s.company_id = :cid', { cid })
      .orderBy('s.codigo', 'ASC');
    if (q) qb.andWhere('(s.codigo LIKE :q OR s.nombre LIKE :q OR municipio.nombre LIKE :q)', { q: `%${q}%` });
    if (activo !== undefined && activo !== '') qb.andWhere('s.activo = :a', { a: activo === 'true' });
    res.json(await qb.getMany());
  } catch (e) {
    res.status(500).json({ error: 'Error listando sedes' });
  }
});

// POST /api/contabilidad/sedes
router.post('/', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const codigo = req.body.codigo?.trim() || await nextCodigo(cid);
    const existe = await repo().findOne({ where: { company_id: cid, codigo } });
    if (existe) { res.status(400).json({ error: `El codigo "${codigo}" ya existe` }); return; }
    if (!req.body.nombre?.trim()) {
      res.status(400).json({ error: 'El nombre es obligatorio' }); return;
    }
    const { ciudad, ...body } = req.body;
    if (!body.municipio_id) {
      body.municipio_id = null;
    } else {
      const municipio = await municipioRepo().findOne({ where: { id: body.municipio_id } });
      if (!municipio) { res.status(400).json({ error: 'El municipio seleccionado no existe' }); return; }
    }
    const item = Object.assign(new Sede(), { ...body, codigo, company_id: cid, activo: true });
    await repo().save(item);
    res.status(201).json(item);
  } catch (e) {
    res.status(500).json({ error: 'Error creando sede' });
  }
});

// PUT /api/contabilidad/sedes/:id
router.put('/:id', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!item) { res.status(404).json({ error: 'Sede no encontrada' }); return; }
    if (req.body.codigo && req.body.codigo !== item.codigo) {
      const existe = await repo().findOne({ where: { company_id: req.user!.companyId, codigo: req.body.codigo } });
      if (existe) { res.status(400).json({ error: `El codigo "${req.body.codigo}" ya existe` }); return; }
    }
    const { ciudad, ...body } = req.body;
    if (!body.municipio_id) {
      body.municipio_id = null;
    } else {
      const municipio = await municipioRepo().findOne({ where: { id: body.municipio_id } });
      if (!municipio) { res.status(400).json({ error: 'El municipio seleccionado no existe' }); return; }
    }
    Object.assign(item, body);
    await repo().save(item);
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: 'Error actualizando sede' });
  }
});

// DELETE /api/contabilidad/sedes/:id
router.delete('/:id', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!item) { res.status(404).json({ error: 'Sede no encontrada' }); return; }
    await repo().remove(item);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando sede' });
  }
});

export default router;
