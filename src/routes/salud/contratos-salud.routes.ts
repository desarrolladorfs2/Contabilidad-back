import { Router, Response } from 'express';
import * as XLSX from 'xlsx';
import { In } from 'typeorm';
import { AppDataSource } from '../../config/database';
import { ContratoSalud } from '../../entities/salud/ContratoSalud';
import { ContratoServicio } from '../../entities/salud/ContratoServicio';
import { CentroCosto } from '../../entities/contabilidad/CentroCosto';
import { Sede } from '../../entities/contabilidad/Sede';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';

const router = Router();
router.use(authMiddleware);

const repo   = () => AppDataSource.getRepository(ContratoSalud);
const csRepo = () => AppDataSource.getRepository(ContratoServicio);
const ccRepo = () => AppDataSource.getRepository(CentroCosto);
const sedeRepo = () => AppDataSource.getRepository(Sede);

/**
 * Resuelve `centro_costo_ids`/`sede_ids` (arrays de ids) a entidades reales de
 * la empresa, para poblar las relaciones M2M del contrato. Un contrato puede
 * operar en varias ciudades/sedes a la vez, por eso son arreglos y no un solo id.
 */
async function resolverCcYSedes(cid: string, body: Record<string, any>): Promise<{ centros_costo?: CentroCosto[]; sedes?: Sede[]; error?: string }> {
  const centroCostoIds: string[] = Array.isArray(body.centro_costo_ids) ? body.centro_costo_ids : [];
  const sedeIds: string[] = Array.isArray(body.sede_ids) ? body.sede_ids : [];
  if (!centroCostoIds.length) return { error: 'Debe seleccionar al menos un centro de costo' };
  if (!sedeIds.length) return { error: 'Debe seleccionar al menos una sede' };
  const centros_costo = await ccRepo().findBy({ id: In(centroCostoIds), company_id: cid });
  if (centros_costo.length !== centroCostoIds.length) return { error: 'Uno o más centros de costo seleccionados no existen' };
  const sedes = await sedeRepo().findBy({ id: In(sedeIds), company_id: cid });
  if (sedes.length !== sedeIds.length) return { error: 'Una o más sedes seleccionadas no existen' };
  return { centros_costo, sedes };
}

// GET /api/salud/contratos?page=1&limit=20&q=&eps_id=&estado=
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { page = '1', limit = '20', q = '', eps_id, estado } = req.query as Record<string, string>;
    const cid = req.user!.companyId;

    const qb = repo().createQueryBuilder('c')
      .leftJoinAndSelect('c.eps', 'eps')
      .leftJoinAndSelect('c.centros_costo', 'centro_costo')
      .leftJoinAndSelect('c.sedes', 'sede')
      .leftJoinAndSelect('sede.municipio', 'municipio')
      .where('c.company_id = :cid', { cid })
      .orderBy('c.fecha_inicio', 'DESC')
      .skip((+page - 1) * +limit)
      .take(+limit);

    if (q)      qb.andWhere('(c.numero LIKE :q OR eps.nombre LIKE :q)', { q: `%${q}%` });
    if (eps_id) qb.andWhere('c.eps_id = :eps_id', { eps_id });
    if (estado) qb.andWhere('c.estado = :estado', { estado });

    const [items, total] = await qb.getManyAndCount();
    res.json({ items, total, page: +page, limit: +limit });
  } catch { res.status(500).json({ error: 'Error listando contratos' }); }
});

// GET /api/salud/contratos/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({
      where: { id: req.params.id, company_id: req.user!.companyId },
      relations: ['eps', 'centros_costo', 'sedes', 'sedes.municipio'],
    });
    if (!item) { res.status(404).json({ error: 'Contrato no encontrado' }); return; }
    res.json(item);
  } catch { res.status(500).json({ error: 'Error' }); }
});

// GET /api/salud/contratos/:id/servicios
router.get('/:id/servicios', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const contrato = await repo().findOne({
      where: { id: req.params.id, company_id: req.user!.companyId },
      relations: ['eps'],
    });
    if (!contrato) { res.status(404).json({ error: 'Contrato no encontrado' }); return; }

    const servicios = await csRepo().createQueryBuilder('cs')
      .leftJoinAndSelect('cs.servicio', 'sv')
      .where('cs.contrato_id = :id', { id: req.params.id })
      .orderBy('sv.categoria', 'ASC')
      .addOrderBy('sv.codigo_cups', 'ASC')
      .getMany();

    res.json({ contrato, servicios });
  } catch { res.status(500).json({ error: 'Error cargando detalle' }); }
});

// GET /api/salud/contratos/:id/export  — Excel con datos del contrato + servicios
router.get('/:id/export', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const contrato = await repo().findOne({
      where: { id: req.params.id, company_id: req.user!.companyId },
      relations: ['eps'],
    });
    if (!contrato) { res.status(404).json({ error: 'Contrato no encontrado' }); return; }

    const servicios = await csRepo().createQueryBuilder('cs')
      .leftJoinAndSelect('cs.servicio', 'sv')
      .where('cs.contrato_id = :id', { id: req.params.id })
      .orderBy('sv.categoria', 'ASC')
      .addOrderBy('sv.codigo_cups', 'ASC')
      .getMany();

    const CATEGORIA: Record<string, string> = {
      consultas: 'Atenciones', procedimientos: 'Procedimientos',
      medicamentos: 'Medicamentos', otrosServicios: 'Otros Servicios',
    };

    const wb = XLSX.utils.book_new();

    // Hoja 1 — resumen del contrato
    const infoRows = [
      ['Número de contrato', contrato.numero],
      ['EPS',                contrato.eps?.nombre || ''],
      ['NIT EPS',            contrato.eps?.nit || ''],
      ['Ciudad',             contrato.ciudad_nombre || ''],
      ['Departamento',       contrato.ciudad_nombre || ''],
      ['Modalidad',          contrato.modalidad_pago],
      ['Tipo operación SS',  contrato.tipo_operacion_ss],
      ['Tipo cobertura',     contrato.tipo_cobertura || ''],
      ['Código prestador',   contrato.cod_prestador || ''],
      ['Fecha inicio',       contrato.fecha_inicio],
      ['Fecha fin',          contrato.fecha_fin],
      ['Estado',             contrato.estado],
      ['Observaciones',      contrato.observaciones || ''],
    ];
    const wsInfo = XLSX.utils.aoa_to_sheet(infoRows);
    wsInfo['!cols'] = [{ wch: 22 }, { wch: 45 }];
    XLSX.utils.book_append_sheet(wb, wsInfo, 'Contrato');

    // Hoja 2 — servicios asignados
    const svcRows = servicios.map(cs => ({
      'Código CUPS':    cs.servicio?.codigo_cups || '',
      'Nombre':         cs.servicio?.nombre || '',
      'Categoría':      CATEGORIA[cs.servicio?.categoria || ''] || cs.servicio?.categoria || '',
      'Valor base':     cs.servicio?.valor_base ?? 0,
      'Valor acordado': cs.valor_acordado ?? '',
      'Habilitado':     cs.habilitado ? 'SI' : 'NO',
      'Descripción':    cs.servicio?.descripcion || '',
    }));

    const wsSvc = svcRows.length
      ? XLSX.utils.json_to_sheet(svcRows)
      : XLSX.utils.aoa_to_sheet([['Código CUPS','Nombre','Categoría','Valor base','Valor acordado','Habilitado','Descripción']]);
    wsSvc['!cols'] = [{ wch: 14 }, { wch: 50 }, { wch: 18 }, { wch: 14 }, { wch: 16 }, { wch: 12 }, { wch: 50 }];
    XLSX.utils.book_append_sheet(wb, wsSvc, 'Servicios');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `contrato_${contrato.numero.replace(/[^a-zA-Z0-9-]/g, '_')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (e) { res.status(500).json({ error: 'Error exportando contrato' }); }
});

// POST /api/salud/contratos
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { centro_costo_ids, sede_ids, ...body } = req.body;
    const resuelto = await resolverCcYSedes(cid, req.body);
    if (resuelto.error) { res.status(400).json({ error: resuelto.error }); return; }
    const item = repo().create({ ...body, company_id: cid, centros_costo: resuelto.centros_costo, sedes: resuelto.sedes } as ContratoSalud);
    await repo().save(item);
    const guardado = await repo().findOne({ where: { id: item.id }, relations: ['eps', 'centros_costo', 'sedes', 'sedes.municipio'] });
    res.status(201).json(guardado);
  } catch { res.status(500).json({ error: 'Error creando contrato' }); }
});

// PUT /api/salud/contratos/:id
router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const item = await repo().findOne({ where: { id: req.params.id, company_id: cid } });
    if (!item) { res.status(404).json({ error: 'Contrato no encontrado' }); return; }
    const { centro_costo_ids, sede_ids, ...body } = req.body;
    repo().merge(item, body);
    if (Array.isArray(centro_costo_ids) || Array.isArray(sede_ids)) {
      const resuelto = await resolverCcYSedes(cid, {
        centro_costo_ids: centro_costo_ids ?? (item.centros_costo || []).map(c => c.id),
        sede_ids:         sede_ids ?? (item.sedes || []).map(s => s.id),
      });
      if (resuelto.error) { res.status(400).json({ error: resuelto.error }); return; }
      item.centros_costo = resuelto.centros_costo;
      item.sedes = resuelto.sedes;
    }
    await repo().save(item);
    const guardado = await repo().findOne({ where: { id: item.id }, relations: ['eps', 'centros_costo', 'sedes', 'sedes.municipio'] });
    res.json(guardado);
  } catch { res.status(500).json({ error: 'Error actualizando contrato' }); }
});

// DELETE /api/salud/contratos/:id
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!item) { res.status(404).json({ error: 'Contrato no encontrado' }); return; }
    await repo().remove(item);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Error eliminando contrato' }); }
});

export default router;
