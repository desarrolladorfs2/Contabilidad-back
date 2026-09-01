import { Router, Response } from 'express';
import { AppDataSource } from '../config/database';
import { Cotizacion }       from '../entities/Cotizacion';
import { CotizacionLinea }  from '../entities/CotizacionLinea';
import { Secuencia }        from '../entities/Secuencia';
import { Tercero }          from '../entities/Tercero';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { registrarAuditoria, AUDITORIA_ACCION, AUDITORIA_ENTIDAD } from '../services/auditoria.service';

const router = Router();
router.use(authMiddleware);

const repo      = () => AppDataSource.getRepository(Cotizacion);
const lineaRepo = () => AppDataSource.getRepository(CotizacionLinea);
const seqRepo   = () => AppDataSource.getRepository(Secuencia);

// ── Helper: siguiente número de secuencia ─────────────────────────────────────
async function siguienteNumero(cid: string, prefijo = 'COT'): Promise<string> {
  return AppDataSource.transaction(async (em) => {
    const seqR = em.getRepository(Secuencia);
    let seq = await seqR.findOne({ where: { company_id: cid, entidad: 'cotizacion' } });
    if (!seq) {
      seq = seqR.create({
        company_id: cid, entidad: 'cotizacion',
        prefijo: prefijo, ultimo_numero: 0,
        longitud_minima: 4, incluir_anio: true,
      });
    }
    const anio = new Date().getFullYear();
    if (seq.reiniciar_anio && seq.anio_actual && seq.anio_actual !== anio) {
      seq.ultimo_numero = 0;
    }
    seq.ultimo_numero += 1;
    seq.anio_actual = anio;
    await seqR.save(seq);
    const numStr = String(seq.ultimo_numero).padStart(seq.longitud_minima, '0');
    return seq.incluir_anio ? `${seq.prefijo}-${anio}-${numStr}` : `${seq.prefijo}-${numStr}`;
  });
}

// ── GET /api/cotizaciones ─────────────────────────────────────────────────────
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { q = '', estado } = req.query as Record<string, string>;

    const qb = repo()
      .createQueryBuilder('c')
      .where('c.company_id = :cid', { cid })
      .orderBy('c.created_at', 'DESC')
      .take(200);

    if (q) {
      qb.andWhere('(c.numero LIKE :q OR c.cliente_nombre LIKE :q OR c.cliente_nit LIKE :q)', { q: `%${q}%` });
    }
    if (estado) qb.andWhere('c.estado = :estado', { estado });

    const items = await qb.getMany();
    res.json(items);
  } catch { res.status(500).json({ error: 'Error listando cotizaciones' }); }
});

// ── GET /api/cotizaciones/:id ─────────────────────────────────────────────────
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const c = await repo().findOne({
      where: { id: req.params.id, company_id: req.user!.companyId },
      relations: ['lineas'],
    });
    if (!c) { res.status(404).json({ error: 'Cotización no encontrada' }); return; }
    res.json(c);
  } catch { res.status(500).json({ error: 'Error obteniendo cotización' }); }
});

// ── POST /api/cotizaciones ────────────────────────────────────────────────────
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const {
      tercero_id, cliente_nombre, cliente_nit, cliente_email,
      fecha_emision, fecha_vencimiento, moneda_codigo, tasa_cambio,
      lista_precio_id, terminos_condiciones, observaciones_cliente,
      notas_internas, lineas = [],
    } = req.body;

    // Resolver snapshot del cliente si se pasó tercero_id
    let snapNombre = cliente_nombre, snapNit = cliente_nit, snapEmail = cliente_email;
    if (tercero_id && !snapNombre) {
      const t = await AppDataSource.getRepository(Tercero).findOne({
        where: { id: tercero_id, company_id: cid },
      });
      if (t) { snapNombre = t.nombre; snapNit = t.nit; snapEmail = t.email; }
    }

    const numero = await siguienteNumero(cid);

    // Calcular totales desde las líneas enviadas
    let subtotal = 0, descuento_total = 0, iva_total = 0, inc_total = 0;
    for (const l of lineas) {
      subtotal        += parseFloat(l.subtotal || 0);
      descuento_total += parseFloat(l.descuento_valor || 0);
      iva_total       += parseFloat(l.valor_iva || 0);
      inc_total       += parseFloat(l.valor_inc || 0);
    }
    const impuestos_total = iva_total + inc_total;
    const total = subtotal + impuestos_total;

    const c = repo().create({
      company_id: cid, numero, prefijo: 'COT',
      tercero_id: tercero_id || undefined,
      cliente_nombre: snapNombre, cliente_nit: snapNit, cliente_email: snapEmail,
      fecha_emision: fecha_emision || new Date().toISOString().split('T')[0],
      fecha_vencimiento: fecha_vencimiento || undefined,
      estado: 'borrador',
      moneda_codigo: moneda_codigo || 'COP',
      tasa_cambio: parseFloat(tasa_cambio) || 1,
      lista_precio_id: lista_precio_id || undefined,
      usuario_id:     req.user!.id,
      usuario_nombre: req.user!.name,
      subtotal, descuento_total, iva_total, inc_total, impuestos_total, total,
      terminos_condiciones, observaciones_cliente, notas_internas,
    });

    await repo().save(c);
    await registrarAuditoria({ req, accion: AUDITORIA_ACCION.CREAR, entidad: AUDITORIA_ENTIDAD.COTIZACION, entidadId: c.id, datosNuevos: { numero: c.numero, total: c.total } });

    // Guardar líneas
    for (let i = 0; i < lineas.length; i++) {
      const l = lineas[i];
      const lin = lineaRepo().create({
        cotizacion_id: c.id,
        linea_numero: i + 1,
        producto_id: l.producto_id || undefined,
        descripcion: l.descripcion || '',
        detalle: l.detalle,
        cantidad: parseFloat(l.cantidad) || 1,
        unidad_medida_codigo: l.unidad_medida_codigo || 'EA',
        precio_unitario: parseFloat(l.precio_unitario) || 0,
        descuento_pct: parseFloat(l.descuento_pct) || 0,
        descuento_valor: parseFloat(l.descuento_valor) || 0,
        subtotal: parseFloat(l.subtotal) || 0,
        tipo_tributo_codigo: l.tipo_tributo_codigo || 'ZZ',
        tarifa_iva: parseFloat(l.tarifa_iva) || 0,
        tarifa_inc: parseFloat(l.tarifa_inc) || 0,
        valor_iva: parseFloat(l.valor_iva) || 0,
        valor_inc: parseFloat(l.valor_inc) || 0,
        total: parseFloat(l.total) || 0,
      });
      await lineaRepo().save(lin);
    }

    const saved = await repo().findOne({ where: { id: c.id }, relations: ['lineas'] });
    res.status(201).json(saved);
  } catch (e) {
    console.error('[Cotizaciones POST]', e);
    res.status(500).json({ error: 'Error creando cotización' });
  }
});

// ── PUT /api/cotizaciones/:id ─────────────────────────────────────────────────
router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const c = await repo().findOne({ where: { id: req.params.id, company_id: cid } });
    if (!c) { res.status(404).json({ error: 'Cotización no encontrada' }); return; }
    if (c.estado !== 'borrador') {
      res.status(409).json({ error: 'Solo se puede editar una cotización en borrador' }); return;
    }

    const allowed = [
      'tercero_id','cliente_nombre','cliente_nit','cliente_email',
      'fecha_emision','fecha_vencimiento','moneda_codigo','tasa_cambio',
      'lista_precio_id','terminos_condiciones','observaciones_cliente','notas_internas',
    ];
    allowed.forEach(k => { if (req.body[k] !== undefined) (c as any)[k] = req.body[k]; });

    // Recalcular totales si vienen líneas
    if (req.body.lineas) {
      // Borrar líneas existentes y recrear
      await lineaRepo().delete({ cotizacion_id: c.id });
      const lineas = req.body.lineas || [];
      let subtotal = 0, descuento_total = 0, iva_total = 0, inc_total = 0;
      for (let i = 0; i < lineas.length; i++) {
        const l = lineas[i];
        subtotal        += parseFloat(l.subtotal || 0);
        descuento_total += parseFloat(l.descuento_valor || 0);
        iva_total       += parseFloat(l.valor_iva || 0);
        inc_total       += parseFloat(l.valor_inc || 0);
        await lineaRepo().save(lineaRepo().create({
          cotizacion_id: c.id, linea_numero: i + 1,
          producto_id: l.producto_id || undefined,
          descripcion: l.descripcion || '',
          cantidad: parseFloat(l.cantidad) || 1,
          unidad_medida_codigo: l.unidad_medida_codigo || 'EA',
          precio_unitario: parseFloat(l.precio_unitario) || 0,
          descuento_pct: parseFloat(l.descuento_pct) || 0,
          descuento_valor: parseFloat(l.descuento_valor) || 0,
          subtotal: parseFloat(l.subtotal) || 0,
          tipo_tributo_codigo: l.tipo_tributo_codigo || 'ZZ',
          tarifa_iva: parseFloat(l.tarifa_iva) || 0,
          tarifa_inc: parseFloat(l.tarifa_inc) || 0,
          valor_iva: parseFloat(l.valor_iva) || 0,
          valor_inc: parseFloat(l.valor_inc) || 0,
          total: parseFloat(l.total) || 0,
        }));
      }
      c.subtotal = subtotal;
      c.descuento_total = descuento_total;
      c.iva_total = iva_total;
      c.inc_total = inc_total;
      c.impuestos_total = iva_total + inc_total;
      c.total = subtotal + iva_total + inc_total;
    }

    await repo().save(c);
    const saved = await repo().findOne({ where: { id: c.id }, relations: ['lineas'] });
    res.json(saved);
  } catch {
    res.status(500).json({ error: 'Error actualizando cotización' });
  }
});

// ── PATCH /api/cotizaciones/:id/estado ───────────────────────────────────────
router.patch('/:id/estado', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const c = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!c) { res.status(404).json({ error: 'Cotización no encontrada' }); return; }

    const { estado } = req.body;
    const validos = ['borrador','enviada','aprobada','rechazada','vencida'];
    if (!validos.includes(estado)) {
      res.status(400).json({ error: `Estado inválido. Válidos: ${validos.join(', ')}` }); return;
    }
    c.estado = estado;
    await repo().save(c);
    res.json({ id: c.id, estado: c.estado });
  } catch { res.status(500).json({ error: 'Error cambiando estado' }); }
});

// ── POST /api/cotizaciones/:id/convertir (→ factura) ─────────────────────────
// Por ahora devuelve 501; se implementará cuando el módulo de facturas esté integrado.
router.post('/:id/convertir', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const c = await repo().findOne({
      where: { id: req.params.id, company_id: req.user!.companyId },
      relations: ['lineas'],
    });
    if (!c) { res.status(404).json({ error: 'Cotización no encontrada' }); return; }
    if (c.estado !== 'aprobada') {
      res.status(409).json({ error: 'Solo se puede convertir una cotización aprobada' }); return;
    }
    if (c.convertida_a_factura_id) {
      res.status(409).json({ error: 'Esta cotización ya fue convertida a factura' }); return;
    }
    // TODO: integrar con invoices cuando el flujo esté listo
    res.status(501).json({ error: 'Conversión a factura en desarrollo. Crea la factura manualmente por ahora.' });
  } catch { res.status(500).json({ error: 'Error convirtiendo cotización' }); }
});

export default router;
