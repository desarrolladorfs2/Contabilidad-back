/**
 * documentos-recibidos.routes.ts
 *
 * Endpoints REST para el módulo Documentos Recibidos.
 * Monta en: /api/compras/documentos-recibidos
 *
 * Bandeja de facturas electrónicas de venta emitidas por proveedores hacia
 * esta empresa (receptor). Se puede crear importando el XML UBL del
 * proveedor (from_xml = true) o de forma 100% manual — igual filosofía que
 * Facturas Recibidas (facturas-compra.routes.ts) — pero además permite
 * registrar los eventos RADIAN del comprador (Res. 000085/2022):
 *   030 Acuse de recibo → 032 Recibo del bien/servicio → 031 Reclamo
 *   ó 033 Aceptación expresa (mutuamente excluyentes) → si ninguno de los
 *   dos, Aceptación tácita (registro manual, sin XML) tras 3 días hábiles.
 *
 * A diferencia de Documento Soporte (donde esta empresa es la EMISORA),
 * aquí esta empresa es la RECEPTORA: los eventos se firman y envían con
 * SenderParty = nuestra empresa, ReceiverParty = el proveedor emisor.
 */

import { Router, Response }  from 'express';
import * as fs               from 'fs';
import { AppDataSource }     from '../../config/database';
import {
  DocumentoRecibido, EstadoDocumentoRecibido, CodigoEventoRadian,
}                             from '../../entities/compras/DocumentoRecibido';
import { CompanySettings }   from '../../entities/CompanySettings';
import { Company }           from '../../entities/Company';
import { Tercero }           from '../../entities/Tercero';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import { resolveUploadPath } from '../../services/uploads.service';
import {
  generateEventXml, signXml, sendEvent, generateInvoicePdf,
} from '../../services/dian.service';

const router = Router();
router.use(authMiddleware);

/** Eventos RADIAN soportados y su prerequisito directo (mismo mapa que el builder Python). */
const EVENTOS_RADIAN: Record<CodigoEventoRadian, string> = {
  '030': 'Acuse de recibo de Factura Electrónica de Venta',
  '031': 'Reclamo de la Factura Electrónica de Venta',
  '032': 'Recibo del bien y/o prestación del servicio',
  '033': 'Aceptación expresa',
  '034': 'Aceptación tácita',
};

// Campos de la entidad donde se persiste cada evento
const EVENT_FIELD_PREFIX: Record<CodigoEventoRadian, string> = {
  '030': 'acuse_recibo',
  '032': 'recibo_bien',
  '031': 'reclamo',
  '033': 'aceptacion_expresa',
  '034': 'aceptacion_tacita',
};

// ── Helper: settings / company / logo ────────────────────────────────────────

async function getSettings(cid: string): Promise<CompanySettings | null> {
  return AppDataSource.getRepository(CompanySettings).findOne({ where: { company_id: cid } });
}
async function getCompany(cid: string): Promise<Company | null> {
  return AppDataSource.getRepository(Company).findOne({ where: { id: cid } });
}
function readLogo(settings: CompanySettings): string | undefined {
  const logoPath = settings.logoParaPdf;
  if (!logoPath) return undefined;
  try { return fs.readFileSync(resolveUploadPath(logoPath)).toString('base64'); } catch { return undefined; }
}

// ── Helper: precargar datos del proveedor desde un tercero registrado ───────

async function precargarTercero(cid: string, terceroId?: string): Promise<Partial<DocumentoRecibido>> {
  if (!terceroId) return {};
  const tercero = await AppDataSource.getRepository(Tercero)
    .findOne({ where: { id: terceroId, company_id: cid } });
  if (!tercero) return {};
  return {
    provider_nit:       tercero.nit,
    provider_id_type:   tercero.tipo_id,
    provider_name:      tercero.nombre,
    provider_address:   tercero.direccion,
    provider_city_code: tercero.ciudad_codigo,
    provider_city_name: tercero.ciudad_nombre,
    provider_email:     tercero.email,
    provider_phone:     tercero.telefono,
  };
}

// ── Helper: payload de PDF (registro interno, no el original del proveedor) ─

function buildPdfPayload(
  company: Company, settings: CompanySettings, dr: DocumentoRecibido, logo_base64?: string,
): Record<string, any> {
  const issuer = {
    nit:            dr.provider_nit       || '',
    name:           dr.provider_name      || '',
    address:        dr.provider_address   || '',
    city_name:      dr.provider_city_name || '',
    document_type:  dr.provider_id_type   || '31',
    tax_level_code: dr.provider_tax_level || 'R-99-PN',
    email:          dr.provider_email     || undefined,
    phone:          dr.provider_phone     || undefined,
  };
  const customer = {
    nit:            company.nit,
    name:           company.name,
    address:        company.address     || '',
    city_name:      company.city_name   || '',
    document_type:  '31',
    tax_level_code: company.tax_level_code || 'O-13',
  };
  const lines: any[] = JSON.parse(dr.lines_json || '[]');

  return {
    issuer, customer,
    prefix:            dr.invoice_prefix     || '',
    number:            dr.invoice_number_str || '',
    issue_date:        dr.invoice_date || new Date().toISOString().slice(0, 10),
    lines,
    subtotal:          +dr.subtotal       || 0,
    discount_total:    +dr.discount_total || 0,
    tax_total:         (+dr.iva_total || 0) + (+dr.inc_total || 0),
    iva_total:         +dr.iva_total       || 0,
    inc_total:         +dr.inc_total       || 0,
    total:             +dr.total           || 0,
    payment_means_id:  dr.payment_means_id  || '1',
    payment_method_id: dr.payment_method_id || '42',
    currency:          dr.currency || 'COP',
    note:              dr.notes || '',
    cufe:              dr.cufe || '',
    document_type:     'compra',
    pdf_primary_color:   settings.pdf_primary_color   || undefined,
    pdf_secondary_color: settings.pdf_secondary_color || undefined,
    logo_base64,
    resolution_number: settings.resolution_number || '',
    resolution_prefix: settings.invoice_prefix    || '',
    software_id:       settings.software_id       || '',
    environment:       settings.environment        || '2',
  };
}

// ── Helper: consulta con blobs opcionales ────────────────────────────────────

async function findDr(id: string, cid: string, withBlobs = false) {
  let qb = AppDataSource.getRepository(DocumentoRecibido)
    .createQueryBuilder('dr')
    .where('dr.id = :id AND dr.company_id = :cid', { id, cid });

  qb = qb.addSelect('dr.lines_json');

  if (withBlobs) {
    qb = qb
      .addSelect('dr.xml_base64')
      .addSelect('dr.pdf_base64')
      .addSelect('dr.acuse_recibo_response').addSelect('dr.acuse_recibo_xml_base64')
      .addSelect('dr.recibo_bien_response').addSelect('dr.recibo_bien_xml_base64')
      .addSelect('dr.reclamo_response').addSelect('dr.reclamo_xml_base64')
      .addSelect('dr.aceptacion_expresa_response').addSelect('dr.aceptacion_expresa_xml_base64')
      .addSelect('dr.aceptacion_tacita_response').addSelect('dr.aceptacion_tacita_xml_base64');
  }
  return qb.getOne();
}

/** Lista de códigos de eventos ya enviados exitosamente (para validar prerequisitos RADIAN) */
function eventosEnviados(dr: DocumentoRecibido): string[] {
  const enviados: string[] = [];
  if (dr.acuse_recibo_en)       enviados.push('030');
  if (dr.recibo_bien_en)        enviados.push('032');
  if (dr.reclamo_en)            enviados.push('031');
  if (dr.aceptacion_expresa_en) enviados.push('033');
  if (dr.aceptacion_tacita_en)  enviados.push('034');
  return enviados;
}

function recalcularEstado(dr: DocumentoRecibido): EstadoDocumentoRecibido {
  if (dr.aceptacion_expresa_en) return 'aceptado_expreso';
  if (dr.aceptacion_tacita_en)  return 'aceptado_tacito';
  if (dr.reclamo_en)            return 'reclamado';
  if (dr.recibo_bien_en)        return 'bien_recibido';
  if (dr.acuse_recibo_en)       return 'acuse_enviado';
  return 'pendiente';
}

// ── GET /  (listar) ───────────────────────────────────────────────────────────

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      page = '1', limit = '20', search = '', estado = '', date_from = '', date_to = '',
    } = req.query as Record<string, string>;
    const cid = req.user!.companyId;

    let qb = AppDataSource.getRepository(DocumentoRecibido)
      .createQueryBuilder('dr')
      .where('dr.company_id = :cid', { cid });

    if (estado)    qb = qb.andWhere('dr.estado = :estado', { estado });
    if (date_from) qb = qb.andWhere('dr.invoice_date >= :df', { df: date_from });
    if (date_to)   qb = qb.andWhere('dr.invoice_date <= :dt', { dt: date_to });
    if (search) {
      const s = `%${search}%`;
      qb = qb.andWhere(
        '(dr.invoice_number_str LIKE :s OR dr.provider_name LIKE :s OR dr.provider_nit LIKE :s)',
        { s },
      );
    }

    const [items, total] = await qb
      // Orden por fecha Y HORA real de creación (created_at), no por la fecha del
      // documento (que es solo el día y puede repetirse/empatar entre varios
      // registros del mismo día, dejando el más nuevo mezclado entre los viejos).
      .orderBy('dr.created_at', 'DESC')
      .skip((+page - 1) * +limit)
      .take(+limit)
      .getManyAndCount();

    res.json({ items, total, page: +page, limit: +limit });
  } catch (e) {
    console.error('[DR] Error listando:', e);
    res.status(500).json({ error: 'Error listando documentos recibidos' });
  }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────

router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const dr = await findDr(req.params.id, req.user!.companyId);
    if (!dr) { res.status(404).json({ error: 'Documento recibido no encontrado' }); return; }
    res.json(dr);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo documento recibido' });
  }
});

// ── POST /  (crear — manual o desde XML importado) ───────────────────────────

router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const body = req.body as Record<string, any>;

    if (!body.centro_costo_id) { res.status(400).json({ error: 'El centro de costo es obligatorio' }); return; }
    if (!body.sede_id) { res.status(400).json({ error: 'La sede es obligatoria' }); return; }

    const [settings, company] = await Promise.all([getSettings(cid), getCompany(cid)]);
    if (!settings || !company) { res.status(400).json({ error: 'Configuración de empresa no encontrada' }); return; }

    const provider = (body.provider as Record<string, any>) || {};
    const terceroData = await precargarTercero(cid, body.proveedor_tercero_id);

    const repo = AppDataSource.getRepository(DocumentoRecibido);
    const drData: Partial<DocumentoRecibido> = {
      company_id:          cid,
      proveedor_tercero_id: body.proveedor_tercero_id || undefined,
      invoice_prefix:      body.invoice_prefix     || undefined,
      invoice_number_str:  body.invoice_number_str || undefined,
      invoice_date:        body.invoice_date       || undefined,
      cufe:                body.cufe               || undefined,
      provider_nit:        provider.id_number      || undefined,
      provider_id_type:    provider.id_type        || undefined,
      provider_name:       provider.name           || undefined,
      provider_address:    provider.address        || undefined,
      provider_city_name:  provider.city_name      || undefined,
      provider_city_code:  provider.city_code      || undefined,
      provider_email:      provider.email          || undefined,
      provider_phone:      provider.phone          || undefined,
      provider_tax_level:  provider.tax_level_code || undefined,
      centro_costo_id:     body.centro_costo_id,
      sede_id:             body.sede_id,
      ciudad_codigo:       body.ciudad_codigo || undefined,
      ciudad_nombre:       body.ciudad_nombre || undefined,
      ...terceroData,
      lines_json:          JSON.stringify(body.lines || []),
      subtotal:            body.subtotal       || 0,
      discount_total:      body.discount_total || 0,
      iva_total:           body.iva_total      || 0,
      inc_total:           body.inc_total      || 0,
      total:               body.total          || 0,
      payment_means_id:    body.payment_means_id  || undefined,
      payment_method_id:   body.payment_method_id || undefined,
      due_date:            body.due_date      || undefined,
      notes:               body.notes         || undefined,
      description:         body.description   || undefined,
      currency:            body.currency      || 'COP',
      from_xml:            !!body.from_xml,
      xml_base64:          body.xml_base64     || undefined,
      estado:              'pendiente',
      creado_por_usuario_id: req.user!.id,
      creado_por_nombre:     req.user!.name || req.user!.email,
    };
    const dr = repo.create(drData);

    const logo = readLogo(settings);
    try {
      const result = await generateInvoicePdf(buildPdfPayload(company, settings, dr, logo)) as any;
      dr.pdf_base64 = result.pdf_base64 || undefined;
    } catch (pyErr: any) {
      console.error('[DR] Error generando PDF:', pyErr?.message || pyErr);
    }

    const saved = await repo.save(dr);
    res.status(201).json({ id: saved.id, invoice_number_str: saved.invoice_number_str });
  } catch (e: any) {
    console.error('[DR] Error creando:', e);
    res.status(500).json({ error: e.message || 'Error creando documento recibido' });
  }
});

// ── PUT /:id  (editar — solo mientras no se haya enviado ningún evento) ──────

router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const dr  = await findDr(req.params.id, cid, true);
    if (!dr) { res.status(404).json({ error: 'Documento recibido no encontrado' }); return; }
    if (dr.estado !== 'pendiente') {
      res.status(400).json({ error: 'No se puede editar un documento con eventos RADIAN ya registrados' });
      return;
    }

    const [settings, company] = await Promise.all([getSettings(cid), getCompany(cid)]);
    if (!settings || !company) { res.status(400).json({ error: 'Configuración no encontrada' }); return; }

    const body = req.body as Record<string, any>;
    const provider = (body.provider as Record<string, any>) || {};

    let terceroData: Partial<DocumentoRecibido> = {};
    if (body.proveedor_tercero_id && body.proveedor_tercero_id !== dr.proveedor_tercero_id) {
      terceroData = await precargarTercero(cid, body.proveedor_tercero_id);
    }

    Object.assign(dr, {
      proveedor_tercero_id: body.proveedor_tercero_id ?? dr.proveedor_tercero_id,
      invoice_prefix:      body.invoice_prefix     ?? dr.invoice_prefix,
      invoice_number_str:  body.invoice_number_str ?? dr.invoice_number_str,
      invoice_date:        body.invoice_date       ?? dr.invoice_date,
      cufe:                body.cufe               ?? dr.cufe,
      provider_nit:        provider.id_number      ?? dr.provider_nit,
      provider_id_type:    provider.id_type        ?? dr.provider_id_type,
      provider_name:       provider.name           ?? dr.provider_name,
      provider_address:    provider.address        ?? dr.provider_address,
      provider_city_name:  provider.city_name      ?? dr.provider_city_name,
      provider_city_code:  provider.city_code      ?? dr.provider_city_code,
      provider_email:      provider.email          ?? dr.provider_email,
      provider_phone:      provider.phone          ?? dr.provider_phone,
      provider_tax_level:  provider.tax_level_code ?? dr.provider_tax_level,
      ...terceroData,
      lines_json:          body.lines ? JSON.stringify(body.lines) : dr.lines_json,
      subtotal:            body.subtotal       ?? dr.subtotal,
      discount_total:      body.discount_total ?? dr.discount_total,
      iva_total:           body.iva_total      ?? dr.iva_total,
      inc_total:           body.inc_total      ?? dr.inc_total,
      total:               body.total          ?? dr.total,
      payment_means_id:    body.payment_means_id  ?? dr.payment_means_id,
      payment_method_id:   body.payment_method_id ?? dr.payment_method_id,
      due_date:            body.due_date      ?? dr.due_date,
      notes:               body.notes         ?? dr.notes,
      description:         body.description   ?? dr.description,
      currency:            body.currency      ?? dr.currency,
      centro_costo_id:     body.centro_costo_id ?? dr.centro_costo_id,
      sede_id:             body.sede_id         ?? dr.sede_id,
      ciudad_codigo:       body.ciudad_codigo   ?? dr.ciudad_codigo,
      ciudad_nombre:       body.ciudad_nombre   ?? dr.ciudad_nombre,
    });

    const logo = readLogo(settings);
    try {
      const result = await generateInvoicePdf(buildPdfPayload(company, settings, dr, logo)) as any;
      dr.pdf_base64 = result.pdf_base64 || dr.pdf_base64;
    } catch (pyErr: any) {
      console.error('[DR] Error regenerando PDF:', pyErr?.message || pyErr);
    }

    const saved = await AppDataSource.getRepository(DocumentoRecibido).save(dr);
    res.json({ id: saved.id, invoice_number_str: saved.invoice_number_str });
  } catch (e: any) {
    console.error('[DR] Error actualizando:', e);
    res.status(500).json({ error: e.message || 'Error actualizando documento recibido' });
  }
});

// ── DELETE /:id  (solo si no tiene eventos registrados) ──────────────────────

router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const dr  = await findDr(req.params.id, cid);
    if (!dr) { res.status(404).json({ error: 'Documento recibido no encontrado' }); return; }
    if (dr.estado !== 'pendiente') {
      res.status(400).json({ error: 'No se puede eliminar un documento con eventos RADIAN ya registrados' });
      return;
    }
    await AppDataSource.getRepository(DocumentoRecibido).remove(dr);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando documento recibido' });
  }
});

// ── POST /:id/eventos/:codigo  (enviar un evento RADIAN a la DIAN) ──────────
// :codigo ∈ 030 (acuse de recibo) | 032 (recibo del bien) | 031 (reclamo)
//          | 033 (aceptación expresa) | 034 (aceptación tácita)
//
// Body esperado según :codigo:
//   031 → { categoria: '01'|'02', motivo: string }  (categoria = FaltadeAceptacion.gc)
//   032 → { persona_receptora?: { cedula, tipo_id, nombre, apellido, cargo, departamento } }
//   034 → {}  (nota jurada obligatoria la añade el builder Python; ReceiverParty = DIAN)
//   030/otros → { nota?: string }

router.post('/:id/eventos/:codigo', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid    = req.user!.companyId;
    const codigo = req.params.codigo as CodigoEventoRadian;
    if (!EVENTOS_RADIAN[codigo]) {
      res.status(400).json({ error: `Código de evento RADIAN inválido: ${codigo}` }); return;
    }

    const dr = await findDr(req.params.id, cid, true);
    if (!dr) { res.status(404).json({ error: 'Documento recibido no encontrado' }); return; }
    if (!dr.cufe) {
      res.status(400).json({ error: 'El documento no tiene CUFE registrado — requerido para enviar eventos RADIAN' });
      return;
    }

    if (codigo === '031' && !req.body?.categoria) {
      res.status(400).json({ error: 'El reclamo requiere "categoria" (01 = falta de aceptación parcial, 02 = falta de aceptación total)' });
      return;
    }

    const settingsRepo = AppDataSource.getRepository(CompanySettings);
    const [settings, company] = await Promise.all([getSettings(cid), getCompany(cid)]);
    if (!settings || !company) { res.status(400).json({ error: 'Configuración no encontrada' }); return; }

    const sentEvents = eventosEnviados(dr);
    const invoiceId  = dr.invoice_prefix
      ? `${dr.invoice_prefix}${dr.invoice_number_str}`
      : (dr.invoice_number_str || '');

    // Consecutivo "Número del evento" (cbc:ID) — no puede repetirse para un mismo
    // tipo de evento; un contador global compartido lo garantiza trivialmente.
    const eventoNumero = settings.next_radian_evento_number || 1;

    // 1. Construir XML del evento (valida prerequisitos/exclusiones RADIAN en Python)
    const buildResult = await generateEventXml({
      event_code:        codigo,
      invoice_id:        invoiceId,
      invoice_cufe:      dr.cufe,
      sender_nit:        company.nit,
      sender_name:       company.name,
      receiver_nit:      dr.provider_nit  || '',
      receiver_name:     dr.provider_name || '',
      evento_numero:     eventoNumero,
      software_pin:      settings.softwarePinRadianEfectivo || '',
      software_id:       settings.softwareIdRadianEfectivo  || '',
      note:              req.body?.nota || '',
      environment:       settings.environment || '2',
      sent_events:       sentEvents,
      motivo_categoria:    codigo === '031' ? (req.body?.categoria || '') : '',
      motivo_descripcion:  codigo === '031' ? (req.body?.motivo    || '') : '',
      // Obligatorio para TODOS los eventos RADIAN (no solo 032) — la DIAN
      // exige el grupo cac:IssuerParty/cac:Person con la persona que registra
      // el evento; sin él rechaza con AAH12/13/15/16 (ver application_response_builder.py).
      persona_receptora:   req.body?.persona_receptora || null,
    }) as Record<string, unknown>;
    if (!buildResult.success) {
      res.status(400).json({ error: buildResult.error as string || 'Error construyendo evento RADIAN' });
      return;
    }
    const xmlBase64 = buildResult.xml_base64 as string;
    const eventoId  = buildResult.event_id   as string;

    // Consumir el consecutivo solo una vez construido correctamente el XML
    await settingsRepo.increment({ id: settings.id }, 'next_radian_evento_number', 1);

    // 2. Firmar (reutiliza el firmador genérico — igual que facturas/DS)
    //
    // IMPORTANTE: signXml() usa callPythonCli(), que RESUELVE la promesa
    // incluso cuando la firma falla (success:false) — no lanza excepción.
    // Antes este bloque solo revisaba el catch(), así que una firma fallida
    // pasaba desapercibida y el código seguía adelante con signedXml/zipBase64
    // en undefined, terminando en "zipToSend = xmlBase64" — es decir, se
    // transmitía a la DIAN el evento SIN FIRMAR. Eso es exactamente lo que
    // producía el rechazo "AAC01: no fue informado el grupo .../ds:Signature":
    // no era la DIAN detectando una firma mal puesta, es que nunca se firmó.
    // Ahora se corta aquí mismo si la firma no fue exitosa, en vez de
    // desperdiciar un envío a la DIAN con un documento inválido.
    const filename = eventoId || `EVT-${codigo}`;
    let signedXml: string | undefined;
    let zipBase64:  string | undefined;
    try {
      const signResult = await signXml(xmlBase64, { invoice_number: filename }, settings) as any;
      if (!signResult?.success || !(signResult.zip_base64 || signResult.signed_xml_base64)) {
        res.status(400).json({
          error: `No se pudo firmar el evento RADIAN: ${signResult?.error || 'error desconocido del firmador'}`,
        });
        return;
      }
      signedXml  = signResult.signed_xml_base64;
      zipBase64  = signResult.zip_base64;
    } catch (signErr: any) {
      res.status(400).json({ error: `No se pudo firmar el evento RADIAN: ${signErr?.message || signErr}` });
      return;
    }

    // 3. Enviar a la DIAN (send-event — distinto de send-bill-sync usado por facturas/DS)
    const zipToSend = zipBase64 || signedXml as string;
    let dianResult: Record<string, unknown> = {};
    let statusCode = '';
    let statusDesc = '';
    try {
      dianResult = await sendEvent(zipToSend, filename, settings.environment || '2', settings) as Record<string, unknown>;
      statusCode = (
        (dianResult as any)?.status_code ?? (dianResult as any)?.StatusCode ?? ''
      ).toString();
      statusDesc = (
        (dianResult as any)?.status_message ?? (dianResult as any)?.StatusDescription ?? ''
      ).toString();
    } catch (txErr: any) {
      console.error('[DR] Error enviando evento RADIAN a la DIAN:', txErr?.message || txErr);
      statusDesc = txErr.message;
    }

    // 4. Persistir en las columnas del evento correspondiente
    // IMPORTANTE: el evento solo se da por "enviado" (marca de fecha, bloqueo de
    // reenvío, avance de estado) cuando la DIAN lo aceptó de verdad
    // (status_code === '00'). Si la DIAN lo rechazó por errores de validación
    // (p.ej. status_code '99'), NO se marca como enviado — así el botón sigue
    // disponible para volver a intentarlo, en vez de quedar bloqueado con un
    // evento que en realidad nunca quedó registrado ante la DIAN.
    const aceptadoPorDian = statusCode === '00';
    const prefix = EVENT_FIELD_PREFIX[codigo];
    if (aceptadoPorDian) {
      (dr as any)[`${prefix}_en`] = new Date();
    }
    (dr as any)[`${prefix}_evento_id`]    = eventoId;
    (dr as any)[`${prefix}_status_code`]  = statusCode || undefined;
    (dr as any)[`${prefix}_response`]     = JSON.stringify(dianResult);
    (dr as any)[`${prefix}_xml_base64`]   = signedXml || xmlBase64;
    if (codigo === '031') {
      if (req.body?.categoria) dr.reclamo_categoria = req.body.categoria;
      if (req.body?.motivo)    dr.reclamo_motivo     = req.body.motivo;
    }

    dr.estado = recalcularEstado(dr);
    await AppDataSource.getRepository(DocumentoRecibido).save(dr);

    const dianErrors = ((dianResult as any)?.errors as string[] | undefined) || [];
    if (!aceptadoPorDian) {
      res.status(400).json({
        error: statusDesc || 'La DIAN rechazó el evento',
        status_code: statusCode,
        status_desc: statusDesc,
        errors: dianErrors,
        dian_response: dianResult,
      });
      return;
    }

    res.json({
      estado:      dr.estado,
      evento_id:   eventoId,
      status_code: statusCode,
      status_desc: statusDesc,
      errors:      dianErrors,
      dian_response: dianResult,
    });
  } catch (e: any) {
    console.error('[DR] Error procesando evento RADIAN:', e);
    res.status(500).json({ error: e.message || 'Error procesando evento RADIAN' });
  }
});

// NOTA: el endpoint manual `POST /:id/aceptacion-tacita` (registro sin XML/DIAN)
// fue retirado. La Aceptación tácita (034) es un evento RADIAN real y
// transmisible a la DIAN (ApplicationResponse con ReceiverParty = DIAN) y ahora
// se envía con el flujo genérico `POST /:id/eventos/034`, igual que los demás.

// ── GET /:id/pdf ──────────────────────────────────────────────────────────────

router.get('/:id/pdf', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const dr  = await findDr(req.params.id, cid, true);
    if (!dr || !dr.pdf_base64) { res.status(404).json({ error: 'PDF no encontrado' }); return; }

    const buf = Buffer.from(dr.pdf_base64, 'base64');
    const filename = `DR-${(dr.invoice_number_str || dr.id).replace(/[^a-zA-Z0-9\-_]/g, '_')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: 'Error descargando PDF' });
  }
});

// ── GET /:id/xml  (XML original importado del proveedor) ─────────────────────

router.get('/:id/xml', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const dr  = await findDr(req.params.id, cid, true);
    if (!dr || !dr.xml_base64) { res.status(404).json({ error: 'XML no disponible' }); return; }

    const buf = Buffer.from(dr.xml_base64, 'base64');
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="${dr.invoice_number_str || dr.id}.xml"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: 'Error descargando XML' });
  }
});

// ── GET /:id/eventos/:codigo/xml  (XML firmado del evento RADIAN transmitido) ─
// Solo para diagnóstico: descarga exactamente el XML que se firmó y se envió
// a la DIAN para ese evento, para poder revisarlo cuando la DIAN rechaza.

router.get('/:id/eventos/:codigo/xml', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid    = req.user!.companyId;
    const codigo = req.params.codigo as CodigoEventoRadian;
    if (!EVENT_FIELD_PREFIX[codigo]) { res.status(400).json({ error: 'Código de evento inválido' }); return; }

    const dr = await findDr(req.params.id, cid, true);
    if (!dr) { res.status(404).json({ error: 'Documento recibido no encontrado' }); return; }

    const prefix = EVENT_FIELD_PREFIX[codigo];
    const xmlB64 = (dr as any)[`${prefix}_xml_base64`] as string | undefined;
    if (!xmlB64) { res.status(404).json({ error: 'Ese evento aún no se ha enviado' }); return; }

    const buf = Buffer.from(xmlB64, 'base64');
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="evento-${codigo}-${dr.id}.xml"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: 'Error descargando XML del evento' });
  }
});

export default router;
