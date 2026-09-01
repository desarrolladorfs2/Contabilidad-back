import { Router, Response } from 'express';
import { AppDataSource } from '../config/database';
import { ReceivedInvoice, RadianEvent } from '../entities/ReceivedInvoice';
import { CompanySettings } from '../entities/CompanySettings';
import { Tercero } from '../entities/Tercero';
import { authMiddleware, requireRole, AuthRequest } from '../middleware/auth.middleware';
import { generateEventXml, signXml, sendEvent } from '../services/dian.service';
import { v4 as uuidv4 } from 'uuid';
import { parseStringPromise } from 'xml2js';
import { registrarAuditoria, AUDITORIA_ACCION, AUDITORIA_ENTIDAD } from '../services/auditoria.service';

/** Busca un Tercero registrado por NIT para auto-enlazar en facturas recibidas */
async function findTerceroByNit(companyId: string, nit: string): Promise<string | undefined> {
  if (!nit) return undefined;
  const t = await AppDataSource.getRepository(Tercero).findOne({
    where: { company_id: companyId, nit },
    select: ['id'],
  });
  return t?.id;
}

const router = Router();
router.use(authMiddleware);

// Mapa de eventos RADIAN
const RADIAN_EVENTS: Record<string, string> = {
  '030': 'Acuse de Recibo de FEV',
  '031': 'Reclamo de la FEV',
  '032': 'Recibo del Bien o Prestación del Servicio',
  '033': 'Aceptación Expresa',
};

const RADIAN_PREREQUISITES: Record<string, string[]> = {
  '030': [],
  '031': ['030'],
  '032': ['030'],
  '033': ['030', '032'],
};

const RADIAN_EXCLUSIONS: Record<string, string[]> = {
  '033': ['031'],
  '031': ['033'],
};

function statusFromEvents(events: RadianEvent[]): ReceivedInvoice['status'] {
  const codes = events.filter(e => e.success).map(e => e.code);
  if (codes.includes('033')) return 'aceptada';
  if (codes.includes('031')) return 'reclamada';
  if (codes.includes('032')) return 'bien_recibido';
  if (codes.includes('030')) return 'acuse_enviado';
  return 'pendiente';
}

// GET /api/received?page=1&limit=20&status=&search=&date_from=&date_to=
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { page = '1', limit = '20', status, search, date_from, date_to } = req.query as Record<string, string>;
    const qb = AppDataSource.getRepository(ReceivedInvoice)
      .createQueryBuilder('r')
      .where('r.company_id = :cid', { cid: req.user!.companyId })
      .orderBy('r.registered_at', 'DESC')
      .skip((+page - 1) * +limit)
      .take(+limit);
    if (status)    qb.andWhere('r.status = :status', { status });
    if (search)    qb.andWhere('(r.invoice_id LIKE :q OR r.provider_nit LIKE :q OR r.provider_name LIKE :q)', { q: `%${search}%` });
    if (date_from) qb.andWhere('r.invoice_date >= :df', { df: date_from });
    if (date_to)   qb.andWhere('r.invoice_date <= :dt', { dt: date_to });
    const [items, total] = await qb.getManyAndCount();
    res.json({ items, total, page: +page, limit: +limit });
  } catch (e) {
    res.status(500).json({ error: 'Error listando facturas recibidas' });
  }
});

// GET /api/received/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const ri = await AppDataSource.getRepository(ReceivedInvoice).findOne({
      where: { id: req.params.id, company_id: req.user!.companyId },
    });
    if (!ri) { res.status(404).json({ error: 'Factura recibida no encontrada' }); return; }
    res.json(ri);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo factura recibida' });
  }
});

// POST /api/received — registrar factura recibida manualmente
router.post('/', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const repo = AppDataSource.getRepository(ReceivedInvoice);
    const { invoice_id, provider_nit, force } = req.body;

    // Verificar duplicado (mismo numero de factura + NIT proveedor)
    if (invoice_id && provider_nit && !force) {
      const existing = await repo.findOne({
        where: { company_id: req.user!.companyId, invoice_id, provider_nit },
      });
      if (existing) {
        res.status(409).json({
          error:        'duplicate',
          invoice_id,
          provider_nit,
          provider_name: existing.provider_name || req.body.provider_name || '',
          existing_id:  existing.id,
        });
        return;
      }
    }

    const terceroId = req.body.provider_nit
      ? await findTerceroByNit(req.user!.companyId, req.body.provider_nit)
      : undefined;

    const ri = repo.create({
      company_id:    req.user!.companyId,
      invoice_id:    req.body.invoice_id,
      invoice_cufe:  req.body.invoice_cufe,
      invoice_date:  req.body.invoice_date,
      subtotal:      req.body.subtotal != null ? req.body.subtotal : undefined,
      tax_total:     req.body.tax_total  != null ? req.body.tax_total  : undefined,
      total:         req.body.total || 0,
      currency:      req.body.currency || 'COP',
      provider_nit:  req.body.provider_nit,
      provider_name: req.body.provider_name,
      tercero_id:    terceroId,
      lines:         req.body.lines,
      raw_xml_base64: req.body.raw_xml_base64,
      status:        'pendiente',
      sent_events:   [],
    });
    ri.created_by_user_id = req.user!.id;
    ri.created_by_name    = req.user!.name;
    await repo.save(ri);
    await registrarAuditoria({ req, accion: AUDITORIA_ACCION.CREAR, entidad: AUDITORIA_ENTIDAD.FACTURA_RECIBIDA, entidadId: ri.id, datosNuevos: { invoice_id: ri.invoice_id, total: ri.total } });
    res.status(201).json(ri);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Error registrando factura';
    res.status(500).json({ error: msg });
  }
});

// POST /api/received/import-xml — importar factura desde XML UBL 2.1 DIAN
router.post('/import-xml', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { xml_base64 } = req.body as { xml_base64: string };
    if (!xml_base64) { res.status(400).json({ error: 'Se requiere xml_base64' }); return; }

    const xmlBuffer = Buffer.from(xml_base64, 'base64');
    const xmlStr = xmlBuffer.toString('utf-8');

    // Parsear XML con xml2js — explicitArray:false para acceso directo a valores escalares
    // tagNameProcessors elimina prefijos de namespace (cbc:, cac:, etc.)
    const parsed = await parseStringPromise(xmlStr, {
      explicitArray: false,
      tagNameProcessors: [(name: string) => name.replace(/^[^:]+:/, '')],
      attrNameProcessors: [(name: string) => name.replace(/^[^:]+:/, '')],
    });

    // La raiz puede ser Invoice u otro nombre; tomamos la primera clave
    const rootKey = Object.keys(parsed)[0];
    const doc = (parsed[rootKey] ?? {}) as Record<string, unknown>;

    // Helper: navega por keys y extrae el valor escalar
    const getVal = (obj: Record<string, unknown>, ...keys: string[]): string => {
      let cur: unknown = obj;
      for (const k of keys) {
        if (cur == null || typeof cur !== 'object') return '';
        cur = (cur as Record<string, unknown>)[k];
      }
      if (cur == null) return '';
      if (typeof cur === 'object') {
        // xml2js pone el texto en '_' cuando hay atributos en el nodo
        return String((cur as Record<string, unknown>)['_'] ?? '');
      }
      return String(cur);
    };

    // Extraer campos UBL 2.1
    const invoice_id   = getVal(doc, 'ID');
    const invoice_date = getVal(doc, 'IssueDate');
    const currency     = getVal(doc, 'DocumentCurrencyCode');

    const supplier     = (doc['AccountingSupplierParty'] ?? {}) as Record<string, unknown>;
    const party        = (supplier['Party'] ?? {}) as Record<string, unknown>;
    const taxScheme    = (party['PartyTaxScheme'] ?? {}) as Record<string, unknown>;
    const legalEntity  = (party['PartyLegalEntity'] ?? {}) as Record<string, unknown>;
    const provider_nit  = getVal(taxScheme, 'CompanyID');
    const provider_name = getVal(legalEntity, 'RegistrationName');

    const monetary      = (doc['LegalMonetaryTotal'] ?? {}) as Record<string, unknown>;
    const subtotal      = parseFloat(getVal(monetary, 'LineExtensionAmount') || '0');
    const total_with_tax = parseFloat(getVal(monetary, 'TaxInclusiveAmount') || '0');

    const taxTotalRaw  = (doc['TaxTotal'] ?? {}) as Record<string, unknown>;
    const tax_amount   = parseFloat(getVal(taxTotalRaw, 'TaxAmount') || '0');

    // Lineas de detalle
    const rawLines = doc['InvoiceLine'];
    const linesArr: unknown[] = rawLines
      ? (Array.isArray(rawLines) ? rawLines : [rawLines])
      : [];

    const lines = linesArr.map((l: unknown) => {
      const line  = (l ?? {}) as Record<string, unknown>;
      const item  = (line['Item']  ?? {}) as Record<string, unknown>;
      const price = (line['Price'] ?? {}) as Record<string, unknown>;
      return {
        id:          getVal(line, 'ID'),
        quantity:    parseFloat(getVal(line, 'InvoicedQuantity') || '0'),
        unit_price:  parseFloat(getVal(price, 'PriceAmount') || '0'),
        line_total:  parseFloat(getVal(line, 'LineExtensionAmount') || '0'),
        description: getVal(item, 'Description'),
      };
    });

    const fallbackId = 'XML-' + Date.now();
    const finalInvoiceId = invoice_id || fallbackId;
    const repo = AppDataSource.getRepository(ReceivedInvoice);

    // Verificar duplicado: mismo numero de factura + NIT proveedor, a menos que force=true
    const { force } = req.body as { force?: boolean };
    if (finalInvoiceId && provider_nit && !force) {
      const existing = await repo.findOne({
        where: { company_id: req.user!.companyId, invoice_id: finalInvoiceId, provider_nit },
      });
      if (existing) {
        res.status(409).json({
          error:        'duplicate',
          invoice_id:   finalInvoiceId,
          provider_nit,
          provider_name,
          existing_id:  existing.id,
        });
        return;
      }
    }

    const terceroId = provider_nit
      ? await findTerceroByNit(req.user!.companyId, provider_nit)
      : undefined;

    const ri = repo.create({
      company_id:     req.user!.companyId,
      invoice_id:     finalInvoiceId,
      invoice_date:   invoice_date || undefined,
      currency:       currency || 'COP',
      provider_nit:   provider_nit || undefined,
      provider_name:  provider_name || undefined,
      tercero_id:     terceroId,
      subtotal:       subtotal || undefined,
      tax_total:      tax_amount || undefined,
      total:          total_with_tax || subtotal || 0,
      lines,
      raw_xml_base64: xml_base64,
      status:         'pendiente',
      sent_events:    [],
    });

    await repo.save(ri);
    res.status(201).json({ ...ri, _parsed: { subtotal, tax_amount, total_with_tax } });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Error importando XML';
    res.status(500).json({ error: msg });
  }
});

// DELETE /api/received/:id
router.delete('/:id', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const repo = AppDataSource.getRepository(ReceivedInvoice);
    const ri = await repo.findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!ri) { res.status(404).json({ error: 'No encontrada' }); return; }
    await repo.remove(ri);
    res.json({ message: 'Eliminada' });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando' });
  }
});

// POST /api/received/:id/events — enviar evento RADIAN
router.post('/:id/events', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { event_code } = req.body as { event_code: string };
    if (!RADIAN_EVENTS[event_code]) {
      res.status(400).json({ error: `Codigo de evento invalido: ${event_code}` }); return;
    }

    const repo = AppDataSource.getRepository(ReceivedInvoice);
    const ri = await repo.findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!ri) { res.status(404).json({ error: 'Factura recibida no encontrada' }); return; }

    const settings = await AppDataSource.getRepository(CompanySettings)
      .findOne({ where: { company_id: req.user!.companyId } });
    if (!settings) { res.status(400).json({ error: 'Sin configuracion DIAN' }); return; }

    const sentCodes = (ri.sent_events ?? []).filter(e => e.success).map(e => e.code);
    for (const prereq of (RADIAN_PREREQUISITES[event_code] || [])) {
      if (!sentCodes.includes(prereq)) {
        res.status(400).json({ error: `Debe enviar primero el evento ${prereq}` }); return;
      }
    }

    for (const excluded of (RADIAN_EXCLUSIONS[event_code] || [])) {
      if (sentCodes.includes(excluded)) {
        res.status(400).json({ error: `No puede enviar evento ${event_code} porque ya se envio ${excluded}` }); return;
      }
    }

    const eventPayload = {
      event_code,
      event_description: RADIAN_EVENTS[event_code],
      invoice_cufe:      ri.invoice_cufe,
      invoice_number:    ri.invoice_id,
      invoice_date:      ri.invoice_date,
      provider_nit:      ri.provider_nit,
      receiver_nit:      req.body.receiver_nit,
      receiver_name:     req.body.receiver_name,
      event_date:        new Date().toISOString(),
      ...req.body,
    };

    const xmlResult = await generateEventXml(eventPayload) as Record<string, unknown>;
    if (xmlResult.error) { res.status(400).json({ error: xmlResult.error }); return; }

    const { xml_base64 } = xmlResult as { xml_base64: string };
    const signResult = await signXml(
      xml_base64,
      { event_code, event_description: RADIAN_EVENTS[event_code] },
      settings,
    ) as Record<string, unknown>;
    if (signResult.error) { res.status(500).json({ error: signResult.error }); return; }

    const zipBase64 = signResult.zip_base64 as string;
    const signedFilename = (signResult.filename as string) || `evento_${event_code}.zip`;
    const sendResult = await sendEvent(zipBase64, signedFilename, settings.environment || '2', settings) as Record<string, unknown>;
    const eventStatus = (sendResult.status_code === '00') ? 'success' : 'error';

    // Registrar el evento en el historial de la factura recibida
    const newEvent = {
      code: event_code,
      description: RADIAN_EVENTS[event_code],
      sent_at: new Date().toISOString(),
      success: eventStatus === 'success',
      dian_response: sendResult,
    };
    ri.sent_events = [...(ri.sent_events ?? []), newEvent as any];
    await repo.save(ri);

    res.json({ ok: true, event_status: eventStatus, dian_response: sendResult });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Error enviando evento RADIAN';
    res.status(500).json({ error: msg });
  }
});

export default router;
