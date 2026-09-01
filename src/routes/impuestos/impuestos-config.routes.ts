import { Router, Response } from 'express';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../../config/database';
import { ConfiguracionImpuesto, TipoImpuesto } from '../../entities/impuestos/ConfiguracionImpuesto';
import { TarifaRetencion, TipoRetencion } from '../../entities/impuestos/TarifaRetencion';
import { authMiddleware, requireRole, AuthRequest } from '../../middleware/auth.middleware';

/**
 * CRUD de configuración de impuestos — hallazgo #54.
 *
 * Antes `ConfiguracionImpuesto`/`TarifaRetencion` solo se poblaban por seed;
 * las tarifas de ICA/Retefuente ya se leían de aquí (ver impuestos.routes.ts),
 * pero no existía ningún endpoint para que la empresa las edite desde la UI.
 * Este router cierra ese hueco: permite ver/crear/editar la configuración
 * fiscal de la empresa (ConfiguracionImpuesto) y sus tarifas de retención
 * personalizadas (TarifaRetencion), sin tocar las tarifas globales del
 * sistema (company_id = null, sembradas por seed, de solo lectura aquí).
 */
const router = Router();
router.use(authMiddleware);

const cfgRepo = () => AppDataSource.getRepository(ConfiguracionImpuesto);
const tarifaRepo = () => AppDataSource.getRepository(TarifaRetencion);

// ── ConfiguracionImpuesto ──────────────────────────────────────────────────

// GET /api/impuestos/config — todas las filas de configuración de la empresa
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const items = await cfgRepo().find({
      where: { company_id: cid },
      relations: ['municipio', 'actividad_economica'],
      order: { tipo: 'ASC' },
    });
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: 'Error listando configuración de impuestos' });
  }
});

// ── TarifaRetencion (personalizadas por empresa) ───────────────────────────
//
// Nota de orden de rutas: estas van ANTES de `PUT /:tipo` (definida más abajo)
// a propósito — Express matchea por orden de registro, y `/tarifas/:id`
// caería dentro del patrón `/:tipo` (con tipo="tarifas") si se registrara
// después, nunca llegando a este handler.

// GET /api/impuestos/config/tarifas/lista?tipo= — tarifas propias de la empresa + globales
// de referencia (marcadas con es_global) para que la UI pueda mostrar "usando la global"
// vs. "personalizada".
router.get('/tarifas/lista', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { tipo } = req.query as Record<string, string>;
    const where: Record<string, unknown> = tipo ? { tipo: tipo as TipoRetencion } : {};
    const [propias, globales] = await Promise.all([
      tarifaRepo().find({ where: { ...where, company_id: cid }, order: { concepto_nombre: 'ASC' } }),
      tarifaRepo().find({ where: { ...where, company_id: IsNull() }, order: { concepto_nombre: 'ASC' } }),
    ]);
    res.json([
      ...propias.map(t => ({ ...t, es_global: false })),
      ...globales.map(t => ({ ...t, es_global: true })),
    ]);
  } catch (e) {
    res.status(500).json({ error: 'Error listando tarifas de retención' });
  }
});

// POST /api/impuestos/config/tarifas — crea una tarifa personalizada de la empresa
// (nunca sobre company_id null — las globales solo se siembran por seed).
router.post('/tarifas', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { concepto_codigo, concepto_nombre, tipo, tarifa_pct, base_minima_uvt, descripcion } = req.body;
    if (!concepto_codigo || !concepto_nombre || !tipo || tarifa_pct == null) {
      res.status(400).json({ error: 'concepto_codigo, concepto_nombre, tipo y tarifa_pct son obligatorios' });
      return;
    }
    const existe = await tarifaRepo().findOne({ where: { company_id: cid, concepto_codigo, tipo } });
    if (existe) { res.status(400).json({ error: `Ya existe una tarifa "${concepto_codigo}" de tipo "${tipo}" para esta empresa` }); return; }
    const item = tarifaRepo().create({
      company_id: cid, concepto_codigo, concepto_nombre, tipo,
      tarifa_pct: Number(tarifa_pct), base_minima_uvt: Number(base_minima_uvt ?? 0),
      descripcion: descripcion || undefined, activa: true,
    });
    await tarifaRepo().save(item);
    res.status(201).json(item);
  } catch (e) {
    res.status(500).json({ error: 'Error creando tarifa de retención' });
  }
});

// PUT /api/impuestos/config/tarifas/:id — edita una tarifa propia de la empresa
router.put('/tarifas/:id', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const item = await tarifaRepo().findOne({ where: { id: req.params.id, company_id: cid } });
    if (!item) { res.status(404).json({ error: 'Tarifa no encontrada (o es una tarifa global, de solo lectura)' }); return; }
    const allowed = ['concepto_nombre', 'tarifa_pct', 'base_minima_uvt', 'activa', 'descripcion'];
    allowed.forEach(k => { if (req.body[k] !== undefined) (item as never as Record<string, unknown>)[k] = req.body[k]; });
    await tarifaRepo().save(item);
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: 'Error actualizando tarifa de retención' });
  }
});

// DELETE /api/impuestos/config/tarifas/:id — elimina una tarifa propia (nunca una global)
router.delete('/tarifas/:id', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const item = await tarifaRepo().findOne({ where: { id: req.params.id, company_id: cid } });
    if (!item) { res.status(404).json({ error: 'Tarifa no encontrada (o es una tarifa global, de solo lectura)' }); return; }
    await tarifaRepo().remove(item);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando tarifa de retención' });
  }
});

// PUT /api/impuestos/config/:tipo — crea o actualiza (upsert) la config de un tipo de impuesto
router.put('/:tipo', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const tipo = req.params.tipo as TipoImpuesto;
    const validos: TipoImpuesto[] = ['iva', 'retefuente', 'reteiva', 'reteica', 'ica', 'renta', 'cree'];
    if (!validos.includes(tipo)) { res.status(400).json({ error: `Tipo de impuesto inválido: ${tipo}` }); return; }

    let item = await cfgRepo().findOne({ where: { company_id: cid, tipo } });
    const body = req.body as Record<string, unknown>;
    const allowed = ['aplica', 'periodicidad', 'tarifa_pct', 'municipio_id', 'actividad_economica_id', 'formulario_dian', 'observaciones'];
    if (!item) {
      item = cfgRepo().create({ company_id: cid, tipo });
    }
    allowed.forEach(k => { if (body[k] !== undefined) (item as never as Record<string, unknown>)[k] = body[k] || null; });
    await cfgRepo().save(item);
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: 'Error guardando configuración de impuesto' });
  }
});

export default router;
