import { Router, Response } from 'express';
import { AppDataSource } from '../../config/database';
import { CierrePeriodo } from '../../entities/contabilidad/CierrePeriodo';
import { authMiddleware, requireRole, AuthRequest } from '../../middleware/auth.middleware';

const router = Router();
router.use(authMiddleware);

const repo = () => AppDataSource.getRepository(CierrePeriodo);

// GET /api/contabilidad/cierres
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const cierres = await repo().find({
      where: { company_id: cid },
      order: { periodo: 'DESC' },
      relations: ['cerrado_por'],
    });
    res.json(cierres);
  } catch (e) {
    res.status(500).json({ error: 'Error listando cierres' });
  }
});

// GET /api/contabilidad/cierres/check?fecha=YYYY-MM-DD
router.get('/check', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { fecha } = req.query as Record<string, string>;
    if (!fecha) { res.json({ cerrado: false }); return; }
    const periodo = fecha.slice(0, 7);
    const cierre = await repo().findOne({ where: { company_id: cid, periodo } });
    const cerrado = !!cierre && !cierre.reabierto_por_id;
    res.json({ cerrado, periodo, cierre: cierre || null });
  } catch (e) {
    res.status(500).json({ error: 'Error verificando periodo' });
  }
});

// POST /api/contabilidad/cierres
router.post('/', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { periodo, observaciones } = req.body as { periodo: string; observaciones?: string };

    if (!periodo || !/^\d{4}-\d{2}$/.test(periodo)) {
      res.status(400).json({ error: 'El periodo debe tener formato YYYY-MM' });
      return;
    }

    const existe = await repo().findOne({ where: { company_id: cid, periodo } });
    if (existe && !existe.reabierto_por_id) {
      res.status(400).json({ error: `El periodo ${periodo} ya esta cerrado` });
      return;
    }

    // Si el periodo ya existia pero fue reabierto, se reutiliza el mismo registro
    // (el indice unico company_id+periodo no permite dos filas para el mismo mes)
    // dejando explicito el nuevo cierre y limpiando los datos de la reapertura anterior.
    const cierre = existe ?? new CierrePeriodo();
    Object.assign(cierre, {
      company_id: cid,
      periodo,
      fecha_cierre: new Date().toISOString().slice(0, 10),
      cerrado_por_id: req.user!.id,
      observaciones,
      reabierto_por_id: null,
      fecha_reapertura: null,
    });
    await repo().save(cierre);
    res.status(201).json(cierre);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error cerrando periodo' });
  }
});

// DELETE /api/contabilidad/cierres/:id (reabrir periodo)
// Deja rastro de auditoria — NO borra el registro del cierre. Un periodo
// reabierto sigue devolviendo cerrado:false en /check (se valida via
// reabierto_por_id), pero conserva quien y cuando lo cerro y lo reabrio.
router.delete('/:id', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cierre = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!cierre) { res.status(404).json({ error: 'Cierre no encontrado' }); return; }
    if (cierre.reabierto_por_id) { res.status(400).json({ error: 'Este periodo ya estaba reabierto' }); return; }
    cierre.reabierto_por_id = req.user!.id;
    cierre.fecha_reapertura = new Date().toISOString().slice(0, 10);
    await repo().save(cierre);
    res.json({ ok: true, message: `Periodo ${cierre.periodo} reabierto`, cierre });
  } catch (e) {
    res.status(500).json({ error: 'Error reabriendo periodo' });
  }
});

export default router;
