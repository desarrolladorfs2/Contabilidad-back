import { Router, Response } from 'express';
import * as fs from 'fs';
import { AppDataSource } from '../config/database';
import { reservarConsecutivo } from '../utils/consecutivo.util';
import { NotaDebito, EstadoNotaDebito } from '../entities/DebitNote';
import { DebitNoteLinea } from '../entities/DebitNoteLinea';
import { NotaCredito } from '../entities/CreditNote';
import { Factura } from '../entities/Invoice';
import { In } from 'typeorm';
import { CompanySettings } from '../entities/CompanySettings';
import { Company } from '../entities/Company';
import { authMiddleware, requireRole, AuthRequest } from '../middleware/auth.middleware';
import {
  generateDebitNoteXml,
  generateDebitNotePdf,
  signXml,
  sendToDAIN,
} from '../services/dian.service';
import { buildDebitNoteXmlPayload } from '../utils/dian-payload.utils';
import { registrarAuditoria, AUDITORIA_ACCION, AUDITORIA_ENTIDAD } from '../services/auditoria.service';
import { resolveUploadPath } from '../services/uploads.service';

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
 * Doble escritura: persiste las líneas en debit_note_lineas (tabla relacional),
 * igual que saveInvoiceLineas en invoices.routes.ts — hallazgo #1. Se llama
 * después de guardar la nota débito; borra las líneas previas para soportar
 * reintentos/edición de forma idempotente.
 */
async function saveDebitNoteLineas(debitNoteId: string, rawLines: unknown[]): Promise<void> {
  if (!Array.isArray(rawLines) || rawLines.length === 0) return;
  const repo = AppDataSource.getRepository(DebitNoteLinea);
  await repo.delete({ debit_note_id: debitNoteId });
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
      debit_note_id:        debitNoteId,
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

async function findDebitNoteBlob(
  id: string,
  cols: ('xml_base64' | 'pdf_base64' | 'zip_base64' | 'dian_response' | 'lineas')[] = []
) {
  let qb = AppDataSource.getRepository(NotaDebito)
    .createQueryBuilder('n')
    .leftJoinAndSelect('n.factura', 'invoice')
    .where('n.id = :id', { id });
  cols.forEach(c => qb = qb.addSelect(`n.${c}`));
  return qb.getOne();
}


// GET /api/debit-notes
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { page = '1', limit = '20', search = '', status = '', date_from = '', date_to = '' } = req.query as Record<string, string>;
    // Nota (Entrega 52): filtrar por nd.company_id en vez de innerJoin a la factura,
    // igual que en notas credito — asi tambien aparecen las notas independientes.
    let qb = AppDataSource.getRepository(NotaDebito)
      .createQueryBuilder('nd')
      .leftJoin('nd.factura', 'inv')
      .where('nd.company_id = :cid', { cid: req.user!.companyId });

    if (status)    qb = qb.andWhere('nd.estado = :status', { status });
    if (date_from) qb = qb.andWhere('nd.fecha_emision >= :date_from', { date_from });
    if (date_to)   qb = qb.andWhere('nd.fecha_emision <= :date_to', { date_to });
    if (search) {
      const s = `%${search}%`;
      qb = qb.andWhere(
        '(nd.numero_nota_debito LIKE :s OR inv.cliente_nombre LIKE :s OR inv.cliente_nit LIKE :s OR inv.numero_factura LIKE :s OR nd.ref_numero_factura LIKE :s)',
        { s }
      );
    }

    const [entities, total] = await qb
      // Orden por fecha Y HORA real de creación (created_at), no por la fecha del
      // documento (que es solo el día y puede repetirse/empatar entre varios
      // registros del mismo día, dejando el más nuevo mezclado entre los viejos).
      .orderBy('nd.created_at', 'DESC')
      .skip((+page - 1) * +limit)
      .take(+limit)
      .getManyAndCount();

    // Enrich with invoice_number
    const invoiceIds = [...new Set(entities.map(nd => nd.factura_id).filter((id): id is string => !!id))];
    const invoices = invoiceIds.length
      ? await AppDataSource.getRepository(Factura).find({ where: { id: In(invoiceIds) }, select: ['id', 'numero_factura'] })
      : [];
    const invMap = new Map(invoices.map(i => [i.id, i.numero_factura]));
    const items = entities.map(nd => ({
      ...nd,
      numero_factura: (nd.factura_id ? invMap.get(nd.factura_id) : undefined) || nd.ref_numero_factura,
      es_independiente: !nd.factura_id,
    }));
    res.json({ items, total, page: +page, limit: +limit });
  } catch (e) {
    res.status(500).json({ error: 'Error listando notas debito' });
  }
});

// GET /api/debit-notes/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const nd = await findDebitNoteBlob(req.params.id, ['dian_response']);
    if (!nd || nd.company_id !== req.user!.companyId) {
      res.status(404).json({ error: 'Nota debito no encontrada' }); return;
    }
    res.json({ ...nd, numero_factura: nd.factura?.numero_factura || nd.ref_numero_factura, es_independiente: !nd.factura_id });
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo nota debito' });
  }
});

// GET /api/debit-notes/:id/zip
router.get('/:id/zip', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const nd = await findDebitNoteBlob(req.params.id, ['zip_base64']);
    if (!nd || nd.company_id !== req.user!.companyId || !nd.zip_base64) {
      res.status(404).json({ error: 'ZIP no disponible' }); return;
    }
    const buf = Buffer.from(nd.zip_base64, 'base64');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="' + nd.numero_nota_debito + '.zip"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: 'Error descargando ZIP' });
  }
});

// GET /api/debit-notes/:id/pdf
router.get('/:id/pdf', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const nd = await findDebitNoteBlob(req.params.id, ['pdf_base64']);
    if (!nd || nd.company_id !== req.user!.companyId || !nd.pdf_base64) {
      res.status(404).json({ error: 'PDF no disponible' }); return;
    }
    const buf = Buffer.from(nd.pdf_base64, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + nd.numero_nota_debito + '.pdf"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: 'Error descargando PDF' });
  }
});

// POST /api/debit-notes
router.post('/', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  const notaDebitoRepo = AppDataSource.getRepository(NotaDebito);
  let draftNd: NotaDebito | undefined;
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

    // Nota independiente (Entrega 52): igual que en notas credito, se intenta
    // asociar automaticamente si el numero+CUFE escritos a mano coinciden con una
    // factura nuestra antes de tratarla como independiente.
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
    const facturaParaPayload: Factura = refInvoice ?? ({
      numero_factura: refNumeroManual,
      cufe:           refCufeManual,
      fecha_emision:  refFechaManual,
    } as unknown as Factura);

    // Bloquear si la factura ya fue anulada. Con factura local se busca por
    // factura_id; en modo independiente se busca por el mismo numero+CUFE manual.
    const ncAnulacion = await AppDataSource.getRepository(NotaCredito).findOne({
      where: esIndependiente
        ? { company_id: req.user!.companyId, ref_numero_factura: refNumeroManual, ref_cufe: refCufeManual, codigo_discrepancia: '2' }
        : { factura_id: refInvoice!.id, codigo_discrepancia: '2' },
    });
    if (ncAnulacion && ['aprobada', 'aceptada'].includes(ncAnulacion.estado ?? '')) {
      res.status(400).json({ error: 'La factura ya fue anulada. No se pueden emitir notas débito sobre una factura anulada.' });
      return;
    }

    const company = await getCompany(req.user!.companyId);
    if (!company) { res.status(400).json({ error: 'Empresa no encontrada' }); return; }

    // Hallazgo #2: reservar el consecutivo de forma atómica ANTES de las
    // llamadas externas (XML/firma/DIAN) y persistir de inmediato un registro
    // 'draft' con ese número, para no dejar un consecutivo huérfano si algo
    // falla más adelante.
    let assignedNumber = settings.next_debit_note_number || 1;
    if (settings.next_debit_note_number) {
      // Incremento atómico del consecutivo vía reservarConsecutivo() -- ver
      // src/utils/consecutivo.util.ts (antes usaba UPDATE...RETURNING, que
      // no es compatible con MariaDB para sentencias UPDATE).
      assignedNumber = await reservarConsecutivo(AppDataSource, req.user!.companyId, 'next_debit_note_number');
      settings.next_debit_note_number = assignedNumber;
    }

    draftNd = notaDebitoRepo.create({
      factura_id:               refInvoice?.id,
      ref_numero_factura:       esIndependiente ? refNumeroManual : undefined,
      ref_cufe:                 esIndependiente ? refCufeManual   : undefined,
      ref_fecha_emision:        esIndependiente ? refFechaManual  : undefined,
      company_id:               req.user!.companyId,
      prefijo:                  settings.debit_note_prefix || 'ND',
      numero:                   assignedNumber,
      // Placeholder hasta obtener el numero_nota_debito definitivo del XML
      // DIAN (la columna es NOT NULL); se sobreescribe abajo en cada rama.
      numero_nota_debito:       `${settings.debit_note_prefix || 'ND'}${assignedNumber}`,
      fecha_emision:            new Date().toLocaleString('sv-SE', { timeZone: 'America/Bogota' }).slice(0, 10),
      descripcion:              req.body.description || undefined,
      estado:                   'draft' as EstadoNotaDebito,
      codigo_discrepancia:      req.body.discrepancy_code,
      descripcion_discrepancia: req.body.discrepancy_desc || req.body.discrepancy_description,
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
    draftNd.creado_por_usuario_id = req.user!.id;
    draftNd.creado_por_nombre     = req.user!.name;
    await notaDebitoRepo.save(draftNd);

    const xmlPayload = buildDebitNoteXmlPayload(req.body, company, settings, facturaParaPayload);
    const xmlResult = await generateDebitNoteXml(xmlPayload) as Record<string, unknown>;
    if (xmlResult.error || xmlResult.success === false) {
      draftNd.estado = 'rechazada' as EstadoNotaDebito;
      draftNd.dian_response = JSON.stringify({ error: xmlResult.error, stage: 'generar_xml' });
      await notaDebitoRepo.save(draftNd);
      res.status(400).json({ error: xmlResult.error }); return;
    }

    const { xml_base64, cude, debit_note_number } = xmlResult as { xml_base64: string; cude: string; debit_note_number: string };

    const issueDatetime = new Date().toLocaleString('sv-SE', { timeZone: 'America/Bogota' }).replace('T', ' ') + '-05:00';

    // Firmar primero para incluir la firma digital en el PDF
    const signResult = await signXml(xml_base64, { debit_note_number, cude }, settings) as Record<string, unknown>;
    if (signResult.error) {
      draftNd.estado = 'rechazada' as EstadoNotaDebito;
      draftNd.numero_nota_debito = debit_note_number;
      draftNd.cude = cude;
      draftNd.dian_response = JSON.stringify({ error: signResult.error, stage: 'firmar_xml' });
      await notaDebitoRepo.save(draftNd);
      res.status(400).json({ error: 'Error firmando XML' }); return;
    }

    const { zip_base64, signed_filename, signed_xml_base64 } = signResult as { zip_base64: string; signed_filename: string; signed_xml_base64?: string };

    const pdfResult = await generateDebitNotePdf({
      ...xmlPayload,
      cude,
      environment:         settings.environment,
      signed_filename:     debit_note_number,
      issue_datetime:      issueDatetime,
      billing_reference: {
        invoice_id:   facturaParaPayload.numero_factura,
        invoice_uuid: facturaParaPayload.cufe,
        invoice_date: facturaParaPayload.fecha_emision,
      },
      pdf_primary_color:   settings.pdf_primary_color ?? '#1a56db',
      pdf_secondary_color: settings.pdf_secondary_color ?? '#374151',
      signed_xml_b64:      signed_xml_base64 || undefined,
      logo_base64:         settings.logo_path ? (() => { try { return fs.readFileSync(resolveUploadPath(settings.logo_path!)).toString('base64'); } catch { return undefined; } })() : undefined,
    }) as Record<string, unknown>;
    const pdfBase64: string | undefined = (pdfResult.pdf_base64 as string) || undefined;

    const dianResult = await sendToDAIN(zip_base64, signed_filename, settings.environment, settings) as Record<string, unknown>;

    // Hallazgo #2: completar el mismo registro reservado ('draft') con el
    // resultado final, en lugar de crear una fila nueva.
    const nd = draftNd;
    nd.numero_nota_debito = debit_note_number;
    nd.estado             = (dianResult.status_code === '00' ? 'aprobada' : dianResult.status_code ? 'rechazada' : 'enviada') as EstadoNotaDebito;
    nd.cude               = cude;
    nd.dian_status_code   = (dianResult.status_code as string) || undefined;
    nd.dian_response      = JSON.stringify(dianResult);
    nd.xml_base64         = xml_base64;
    nd.pdf_base64         = pdfBase64;
    nd.zip_base64         = zip_base64;
    nd.archivo_firmado    = signed_filename || undefined;
    await notaDebitoRepo.save(nd);
    await saveDebitNoteLineas(nd.id, req.body.lines);

    res.status(201).json({
      id:                nd.id,
      debit_note_number: nd.numero_nota_debito,
      cude:              nd.cude,
      status:            nd.estado,
      dian_response:     dianResult,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Error generando nota debito';
    console.error('[ND]', msg);
    // Hallazgo #2: si el registro reservado quedó en 'draft' por un error
    // inesperado, marcarlo 'rechazada' para no dejar un consecutivo huérfano.
    if (draftNd && draftNd.estado === 'draft') {
      try {
        draftNd.estado = 'rechazada' as EstadoNotaDebito;
        draftNd.dian_response = JSON.stringify({ error: msg, stage: 'excepcion_inesperada' });
        await notaDebitoRepo.save(draftNd);
      } catch { /* no bloquear la respuesta de error por esto */ }
    }
    res.status(500).json({ error: msg });
  }
});

// ── PUT /:id — reenviar nota débito rechazada ─────────────────────────────────
router.put('/:id', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const repo = AppDataSource.getRepository(NotaDebito);
    const nd = await repo.findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!nd) { res.status(404).json({ error: 'Nota débito no encontrada' }); return; }
    if (!['rechazada','enviada'].includes(nd.estado)) { res.status(400).json({ error: 'Solo se pueden editar notas débito rechazadas o enviadas' }); return; }

    const settings = await getSettings(req.user!.companyId);
    if (!settings) { res.status(400).json({ error: 'Sin configuracion DIAN' }); return; }

    const refInvoice = nd.factura_id
      ? await AppDataSource.getRepository(Factura).findOne({ where: { id: nd.factura_id } })
      : null;
    if (nd.factura_id && !refInvoice) { res.status(404).json({ error: 'Factura de referencia no encontrada' }); return; }
    const facturaParaPayload: Factura = refInvoice ?? ({
      numero_factura: nd.ref_numero_factura,
      cufe:           nd.ref_cufe,
      fecha_emision:  nd.ref_fecha_emision,
    } as unknown as Factura);

    const company = await getCompany(req.user!.companyId);
    if (!company) { res.status(400).json({ error: 'Empresa no encontrada' }); return; }

    const noteNumberOverride = nd.numero_nota_debito;
    const xmlPayload = buildDebitNoteXmlPayload(req.body, company, settings, facturaParaPayload, noteNumberOverride);
    const xmlResult = await generateDebitNoteXml(xmlPayload) as Record<string, unknown>;
    if (xmlResult.error || xmlResult.success === false) { res.status(400).json({ error: xmlResult.error }); return; }

    const { xml_base64, cude } = xmlResult as { xml_base64: string; cude: string };
    const pdfResult = await generateDebitNotePdf({
      ...xmlPayload, cude,
      environment:        settings.environment,
      signed_filename:    nd.numero_nota_debito,
      issue_datetime:     new Date().toLocaleString('sv-SE', { timeZone: 'America/Bogota' }).replace('T', ' ') + '-05:00',
      billing_reference: {
        invoice_id:   facturaParaPayload.numero_factura,
        invoice_uuid: facturaParaPayload.cufe,
        invoice_date: facturaParaPayload.fecha_emision,
      },
      pdf_primary_color:  settings.pdf_primary_color ?? '#1a56db',
      pdf_secondary_color: settings.pdf_secondary_color ?? '#374151',
    }) as Record<string, unknown>;
    const pdfBase64 = (pdfResult.pdf_base64 as string) || '';

    const signResult = await signXml(xml_base64, { debit_note_number: nd.numero_nota_debito, cude }, settings) as Record<string, unknown>;
    if (signResult.error) { res.status(400).json({ error: 'Error firmando XML' }); return; }
    const { zip_base64, signed_filename } = signResult as { zip_base64: string; signed_filename: string };

    const dianResult = await sendToDAIN(zip_base64, signed_filename, settings.environment, settings) as Record<string, unknown>;

    nd.cude                     = cude;
    nd.estado                   = (dianResult.status_code === '00' ? 'aprobada' : dianResult.status_code ? 'rechazada' : 'enviada') as EstadoNotaDebito;
    nd.dian_status_code         = (dianResult.status_code as string) || undefined;
    nd.dian_response            = JSON.stringify(dianResult);
    nd.codigo_discrepancia      = req.body.discrepancy_code;
    nd.descripcion_discrepancia = req.body.discrepancy_desc || req.body.discrepancy_description;
    nd.subtotal                 = req.body.subtotal || 0;
    nd.total_impuestos          = req.body.tax_total || 0;
    nd.total                    = req.body.total || 0;
    nd.lineas                   = req.body.lines;
    nd.xml_base64               = xml_base64;
    nd.zip_base64               = zip_base64;
    nd.pdf_base64               = pdfBase64;
    await repo.save(nd);
    await saveDebitNoteLineas(nd.id, req.body.lines);
    res.json(nd);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Error al enviar nota debito';
    res.status(500).json({ error: msg });
  }
});

export default router;
