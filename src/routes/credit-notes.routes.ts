import { Router, Response } from 'express';
import * as fs from 'fs';
import { AppDataSource } from '../config/database';
import { reservarConsecutivo } from '../utils/consecutivo.util';
import { NotaCredito, EstadoNotaCredito } from '../entities/CreditNote';
import { CreditNoteLinea } from '../entities/CreditNoteLinea';
import { Factura } from '../entities/Invoice';
import { In } from 'typeorm';
import { CompanySettings } from '../entities/CompanySettings';
import { Company } from '../entities/Company';
import { authMiddleware, requireRole, AuthRequest } from '../middleware/auth.middleware';
import { resolveUploadPath } from '../services/uploads.service';
import {
  generateCreditNoteXml,
  generateCreditNotePdf,
  signXml,
  sendToDAIN,
} from '../services/dian.service';
import { buildCreditNoteXmlPayload } from '../utils/dian-payload.utils';
import { registrarAuditoria, AUDITORIA_ACCION, AUDITORIA_ENTIDAD } from '../services/auditoria.service';

const router = Router();
router.use(authMiddleware);

async function getSettings(companyId: string): Promise<CompanySettings | null> {
  return AppDataSource.getRepository(CompanySettings).findOne({ where: { company_id: companyId } });
}
async function getCompany(companyId: string): Promise<Company | null> {
  return AppDataSource.getRepository(Company).findOne({ where: { id: companyId } });
}

/** Mapeo tax_type del frontend -> codigo DIAN de cat_tipos_tributo */
function mapTaxType(taxType: string): string {
  const t = (taxType || '').toUpperCase();
  if (t === 'IVA') return '01';
  if (t === 'INC') return '04';
  if (t === 'ICA') return '03';
  return 'ZZ';
}

/**
 * Doble escritura: persiste las líneas en credit_note_lineas (tabla relacional),
 * igual que saveInvoiceLineas en invoices.routes.ts — hallazgo #1. Se llama
 * después de guardar la nota crédito; borra las líneas previas para soportar
 * reintentos/edición de forma idempotente.
 */
async function saveCreditNoteLineas(creditNoteId: string, rawLines: unknown[]): Promise<void> {
  if (!Array.isArray(rawLines) || rawLines.length === 0) return;
  const repo = AppDataSource.getRepository(CreditNoteLinea);
  await repo.delete({ credit_note_id: creditNoteId });
  const lineas = rawLines.map((l: any, idx: number) => {
    const tributo  = mapTaxType(l.tax_type ?? '');
    const esIva    = tributo === '01';
    const esInc    = tributo === '04';
    const precio   = Number(l.unit_price    ?? 0);
    const cantidad = Number(l.quantity       ?? 1);
    const dcto_pct = Number(l.discount_rate  ?? 0);
    const dcto_val = Number(l.discount_amount ?? (precio * cantidad * dcto_pct / 100));
    const subtotal = precio * cantidad - dcto_val;
    const valorIva = esIva ? Number(l.tax_amount ?? 0) : 0;
    const valorInc = esInc ? Number(l.tax_amount ?? 0) : 0;
    const total    = Number(l.line_total ?? (subtotal + valorIva + valorInc));
    return repo.create({
      credit_note_id:       creditNoteId,
      linea_numero:         idx + 1,
      descripcion:          String(l.description ?? '').substring(0, 500),
      cantidad,
      unidad_medida_codigo: String(l.unit_code ?? 'EA').substring(0, 10),
      precio_unitario:      precio,
      descuento_pct:        dcto_pct,
      descuento_valor:      dcto_val,
      subtotal,
      tipo_tributo_codigo:  tributo,
      tarifa_iva:           esIva ? Number(l.tax_rate ?? 0) : 0,
      valor_iva:            valorIva,
      valor_inc:            valorInc,
      total,
    });
  });
  await repo.save(lineas);
}

async function findCreditNoteBlob(
  id: string,
  cols: ('xml_base64' | 'pdf_base64' | 'zip_base64' | 'dian_response' | 'lineas')[] = []
) {
  let qb = AppDataSource.getRepository(NotaCredito)
    .createQueryBuilder('n')
    .leftJoinAndSelect('n.factura', 'invoice')
    .where('n.id = :id', { id });
  cols.forEach(c => qb = qb.addSelect(`n.${c}`));
  return qb.getOne();
}


// GET /api/credit-notes
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { page = '1', limit = '20', search = '', status = '', date_from = '', date_to = '' } = req.query as Record<string, string>;
    // Nota (Entrega 52): antes se filtraba por empresa via innerJoin a la factura
    // (inv.company_id), lo cual excluia en silencio cualquier nota "independiente"
    // sin factura_id. Ahora se filtra directo por nc.company_id (mas correcto y
    // ademas funciona para las dos clases de nota), y el join a la factura es
    // LEFT porque una nota independiente no tiene factura relacionada.
    let qb = AppDataSource.getRepository(NotaCredito)
      .createQueryBuilder('nc')
      .leftJoin('nc.factura', 'inv')
      .where('nc.company_id = :cid', { cid: req.user!.companyId });

    if (status)    qb = qb.andWhere('nc.estado = :status', { status });
    if (date_from) qb = qb.andWhere('nc.fecha_emision >= :date_from', { date_from });
    if (date_to)   qb = qb.andWhere('nc.fecha_emision <= :date_to', { date_to });
    if (search) {
      const s = `%${search}%`;
      // Hallazgo ya reportado en la auditoria: ILIKE no existe en SQLite (solo en
      // Postgres) y el buscador quedaba roto en silencio. Se corrige a LIKE, que en
      // SQLite ya es case-insensitive para caracteres ASCII. Se agrega tambien
      // nc.ref_numero_factura para poder buscar notas independientes por numero.
      qb = qb.andWhere(
        '(nc.numero_nota_credito LIKE :s OR inv.cliente_nombre LIKE :s OR inv.cliente_nit LIKE :s OR inv.numero_factura LIKE :s OR nc.ref_numero_factura LIKE :s)',
        { s }
      );
    }

    const [entities, total] = await qb
      // Orden por fecha Y HORA real de creación (created_at), no por la fecha del
      // documento (que es solo el día y puede repetirse/empatar entre varios
      // registros del mismo día, dejando el más nuevo mezclado entre los viejos).
      .orderBy('nc.created_at', 'DESC')
      .skip((+page - 1) * +limit)
      .take(+limit)
      .getManyAndCount();

    // Enrich with invoice_number (factura local, o la referencia manual si es independiente)
    const invoiceIds = [...new Set(entities.map(nc => nc.factura_id).filter((id): id is string => !!id))];
    const invoices = invoiceIds.length
      ? await AppDataSource.getRepository(Factura).find({ where: { id: In(invoiceIds) }, select: ['id', 'numero_factura'] })
      : [];
    const invMap = new Map(invoices.map(i => [i.id, i.numero_factura]));
    const items = entities.map(nc => ({
      ...nc,
      numero_factura: (nc.factura_id ? invMap.get(nc.factura_id) : undefined) || nc.ref_numero_factura,
      es_independiente: !nc.factura_id,
    }));
    res.json({ items, total, page: +page, limit: +limit });
  } catch (e) {
    res.status(500).json({ error: 'Error listando notas credito' });
  }
});

// GET /api/credit-notes/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const nc = await findCreditNoteBlob(req.params.id, ['dian_response']);
    if (!nc || nc.company_id !== req.user!.companyId) {
      res.status(404).json({ error: 'Nota credito no encontrada' }); return;
    }
    res.json({ ...nc, numero_factura: nc.factura?.numero_factura || nc.ref_numero_factura, es_independiente: !nc.factura_id });
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo nota credito' });
  }
});

// GET /api/credit-notes/:id/zip
router.get('/:id/zip', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const nc = await findCreditNoteBlob(req.params.id, ['zip_base64']);
    if (!nc || nc.company_id !== req.user!.companyId || !nc.zip_base64) {
      res.status(404).json({ error: 'ZIP no disponible' }); return;
    }
    const buf = Buffer.from(nc.zip_base64, 'base64');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="' + nc.numero_nota_credito + '.zip"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: 'Error descargando ZIP' });
  }
});

// GET /api/credit-notes/:id/pdf
router.get('/:id/pdf', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const nc = await findCreditNoteBlob(req.params.id, ['pdf_base64']);
    if (!nc || nc.company_id !== req.user!.companyId || !nc.pdf_base64) {
      res.status(404).json({ error: 'PDF no disponible' }); return;
    }
    const buf = Buffer.from(nc.pdf_base64, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + nc.numero_nota_credito + '.pdf"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: 'Error descargando PDF' });
  }
});

// POST /api/credit-notes
router.post('/', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  const notaCreditoRepo = AppDataSource.getRepository(NotaCredito);
  let draftNc: NotaCredito | undefined;
  try {
    const settings = await getSettings(req.user!.companyId);
    if (!settings) { res.status(400).json({ error: 'Sin configuracion DIAN' }); return; }

    const facturaRepo = AppDataSource.getRepository(Factura);
    let refInvoice: Factura | null = null;
    if (req.body.invoice_id) {
      refInvoice = await facturaRepo.findOne({
        where: { id: req.body.invoice_id, company_id: req.user!.companyId },
      });
      if (!refInvoice) { res.status(404).json({ error: 'Factura de referencia no encontrada' }); return; }
    }

    // Nota independiente (Entrega 52): no viene invoice_id, viene numero+CUFE+fecha
    // escritos a mano. Antes de tratarla como independiente se intenta encontrar
    // una factura NUESTRA con ese numero+CUFE — si existe, se asocia exactamente
    // igual que si el usuario hubiera entrado desde el detalle de esa factura.
    const refNumeroManual = String(req.body.ref_numero_factura || '').trim();
    const refCufeManual   = String(req.body.ref_cufe            || '').trim();
    const refFechaManual  = String(req.body.ref_fecha_emision   || '').trim();

    if (!refInvoice) {
      if (!refNumeroManual || !refCufeManual || !refFechaManual) {
        res.status(400).json({ error: 'Indica el número de factura, el CUFE y la fecha de emisión' });
        return;
      }
      refInvoice = await facturaRepo.findOne({
        where: { company_id: req.user!.companyId, numero_factura: refNumeroManual, cufe: refCufeManual },
      });
    }

    const esIndependiente = !refInvoice;
    // Datos de la factura de referencia para el XML/PDF: si hay factura local se usan
    // sus campos reales; si no, un objeto minimo con lo que la DIAN exige en el
    // BillingReference (numero, CUFE, fecha) — es lo unico que buildCreditNoteXmlPayload
    // lee de este objeto.
    const facturaParaPayload: Factura = refInvoice ?? ({
      numero_factura: refNumeroManual,
      cufe:           refCufeManual,
      fecha_emision:  refFechaManual,
    } as unknown as Factura);

    // Bloquear si la factura ya fue anulada (NC con codigo_discrepancia='2' = "Anulación de factura electrónica", aprobada).
    // Con factura local se busca por factura_id (como siempre); en modo independiente
    // no hay factura_id que comparar, asi que se busca por el mismo numero+CUFE escritos
    // a mano, para no dejar emitir dos anulaciones de la misma factura externa.
    const ncAnulacion = await AppDataSource.getRepository(NotaCredito).findOne({
      where: esIndependiente
        ? { company_id: req.user!.companyId, ref_numero_factura: refNumeroManual, ref_cufe: refCufeManual, codigo_discrepancia: '2' }
        : { factura_id: refInvoice!.id, codigo_discrepancia: '2' },
    });
    if (ncAnulacion && ['aprobada', 'aceptada'].includes(ncAnulacion.estado ?? '')) {
      res.status(400).json({ error: 'La factura ya fue anulada con una nota crédito. No se pueden emitir más notas.' });
      return;
    }

    const company = await getCompany(req.user!.companyId);
    if (!company) { res.status(400).json({ error: 'Empresa no encontrada' }); return; }

    // Hallazgo #2: reservar el consecutivo de forma atómica ANTES de las
    // llamadas externas (XML/firma/DIAN) y persistir de inmediato un registro
    // 'draft' con ese número, para no dejar un consecutivo huérfano si algo
    // falla más adelante.
    let assignedNumber = settings.next_credit_note_number || 1;
    if (settings.next_credit_note_number) {
      // Incremento atómico del consecutivo vía reservarConsecutivo() -- ver
      // src/utils/consecutivo.util.ts (antes usaba UPDATE...RETURNING, que
      // no es compatible con MariaDB para sentencias UPDATE).
      assignedNumber = await reservarConsecutivo(AppDataSource, req.user!.companyId, 'next_credit_note_number');
      settings.next_credit_note_number = assignedNumber;
    }

    draftNc = notaCreditoRepo.create({
      // factura_id queda undefined (NULL) en modo independiente.
      factura_id:               refInvoice?.id,
      ref_numero_factura:       esIndependiente ? refNumeroManual : undefined,
      ref_cufe:                 esIndependiente ? refCufeManual   : undefined,
      ref_fecha_emision:        esIndependiente ? refFechaManual  : undefined,
      company_id:               req.user!.companyId,
      prefijo:                  settings.credit_note_prefix || 'NC',
      numero:                   assignedNumber,
      // Placeholder hasta obtener el numero_nota_credito definitivo del XML
      // DIAN (la columna es NOT NULL); se sobreescribe abajo en cada rama.
      numero_nota_credito:      `${settings.credit_note_prefix || 'NC'}${assignedNumber}`,
      fecha_emision:            new Date().toLocaleString('sv-SE', { timeZone: 'America/Bogota' }).slice(0, 10),
      descripcion:              req.body.description || undefined,
      estado:                   'draft' as EstadoNotaCredito,
      codigo_discrepancia:      req.body.discrepancy_code,
      descripcion_discrepancia: req.body.discrepancy_desc || req.body.discrepancy_description,
      // Con factura local se hereda su centro de costo/sede/ciudad como siempre.
      // En modo independiente no hay de donde heredarlos: los elige el usuario
      // en el formulario y llegan directo en el body.
      cliente_tercero_id:       refInvoice?.cliente_tercero_id ?? req.body.customer?.id ?? undefined,
      centro_costo_id:          refInvoice ? refInvoice.centro_costo_id : (req.body.centro_costo_id || undefined),
      sede_id:                  refInvoice ? refInvoice.sede_id         : (req.body.sede_id || undefined),
      ciudad_codigo:            refInvoice ? refInvoice.ciudad_codigo   : (req.body.ciudad_codigo || undefined),
      ciudad_nombre:            refInvoice ? refInvoice.ciudad_nombre   : (req.body.ciudad_nombre || undefined),
      subtotal:                 req.body.subtotal || 0,
      total_impuestos:          req.body.tax_total || 0,
      total:                    req.body.total || 0,
      lineas:                   req.body.lines,
      moneda:                   req.body.currency || 'COP',
    });
    draftNc.creado_por_usuario_id = req.user!.id;
    draftNc.creado_por_nombre     = req.user!.name;
    await notaCreditoRepo.save(draftNc);

    const xmlPayload = buildCreditNoteXmlPayload(req.body, company, settings, facturaParaPayload);
    const xmlResult = await generateCreditNoteXml(xmlPayload) as Record<string, unknown>;
    if (xmlResult.error || xmlResult.success === false) {
      draftNc.estado = 'rechazada' as EstadoNotaCredito;
      draftNc.dian_response = JSON.stringify({ error: xmlResult.error, stage: 'generar_xml' });
      await notaCreditoRepo.save(draftNc);
      res.status(400).json({ error: xmlResult.error }); return;
    }

    const { xml_base64, cude, credit_note_number } = xmlResult as { xml_base64: string; cude: string; credit_note_number: string };

    const issueDatetime = new Date().toLocaleString('sv-SE', { timeZone: 'America/Bogota' }).replace('T', ' ') + '-05:00';

    // Firmar primero para incluir la firma digital en el PDF
    const signResult = await signXml(xml_base64, { credit_note_number, cude }, settings) as Record<string, unknown>;
    if (signResult.error) {
      draftNc.estado = 'rechazada' as EstadoNotaCredito;
      draftNc.numero_nota_credito = credit_note_number;
      draftNc.cude = cude;
      draftNc.dian_response = JSON.stringify({ error: signResult.error, stage: 'firmar_xml' });
      await notaCreditoRepo.save(draftNc);
      res.status(400).json({ error: 'Error firmando XML' }); return;
    }

    const { zip_base64, signed_filename, signed_xml_base64 } = signResult as { zip_base64: string; signed_filename: string; signed_xml_base64?: string };

    const pdfResult = await generateCreditNotePdf({
      ...xmlPayload,
      cude,
      environment:         settings.environment,
      signed_filename:     credit_note_number,
      issue_datetime:      issueDatetime,
      billing_reference: {
        invoice_id:   facturaParaPayload.numero_factura,
        invoice_uuid: facturaParaPayload.cufe,
        invoice_date: facturaParaPayload.fecha_emision,
      },
      pdf_primary_color:   settings.pdf_primary_color ?? '#1a56db',
      pdf_secondary_color: settings.pdf_secondary_color ?? '#374151',
      signed_xml_b64:      signed_xml_base64 || undefined,
      logo_base64:         settings.logo_path ? (() => { try { return require('fs').readFileSync(resolveUploadPath(settings.logo_path)).toString('base64'); } catch { return undefined; } })() : undefined,
    }) as Record<string, unknown>;
    const pdfBase64: string | undefined = (pdfResult.pdf_base64 as string) || undefined;
    const dianResult = await sendToDAIN(zip_base64, signed_filename, settings.environment, settings) as Record<string, unknown>;

    // Hallazgo #2: completar el mismo registro reservado ('draft') con el
    // resultado final, en lugar de crear una fila nueva.
    const nc = draftNc;
    nc.numero_nota_credito = credit_note_number;
    nc.estado              = (dianResult.status_code === '00' ? 'aprobada' : dianResult.status_code ? 'rechazada' : 'enviada') as EstadoNotaCredito;
    nc.cude                = cude;
    nc.dian_status_code    = (dianResult.status_code as string) || undefined;
    nc.dian_response       = JSON.stringify(dianResult);
    nc.xml_base64          = xml_base64;
    nc.pdf_base64          = pdfBase64;
    nc.zip_base64          = zip_base64;
    nc.archivo_firmado     = signed_filename || undefined;
    await notaCreditoRepo.save(nc);
    await saveCreditNoteLineas(nc.id, req.body.lines);

    res.status(201).json({
      id:                 nc.id,
      credit_note_number: nc.numero_nota_credito,
      cude:               nc.cude,
      status:             nc.estado,
      dian_response:      dianResult,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Error generando nota crédito';
    console.error('[NC]', msg);
    // Hallazgo #2: si el registro reservado quedó en 'draft' por un error
    // inesperado, marcarlo 'rechazada' para no dejar un consecutivo huérfano.
    if (draftNc && draftNc.estado === 'draft') {
      try {
        draftNc.estado = 'rechazada' as EstadoNotaCredito;
        draftNc.dian_response = JSON.stringify({ error: msg, stage: 'excepcion_inesperada' });
        await notaCreditoRepo.save(draftNc);
      } catch { /* no bloquear la respuesta de error por esto */ }
    }
    res.status(500).json({ error: msg });
  }
});

// ── PUT /:id — reenviar nota crédito rechazada ────────────────────────────────
router.put('/:id', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const repo = AppDataSource.getRepository(NotaCredito);
    const nc = await repo.findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!nc) { res.status(404).json({ error: 'Nota crédito no encontrada' }); return; }
    if (!['rechazada','enviada'].includes(nc.estado)) { res.status(400).json({ error: 'Solo se pueden editar notas crédito rechazadas o enviadas' }); return; }

    const settings = await getSettings(req.user!.companyId);
    if (!settings) { res.status(400).json({ error: 'Sin configuracion DIAN' }); return; }

    // Con factura local se busca la factura real; en modo independiente (factura_id
    // NULL) se reconstruye el mismo objeto minimo con la referencia guardada a mano.
    const refInvoice = nc.factura_id
      ? await AppDataSource.getRepository(Factura).findOne({ where: { id: nc.factura_id } })
      : null;
    if (nc.factura_id && !refInvoice) { res.status(404).json({ error: 'Factura de referencia no encontrada' }); return; }
    const facturaParaPayload: Factura = refInvoice ?? ({
      numero_factura: nc.ref_numero_factura,
      cufe:           nc.ref_cufe,
      fecha_emision:  nc.ref_fecha_emision,
    } as unknown as Factura);

    const company = await getCompany(req.user!.companyId);
    if (!company) { res.status(400).json({ error: 'Empresa no encontrada' }); return; }

    // Reutilizar el mismo número (no incrementar contador)
    const noteNumberOverride = nc.numero_nota_credito;

    const xmlPayload = buildCreditNoteXmlPayload(req.body, company, settings, facturaParaPayload, noteNumberOverride);
    const xmlResult = await generateCreditNoteXml(xmlPayload) as Record<string, unknown>;
    if (xmlResult.error || xmlResult.success === false) { res.status(400).json({ error: xmlResult.error }); return; }

    const { xml_base64, cude } = xmlResult as { xml_base64: string; cude: string };
    const pdfResult = await generateCreditNotePdf({
      ...xmlPayload,
      xml_base64,
      pdf_primary_color:  settings.pdf_primary_color ?? '#1a56db',
      pdf_secondary_color: settings.pdf_secondary_color ?? '#374151',
    }) as Record<string, unknown>;
    const pdfBase64 = (pdfResult.pdf_base64 as string) || '';

    const signResult = await signXml(xml_base64, { credit_note_number: nc.numero_nota_credito, cude }, settings) as Record<string, unknown>;
    if (signResult.error) { res.status(400).json({ error: 'Error firmando XML' }); return; }
    const { zip_base64, signed_filename } = signResult as { zip_base64: string; signed_filename: string };

    const dianResult = await sendToDAIN(zip_base64, signed_filename, settings.environment, settings) as Record<string, unknown>;

    // Actualizar el registro existente en lugar de crear uno nuevo
    nc.cude                     = cude;
    nc.estado                   = (dianResult.status_code === '00' ? 'aprobada' : dianResult.status_code ? 'rechazada' : 'enviada') as EstadoNotaCredito;
    nc.dian_status_code         = (dianResult.status_code as string) || undefined;
    nc.dian_response            = JSON.stringify(dianResult);
    nc.codigo_discrepancia      = req.body.discrepancy_code;
    nc.descripcion_discrepancia = req.body.discrepancy_desc || req.body.discrepancy_description;
    nc.subtotal                 = req.body.subtotal || 0;
    nc.total_impuestos          = req.body.tax_total || 0;
    nc.total                    = req.body.total || 0;
    nc.lineas                   = req.body.lines;
    nc.xml_base64               = xml_base64;
    nc.zip_base64               = zip_base64;
    nc.pdf_base64               = pdfBase64;
    await repo.save(nc);
    await saveCreditNoteLineas(nc.id, req.body.lines);
    res.json(nc);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Error al enviar nota credito';
    res.status(500).json({ error: msg });
  }
});

export default router;
