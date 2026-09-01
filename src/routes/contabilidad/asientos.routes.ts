import { Router, Response } from 'express';
import { In } from 'typeorm';
import { AppDataSource } from '../../config/database';
import { AsientoContable } from '../../entities/contabilidad/AsientoContable';
import { LineaAsiento } from '../../entities/contabilidad/LineaAsiento';
import { Sede } from '../../entities/contabilidad/Sede';
import { CuentaPUC } from '../../entities/contabilidad/CuentaPUC';
import { Factura } from '../../entities/Invoice';
import { ReceivedInvoice } from '../../entities/ReceivedInvoice';
import { FacturaCompra } from '../../entities/FacturaCompra';
import { FacturaSalud } from '../../entities/salud/FacturaSalud';
import { CierrePeriodo } from '../../entities/contabilidad/CierrePeriodo';
import { authMiddleware, requireRole, AuthRequest } from '../../middleware/auth.middleware';
import {
  generarAsientoDesdeFactura,
  generarAsientoDesdeFacturaSalud,
  generarAsientoDesdeFacturaCompra,
} from '../../services/asiento-generator';

/** Error tipado para que las rutas POST/PUT devuelvan 400 en vez de 500 — hallazgo #16. */
class CodigoPucInvalidoError extends Error {
  constructor(public codigos: string[]) {
    super(`Código(s) de cuenta PUC inexistente(s) para esta empresa: ${codigos.join(', ')}`);
  }
}

/** Carga Sede entities a partir de un array de IDs */
async function resolverSedesLinea(ids: string[]): Promise<Sede[]> {
  if (!ids || ids.length === 0) return [];
  return AppDataSource.getRepository(Sede).findBy({ id: In(ids) });
}

/** Mapea las lineas del request a LineaAsiento con ciudad, sedes y cuenta_id resueltos */
async function mapLineas(lineas: any[], cid: string): Promise<Partial<LineaAsiento>[]> {
  // Recolectar todos los sede_ids únicos de todas las lineas
  const allSedeIds = [...new Set(lineas.flatMap((l: any) => Array.isArray(l.sede_ids) ? l.sede_ids : []))] as string[];
  const sedesMap = new Map<string, Sede>();
  if (allSedeIds.length > 0) {
    const sedes = await resolverSedesLinea(allSedeIds);
    sedes.forEach(s => sedesMap.set(s.id, s));
  }
  // Resuelve cuenta_id (FK real al PUC) a partir de cuenta_codigo, que es lo único
  // que hoy envía el formulario de asientos — hallazgo #16. Sin esto, cuenta_id
  // siempre quedaba nulo y el RESTRICT de borrado en PUC nunca se activaba (#19).
  const codigos = [...new Set(lineas.map((l: any) => l.cuenta_codigo).filter(Boolean))] as string[];
  const cuentaMap = new Map<string, CuentaPUC>();
  if (codigos.length > 0) {
    const cuentas = await AppDataSource.getRepository(CuentaPUC).find({ where: { company_id: cid, codigo: In(codigos) } });
    cuentas.forEach(c => cuentaMap.set(c.codigo, c));
  }
  // Hallazgo #16 (2da parte): rechazar líneas cuyo código no exista en el PUC de la
  // empresa, en vez de dejar cuenta_id undefined en silencio (lo cual dejaba pasar
  // asientos con cuentas "fantasma" que nunca se podían enlazar de verdad).
  const codigosInvalidos = codigos.filter(c => !cuentaMap.has(c));
  if (codigosInvalidos.length > 0) {
    throw new CodigoPucInvalidoError(codigosInvalidos);
  }
  return lineas.map((l: any, i: number) => ({
    ...l,
    orden:        i,
    debito:       +l.debito  || 0,
    credito:      +l.credito || 0,
    ciudad_codigo: l.ciudad_codigo || undefined,
    ciudad_nombre: l.ciudad_nombre || undefined,
    cuenta_id:     l.cuenta_id || cuentaMap.get(l.cuenta_codigo)?.id || undefined,
    sedes:         (Array.isArray(l.sede_ids) ? l.sede_ids : [])
                     .map((id: string) => sedesMap.get(id))
                     .filter(Boolean) as Sede[],
  }));
}

const router = Router();
router.use(authMiddleware);

const repo = () => AppDataSource.getRepository(AsientoContable);

async function nextNumero(cid: string): Promise<number> {
  const last = await repo()
    .createQueryBuilder('a')
    .select('MAX(a.numero)', 'max')
    .where('a.company_id = :cid', { cid })
    .getRawOne<{ max: number | null }>();
  return (last?.max ?? 0) + 1;
}

/**
 * El formulario del frontend maneja un campo libre "referencia" que no existe como
 * columna en AsientoContable (la entidad usa referencia_tipo/referencia_id).
 * Cuando llega req.body.referencia lo mapeamos a referencia_tipo: 'manual' y
 * referencia_id: <valor>. Al leer, exponemos el campo calculado "referencia" para
 * que el formulario pueda recargarlo en modo edicion.
 */
function mapReferenciaManual(body: any): any {
  if (body && Object.prototype.hasOwnProperty.call(body, 'referencia')) {
    const { referencia, ...rest } = body;
    if (referencia) {
      return { ...rest, referencia_tipo: 'manual', referencia_id: referencia };
    }
    return rest;
  }
  return body;
}

function withReferenciaCalculada<T extends { referencia_tipo?: string; referencia_id?: string }>(asiento: T): T & { referencia?: string } {
  if (asiento && asiento.referencia_tipo === 'manual') {
    return { ...asiento, referencia: asiento.referencia_id };
  }
  return asiento;
}

async function isPeriodoCerrado(cid: string, fecha: string): Promise<boolean> {
  const periodo = fecha.slice(0, 7);
  const cierre = await AppDataSource.getRepository(CierrePeriodo)
    .findOne({ where: { company_id: cid, periodo } });
  // Un cierre reabierto (reabierto_por_id seteado) ya no cuenta como cerrado —
  // el registro se conserva por auditoría pero el período vuelve a estar abierto.
  return !!cierre && !cierre.reabierto_por_id;
}

// GET /api/contabilidad/asientos
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { page = '1', limit = '20', estado, fecha_desde, fecha_hasta, q } = req.query as Record<string, string>;
    const qb = repo()
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.lineas', 'l')
      .where('a.company_id = :cid', { cid })
      .orderBy('a.fecha', 'DESC')
      .addOrderBy('a.numero', 'DESC')
      .skip((+page - 1) * +limit)
      .take(+limit);
    if (estado) qb.andWhere('a.estado = :estado', { estado });
    if (fecha_desde) qb.andWhere('a.fecha >= :fd', { fd: fecha_desde });
    if (fecha_hasta) qb.andWhere('a.fecha <= :fh', { fh: fecha_hasta });
    if (q) qb.andWhere('(a.descripcion LIKE :q OR a.referencia_id LIKE :q)', { q: `%${q}%` });
    const [items, total] = await qb.getManyAndCount();
    res.json({ items: items.map(withReferenciaCalculada), total, page: +page, limit: +limit });
  } catch (e) {
    res.status(500).json({ error: 'Error listando asientos' });
  }
});

// GET /api/contabilidad/asientos/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({
      where: { id: req.params.id, company_id: req.user!.companyId },
      relations: ['lineas'],
    });
    if (!item) { res.status(404).json({ error: 'Asiento no encontrado' }); return; }
    res.json(withReferenciaCalculada(item));
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo asiento' });
  }
});

// POST /api/contabilidad/asientos
router.post('/', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { lineas = [], ...rawBody } = req.body;
    const body = mapReferenciaManual(rawBody);
    // FBK-020: el Origen del asiento es obligatorio de verdad — antes venía
    // precargado en "Manual" en el formulario pero nada impedía guardarlo vacío.
    if (!body.origen || !String(body.origen).trim()) {
      res.status(400).json({ error: 'El campo Origen del asiento es obligatorio' });
      return;
    }
    if (body.fecha && await isPeriodoCerrado(cid, body.fecha)) {
      res.status(400).json({ error: `El periodo ${body.fecha.slice(0, 7)} esta cerrado. Reabrir el periodo antes de crear asientos.` });
      return;
    }
    const numero = await nextNumero(cid);
    const totalDeb = lineas.reduce((s: number, l: any) => s + (+l.debito || 0), 0);
    const totalCre = lineas.reduce((s: number, l: any) => s + (+l.credito || 0), 0);
    const asiento = Object.assign(new AsientoContable(), {
      ...body, company_id: cid, numero,
      total_debito: totalDeb, total_credito: totalCre,
      lineas: await mapLineas(lineas, cid),
    });
    await repo().save(asiento);
    res.status(201).json(withReferenciaCalculada(asiento));
  } catch (e) {
    if (e instanceof CodigoPucInvalidoError) { res.status(400).json({ error: e.message }); return; }
    console.error(e);
    res.status(500).json({ error: 'Error creando asiento' });
  }
});

// PUT /api/contabilidad/asientos/:id
router.put('/:id', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const asiento = await repo().findOne({ where: { id: req.params.id, company_id: cid }, relations: ['lineas'] });
    if (!asiento) { res.status(404).json({ error: 'Asiento no encontrado' }); return; }
    if (asiento.estado === 'aprobado') { res.status(400).json({ error: 'No se puede editar un asiento aprobado' }); return; }
    if (asiento.estado === 'anulado') { res.status(400).json({ error: 'No se puede editar un asiento anulado' }); return; }
    const { lineas = [], ...rawBody } = req.body;
    const body = mapReferenciaManual(rawBody);
    // FBK-020: mismo requisito que en POST — no permitir dejar Origen vacío al editar.
    const origenEfectivo = Object.prototype.hasOwnProperty.call(body, 'origen') ? body.origen : asiento.origen;
    if (!origenEfectivo || !String(origenEfectivo).trim()) {
      res.status(400).json({ error: 'El campo Origen del asiento es obligatorio' });
      return;
    }
    // Revalidar el cierre de período también al editar — no solo al crear —
    // usando la fecha nueva si viene en el body, o la fecha actual del asiento.
    const fechaEfectiva = body.fecha || asiento.fecha;
    if (fechaEfectiva && await isPeriodoCerrado(cid, fechaEfectiva)) {
      res.status(400).json({ error: `El periodo ${fechaEfectiva.slice(0, 7)} esta cerrado. Reabrir el periodo antes de editar asientos.` });
      return;
    }
    await AppDataSource.getRepository(LineaAsiento).delete({ asiento_id: asiento.id });
    const totalDeb = lineas.reduce((s: number, l: any) => s + (+l.debito || 0), 0);
    const totalCre = lineas.reduce((s: number, l: any) => s + (+l.credito || 0), 0);
    Object.assign(asiento, { ...body, total_debito: totalDeb, total_credito: totalCre });
    const lineasMapped = await mapLineas(lineas, cid);
    asiento.lineas = lineasMapped.map((l: any) =>
      Object.assign(new LineaAsiento(), { ...l, asiento_id: asiento.id })
    );
    await repo().save(asiento);
    res.json(withReferenciaCalculada(asiento));
  } catch (e) {
    if (e instanceof CodigoPucInvalidoError) { res.status(400).json({ error: e.message }); return; }
    res.status(500).json({ error: 'Error actualizando asiento' });
  }
});

// POST /api/contabilidad/asientos/:id/aprobar
router.post('/:id/aprobar', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const asiento = await repo().findOne({ where: { id: req.params.id, company_id: cid }, relations: ['lineas', 'lineas.cuenta'] });
    if (!asiento) { res.status(404).json({ error: 'Asiento no encontrado' }); return; }
    // Hallazgo #32: la validación de período cerrado ya existía en POST/PUT, pero no
    // aquí — permitía aprobar (y por tanto dejar contablemente firme) un asiento cuya
    // fecha cae en un período ya cerrado, si alguien lo dejaba en borrador antes del cierre.
    if (asiento.fecha && await isPeriodoCerrado(cid, asiento.fecha)) {
      res.status(400).json({ error: `El periodo ${asiento.fecha.slice(0, 7)} esta cerrado. Reabrir el periodo antes de aprobar este asiento.` });
      return;
    }
    if (Math.abs(asiento.total_debito - asiento.total_credito) > 0.01) {
      res.status(400).json({ error: 'El asiento no esta cuadrado (debitos != creditos)' }); return;
    }
    const sinCuenta = (asiento.lineas || []).some(l => !l.cuenta_codigo && !l.cuenta_id);
    if (sinCuenta) {
      res.status(400).json({ error: 'Todas las líneas deben tener una cuenta PUC asignada antes de aprobar el asiento' }); return;
    }
    // FBK-018: cuentas PUC marcadas requiere_centro_costo (típicamente 4-5-6) no
    // pueden aprobarse sin Centro de Costo en la línea que las usa.
    const lineaSinCC = (asiento.lineas || []).find(l => l.cuenta?.requiere_centro_costo && !l.centro_costo_id);
    if (lineaSinCC) {
      res.status(400).json({
        error: `La cuenta ${lineaSinCC.cuenta?.codigo || lineaSinCC.cuenta_codigo} (${lineaSinCC.cuenta?.nombre || ''}) requiere Centro de Costo y la línea no tiene uno asignado`,
      });
      return;
    }
    asiento.estado = 'aprobado';
    await repo().save(asiento);
    res.json(asiento);
  } catch (e) {
    res.status(500).json({ error: 'Error aprobando asiento' });
  }
});

// POST /api/contabilidad/asientos/generar-desde-facturas
router.post('/generar-desde-facturas', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { fecha_desde, fecha_hasta } = req.body as { fecha_desde: string; fecha_hasta: string };

    const facturas = await AppDataSource.getRepository(Factura)
      .createQueryBuilder('i')
      .where('i.company_id = :cid', { cid })
      .andWhere('i.estado IN (:...st)', { st: ['aprobada', 'aceptada'] })
      .andWhere('i.fecha_emision BETWEEN :s AND :e', { s: fecha_desde, e: fecha_hasta })
      .getMany();

    const creados: number[] = [];
    for (const f of facturas) {
      const asiento = await generarAsientoDesdeFactura(f, cid);
      if (asiento) creados.push(asiento.numero!);
    }
    res.json({ generados: creados.length, asientos: creados });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error generando asientos' });
  }
});

// POST /api/contabilidad/asientos/generar-desde-compras
//
// Hallazgos #17/#26/#35: antes esta ruta tenía su propia lógica inline con
// códigos PUC 100% hardcodeados y sin ningún CC/sede por ítem — el único de
// los 4 generadores automáticos (facturas/salud/documento-soporte/compras)
// que se había quedado afuera de esos dos refactors. Ahora delega en
// `generarAsientoDesdeFacturaCompra` (asiento-generator.ts), que sí lee
// `configuracion_contable` y propaga el centro_costo_id/sede_id real de cada
// ítem, igual que los otros tres.
router.post('/generar-desde-compras', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { fecha_desde, fecha_hasta } = req.body as { fecha_desde: string; fecha_hasta: string };

    // Usar FacturaCompra (reemplaza ReceivedInvoice)
    const comprasRepo = AppDataSource.getRepository(FacturaCompra);
    const compras = await comprasRepo
      .createQueryBuilder('c')
      .addSelect('c.lines_json')   // select:false — cargar explícitamente
      .where('c.company_id = :cid', { cid })
      .andWhere('c.invoice_date BETWEEN :s AND :e', { s: fecha_desde, e: fecha_hasta })
      .getMany();

    const creados: number[] = [];
    for (const c of compras) {
      const asiento = await generarAsientoDesdeFacturaCompra(c, cid);
      if (asiento) creados.push(asiento.numero!);
    }
    res.json({ generados: creados.length, asientos: creados });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error generando asientos desde compras' });
  }
});


// POST /api/contabilidad/asientos/generar-desde-salud
router.post('/generar-desde-salud', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { fecha_desde, fecha_hasta } = req.body as { fecha_desde: string; fecha_hasta: string };

    // Cargar con eps explícito para garantizar disponibilidad en el servicio
    const facturas = await AppDataSource.getRepository(FacturaSalud)
      .createQueryBuilder('f')
      .leftJoinAndSelect('f.eps', 'eps')
      .where('f.company_id = :cid', { cid })
      .andWhere('f.status IN (:...st)', { st: ['aprobada', 'enviando'] })
      .andWhere('f.issue_date BETWEEN :s AND :e', { s: fecha_desde, e: fecha_hasta })
      .getMany();

    const creados: number[] = [];
    for (const f of facturas) {
      const asiento = await generarAsientoDesdeFacturaSalud(f, cid);
      if (asiento) creados.push(asiento.numero!);
    }
    res.json({ generados: creados.length, asientos: creados });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error generando asientos desde facturas salud' });
  }
});

// DELETE /api/contabilidad/asientos/:id
router.delete('/:id', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const asiento = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!asiento) { res.status(404).json({ error: 'Asiento no encontrado' }); return; }
    if (asiento.estado === 'aprobado') { res.status(400).json({ error: 'No se puede eliminar un asiento aprobado' }); return; }
    if (asiento.estado === 'anulado') { res.status(400).json({ error: 'No se puede eliminar un asiento anulado' }); return; }
    await repo().remove(asiento);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando asiento' });
  }
});

export default router;
