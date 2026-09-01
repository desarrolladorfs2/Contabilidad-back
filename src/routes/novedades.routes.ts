/**
 * novedades.routes.ts
 *
 * Endpoints REST para las novedades del hub principal ("Novedades y
 * actualizaciones"). Monta en: /api/novedades
 *
 * GET /  → cualquier usuario autenticado; retorna las novedades activas y
 *          vigentes visibles para SU empresa: las globales (company_id NULL)
 *          más las específicas de su company_id.
 * POST/PUT/DELETE → solo admin/superadmin. Un admin normal solo puede crear
 *          o editar novedades de su propia empresa (company_id se fuerza al
 *          suyo); solo superadmin puede publicar una novedad global
 *          (company_id = null, visible para todas las empresas).
 */

import { Router, Response } from 'express';
import { AppDataSource } from '../config/database';
import { Novedad } from '../entities/Novedad';
import { authMiddleware, requireRole, AuthRequest } from '../middleware/auth.middleware';

const router = Router();
router.use(authMiddleware);

const repo = () => AppDataSource.getRepository(Novedad);

/** Fecha de hoy en formato YYYY-MM-DD (para filtrar vigencia). */
function hoy(): string {
  return new Date().toISOString().slice(0, 10);
}

// GET /api/novedades — novedades visibles para la empresa del usuario (globales + propias)
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const today = hoy();

    const items = await repo().createQueryBuilder('n')
      .where('n.activa = :activa', { activa: true })
      .andWhere('(n.company_id IS NULL OR n.company_id = :cid)', { cid })
      .andWhere('(n.fecha_inicio IS NULL OR n.fecha_inicio <= :today)', { today })
      .andWhere('(n.fecha_fin IS NULL OR n.fecha_fin >= :today)', { today })
      .orderBy('n.orden', 'ASC')
      .addOrderBy('n.created_at', 'DESC')
      .getMany();

    res.json({ items });
  } catch (e) {
    console.error('[NOVEDADES] Error listando:', e);
    res.status(500).json({ error: 'Error listando novedades' });
  }
});

// GET /api/novedades/admin — administración: incluye inactivas/vencidas de la empresa
// (o de todas si es superadmin y pasa ?todas=true)
router.get('/admin', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const isSuperadmin = req.user!.role === 'superadmin';
    const verTodas = isSuperadmin && req.query.todas === 'true';

    const qb = repo().createQueryBuilder('n').orderBy('n.orden', 'ASC').addOrderBy('n.created_at', 'DESC');
    if (!verTodas) qb.where('(n.company_id IS NULL OR n.company_id = :cid)', { cid });

    const items = await qb.getMany();
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: 'Error listando novedades' });
  }
});

// POST /api/novedades
router.post('/', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const isSuperadmin = req.user!.role === 'superadmin';
    const body = req.body as Record<string, any>;

    // Solo superadmin puede publicar una novedad global (company_id null).
    // Un admin normal siempre crea la suya, forzada a su propia empresa.
    const company_id = isSuperadmin && body.global === true ? null : req.user!.companyId;

    const item = repo().create({
      company_id,
      categoria:    body.categoria,
      color:        body.color || '#6366f1',
      mensaje:      body.mensaje,
      activa:       body.activa ?? true,
      orden:        body.orden ?? 0,
      fecha_inicio: body.fecha_inicio || undefined,
      fecha_fin:    body.fecha_fin || undefined,
    });
    await repo().save(item);
    res.status(201).json(item);
  } catch (e) {
    res.status(500).json({ error: 'Error creando novedad' });
  }
});

// PUT /api/novedades/:id
router.put('/:id', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const isSuperadmin = req.user!.role === 'superadmin';

    const item = await repo().findOne({ where: { id: req.params.id } });
    if (!item) { res.status(404).json({ error: 'Novedad no encontrada' }); return; }

    // Un admin normal no puede editar novedades globales ni de otra empresa.
    if (!isSuperadmin && (item.company_id === null || item.company_id !== cid)) {
      res.status(403).json({ error: 'Sin permisos sobre esta novedad' });
      return;
    }

    const body = req.body as Record<string, any>;
    if (isSuperadmin && 'global' in body) {
      item.company_id = body.global === true ? null : cid;
    }
    repo().merge(item, {
      categoria:    body.categoria    ?? item.categoria,
      color:        body.color        ?? item.color,
      mensaje:      body.mensaje      ?? item.mensaje,
      activa:       body.activa       ?? item.activa,
      orden:        body.orden        ?? item.orden,
      fecha_inicio: body.fecha_inicio ?? item.fecha_inicio,
      fecha_fin:    body.fecha_fin    ?? item.fecha_fin,
    });
    await repo().save(item);
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: 'Error actualizando novedad' });
  }
});

// DELETE /api/novedades/:id
router.delete('/:id', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const isSuperadmin = req.user!.role === 'superadmin';

    const item = await repo().findOne({ where: { id: req.params.id } });
    if (!item) { res.status(404).json({ error: 'Novedad no encontrada' }); return; }
    if (!isSuperadmin && (item.company_id === null || item.company_id !== cid)) {
      res.status(403).json({ error: 'Sin permisos sobre esta novedad' });
      return;
    }

    await repo().remove(item);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando novedad' });
  }
});

export default router;
