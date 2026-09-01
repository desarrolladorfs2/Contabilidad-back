import { Router, Response } from 'express';
import { AppDataSource } from '../../config/database';
import { reservarConsecutivo } from '../../utils/consecutivo.util';
import { NotaDebitoSalud, NotaDebitoSaludStatus } from '../../entities/salud/NotaDebitoSalud';
import { FacturaSalud } from '../../entities/salud/FacturaSalud';
import { Eps } from '../../entities/salud/Eps';
import { CompanySettings } from '../../entities/CompanySettings';
import { Company } from '../../entities/Company';
import { authMiddleware, requireRole, AuthRequest } from '../../middleware/auth.middleware';
import {
  generateDebitNoteXml,
  generateDebitNotePdf,
  signXml,
  sendToDAIN,
} from '../../services/dian.service';
import { buildHealthDebitNotePayload } from '../../utils/dian-payload.utils';
import { registrarAuditoria, AUDITORIA_ACCION, AUDITORIA_ENTIDAD } from '../../services/auditoria.service';
import { resolveUploadPath } from '../../services/uploads.service';

const router = Router();
router.use(authMiddleware);

async function getSettings(companyId: string): Promise<CompanySettings | null> {
  return AppDataSource.getRepository(CompanySettings).findOne({ where: { company_id: companyId } });
}
async function getCompany(companyId: string): Promise<Company | null> {
  return AppDataSource.getRepository(Company).findOne({ where: { id: companyId } });
}

// GET /api/salud/notas-debito
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { page = '1', limit = '20', search = '', status = '', factura_id = '' } = req.query as Record<string, string>;
    // Entrega 52: idem notas credito salud -- filtro directo por nd.company_id (antes
    // el innerJoin a la factura excluia en silencio las notas independientes), LEFT join,
    // y LIKE en vez de ILIKE (SQLite no soporta ILIKE).
    let qb = AppDataSource.getRepository(NotaDebitoSalud)
      .createQueryBuilder('nd')
      .leftJoin('nd.factura', 'fac')
      .where('nd.company_id = :cid', { cid: req.user!.companyId });

    if (status)     qb = qb.andWhere('nd.status = :status', { status });
    if (factura_id) qb = qb.andWhere('nd.factura_id = :factura_id', { factura_id });
    if (search) {
      const s = `%${search}%`;
      qb = qb.andWhere(
        '(nd.nota_number LIKE :s OR fac.invoice_number LIKE :s OR nd.ref_numero_factura LIKE :s)',
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

    const items = entities.map(nd => ({ ...nd, es_independiente: !nd.factura_id }));
    res.json({ items, total, page: +page, limit: +limit });
  } catch {
    res.status(500).json({ error: 'Error listando notas débito salud' });
  }
});

// GET /api/salud/notas-debito/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const nd = await AppDataSource.getRepository(NotaDebitoSalud).findOne({
      where: { id: req.params.id, company_id: req.user!.companyId },
      relations: ['factura', 'ref_eps'],
    });
    if (!nd) { res.status(404).json({ error: 'Nota débito salud no encontrada' }); return; }
    res.json({ ...nd, es_independiente: !nd.factura_id });
  } catch {
    res.status(500).json({ error: 'Error obteniendo nota débito salud' });
  }
});

// GET /api/salud/notas-debito/:id/pdf
router.get('/:id/pdf', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const nd = await AppDataSource.getRepository(NotaDebitoSalud).findOne({
      where: { id: req.params.id, company_id: req.user!.companyId },
    });
    if (!nd) { res.status(404).json({ error: 'Nota no encontrada' }); return; }

    if (nd.pdf_base64) {
      const buf = Buffer.from(nd.pdf_base64, 'base64');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${nd.nota_number}.pdf"`);
      res.send(buf);
      return;
    }

    // Fallback: regenerate PDF from stored XML/data
    if (!nd.xml_base64 || !nd.cude) {
      res.status(404).json({ error: 'PDF no disponible: nota sin XML o CUDE' }); return;
    }
    const settings = await getSettings(req.user!.companyId);
    const company  = await AppDataSource.getRepository(Company).findOne({ where: { id: req.user!.companyId } });
    if (!settings || !company) { res.status(400).json({ error: 'Configuracion no encontrada' }); return; }
    let refFactura: FacturaSalud | null = null;
    if (nd.factura_id) {
      refFactura = await AppDataSource.getRepository(FacturaSalud).findOne({
        where: { id: nd.factura_id }, relations: ['eps'],
      });
      if (!refFactura) { res.status(404).json({ error: 'Factura referenciada no encontrada' }); return; }
    }
    const ndConEps = await AppDataSource.getRepository(NotaDebitoSalud).findOne({
      where: { id: nd.id }, relations: ['ref_eps'],
    });
    const facturaParaPayload: FacturaSalud = refFactura ?? ({
      invoice_number: nd.ref_numero_factura,
      cufe:           nd.ref_cufe,
      issue_date:     nd.ref_fecha_emision,
      eps:            ndConEps?.ref_eps,
    } as unknown as FacturaSalud);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeBody: Record<string, any> = {
      lines:            nd.lines || [],
      discrepancy_code: '1',
      currency:         nd.currency || 'COP',
    };
    const xmlPayload = buildHealthDebitNotePayload(fakeBody, company, settings, facturaParaPayload, nd.nota_number);
    const pdfResult = await generateDebitNotePdf({
      ...xmlPayload,
      cude:                nd.cude,
      environment:         settings.environment,
      signed_filename:     nd.nota_number,
      issue_datetime:      `${nd.issue_date}T00:00:00-05:00`,
      billing_reference: {
        invoice_id:   facturaParaPayload.invoice_number,
        invoice_uuid: facturaParaPayload.cufe,
        invoice_date: facturaParaPayload.issue_date,
      },
      pdf_primary_color:   settings.pdf_primary_color   ?? '#1a56db',
      pdf_secondary_color: settings.pdf_secondary_color ?? '#374151',
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      logo_base64: settings.logo_path ? (() => { try { return require('fs').readFileSync(resolveUploadPath(settings.logo_path)).toString('base64'); } catch { return undefined; } })() : undefined,
    }) as Record<string, unknown>;

    if (!pdfResult.pdf_base64) {
      res.status(500).json({ error: 'Error generando PDF', detail: pdfResult.error }); return;
    }
    nd.pdf_base64 = pdfResult.pdf_base64 as string;
    await AppDataSource.getRepository(NotaDebitoSalud).save(nd);

    const buf = Buffer.from(nd.pdf_base64, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${nd.nota_number}.pdf"`);
    res.send(buf);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: 'Error descargando PDF', detail: msg });
  }
});

// GET /api/salud/notas-debito/:id/zip
router.get('/:id/zip', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const nd = await AppDataSource.getRepository(NotaDebitoSalud).findOne({
      where: { id: req.params.id, company_id: req.user!.companyId },
    });
    if (!nd || !nd.zip_base64) {
      res.status(404).json({ error: 'ZIP no disponible' }); return;
    }
    const buf = Buffer.from(nd.zip_base64, 'base64');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${nd.nota_number}.zip"`);
    res.send(buf);
  } catch {
    res.status(500).json({ error: 'Error descargando ZIP' });
  }
});

// POST /api/salud/notas-debito
router.post('/', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const settings = await getSettings(req.user!.companyId);
    if (!settings) { res.status(400).json({ error: 'Sin configuracion DIAN' }); return; }

    // Entrega 52: notas independientes -- si no llega factura_id (o no se encuentra
    // localmente por numero+CUFE), la nota se crea igual con los datos escritos a mano.
    let refFactura: FacturaSalud | null = null;
    if (req.body.factura_id) {
      refFactura = await AppDataSource.getRepository(FacturaSalud).findOne({
        where: { id: req.body.factura_id, company_id: req.user!.companyId },
        relations: ['eps'],
      });
      if (!refFactura) { res.status(404).json({ error: 'Factura salud de referencia no encontrada' }); return; }
    }

    const refNumeroManual = String(req.body.ref_numero_factura || '').trim();
    const refCufeManual   = String(req.body.ref_cufe            || '').trim();
    const refFechaManual  = String(req.body.ref_fecha_emision   || '').trim();
    const refEpsId        = String(req.body.ref_eps_id          || '').trim();

    if (!refFactura) {
      if (!refNumeroManual || !refCufeManual || !refFechaManual || !refEpsId) {
        res.status(400).json({ error: 'Indica el numero de factura, el CUFE, la fecha de emision y la EPS' });
        return;
      }
      refFactura = await AppDataSource.getRepository(FacturaSalud).findOne({
        where: { company_id: req.user!.companyId, invoice_number: refNumeroManual, cufe: refCufeManual },
        relations: ['eps'],
      });
    }

    if (refFactura && refFactura.status !== 'aprobada') {
      res.status(400).json({ error: 'Solo se pueden crear notas débito sobre facturas aprobadas por la DIAN' }); return;
    }

    const esIndependiente = !refFactura;
    let refEps: Eps | null = null;
    if (esIndependiente) {
      refEps = await AppDataSource.getRepository(Eps).findOne({ where: { id: refEpsId, company_id: req.user!.companyId } });
      if (!refEps) { res.status(400).json({ error: 'EPS no encontrada' }); return; }
    }

    const facturaParaPayload: FacturaSalud = refFactura ?? ({
      invoice_number: refNumeroManual,
      cufe:           refCufeManual,
      issue_date:     refFechaManual,
      eps:            refEps,
    } as unknown as FacturaSalud);

    const company = await getCompany(req.user!.companyId);
    if (!company) { res.status(400).json({ error: 'Empresa no encontrada' }); return; }

    const xmlPayload = buildHealthDebitNotePayload(req.body, company, settings, facturaParaPayload);
    const xmlResult = await generateDebitNoteXml(xmlPayload) as Record<string, unknown>;
    if (xmlResult.error || xmlResult.success === false) { res.status(400).json({ error: xmlResult.error }); return; }

    const { xml_base64, cude, debit_note_number } = xmlResult as { xml_base64: string; cude: string; debit_note_number: string };

    const issueDatetime = new Date().toLocaleString('sv-SE', { timeZone: 'America/Bogota' }).replace('T', ' ') + '-05:00';
    const pdfResult = await generateDebitNotePdf({
      ...xmlPayload,
      cude,
      environment:     settings.environment,
      signed_filename: debit_note_number,
      issue_datetime:  issueDatetime,
      billing_reference: {
        invoice_id:   facturaParaPayload.invoice_number,
        invoice_uuid: facturaParaPayload.cufe,
        invoice_date: facturaParaPayload.issue_date,
      },
      pdf_primary_color:   settings.pdf_primary_color   ?? '#1a56db',
      logo_base64:          settings.logo_path ? (() => { try { return require('fs').readFileSync(resolveUploadPath(settings.logo_path)).toString('base64'); } catch { return undefined; } })() : undefined,
      pdf_secondary_color: settings.pdf_secondary_color ?? '#374151',
    }) as Record<string, unknown>;
    const pdfBase64: string | undefined = (pdfResult.pdf_base64 as string) || undefined;

    const signResult = await signXml(xml_base64, { debit_note_number, cude }, settings) as Record<string, unknown>;
    if (signResult.error) { res.status(400).json({ error: 'Error firmando XML' }); return; }

    const { zip_base64, signed_filename } = signResult as { zip_base64: string; signed_filename: string };
    const dianResult = await sendToDAIN(zip_base64, signed_filename, settings.environment, settings) as Record<string, unknown>;

    // Hallazgo #53: incremento atómico del consecutivo en BD (mismo patrón ya
    // usado en facturas de salud regulares) para evitar colisión bajo carga
    // concurrente — antes se leía settings.next_health_debit_note_number y se
    // guardaba +1 al final del request, con ventana de carrera entre ambas.
    const prefix = settings.health_debit_note_prefix || 'NDSS';
    const number = await reservarConsecutivo(AppDataSource, req.user!.companyId, 'next_health_debit_note_number');

    const repo = AppDataSource.getRepository(NotaDebitoSalud);
    const nd = repo.create({
      factura_id:              refFactura?.id,
      ref_numero_factura:      esIndependiente ? refNumeroManual : undefined,
      ref_cufe:                esIndependiente ? refCufeManual   : undefined,
      ref_fecha_emision:       esIndependiente ? refFechaManual  : undefined,
      ref_eps_id:              esIndependiente ? refEpsId        : undefined,
      company_id:              req.user!.companyId,
      created_by_user_id:     req.user!.id,
      created_by_name:        req.user!.name,
      prefix,
      number,
      nota_number:             debit_note_number,
      issue_date:              new Date().toLocaleString('sv-SE', { timeZone: 'America/Bogota' }).slice(0, 10),
      description:             req.body.description || undefined,
      status:                  (dianResult.status_code === '00' ? 'aprobada' : dianResult.status_code ? 'rechazada' : 'enviada') as NotaDebitoSaludStatus,
      cude,
      dian_status_code:        (dianResult.status_code as string) || undefined,
      dian_response:           JSON.stringify(dianResult),
      discrepancy_code:        req.body.discrepancy_code,
      discrepancy_description: req.body.discrepancy_desc || req.body.discrepancy_description,
      subtotal:                req.body.subtotal || 0,
      tax_total:               req.body.tax_total || 0,
      total:                   req.body.total || 0,
      currency:                req.body.currency || refFactura?.currency || 'COP',
      lines:                   req.body.lines,
      xml_base64,
      pdf_base64:              pdfBase64,
      zip_base64,
    });
    await repo.save(nd);
    await registrarAuditoria({ req, accion: AUDITORIA_ACCION.CREAR, entidad: AUDITORIA_ENTIDAD.NOTA_DEBITO_SALUD, entidadId: nd.id, datosNuevos: { nota_number: nd.nota_number, total: nd.total } });

    res.status(201).json({
      id:          nd.id,
      nota_number: nd.nota_number,
      cude:        nd.cude,
      status:      nd.status,
      dian_response: dianResult,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Error generando nota débito salud';
    console.error('[NDSS]', msg);
    res.status(500).json({ error: msg });
  }
});

// PUT /api/salud/notas-debito/:id — reenviar rechazada
router.put('/:id', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const repo = AppDataSource.getRepository(NotaDebitoSalud);
    const nd = await repo.findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!nd) { res.status(404).json({ error: 'Nota débito salud no encontrada' }); return; }
    if (!['rechazada', 'enviada'].includes(nd.status)) {
      res.status(400).json({ error: 'Solo se pueden reenviar notas rechazadas o enviadas' }); return;
    }

    const settings = await getSettings(req.user!.companyId);
    if (!settings) { res.status(400).json({ error: 'Sin configuracion DIAN' }); return; }

    let refFactura: FacturaSalud | null = null;
    if (nd.factura_id) {
      refFactura = await AppDataSource.getRepository(FacturaSalud).findOne({
        where: { id: nd.factura_id }, relations: ['eps'],
      });
      if (!refFactura) { res.status(404).json({ error: 'Factura de referencia no encontrada' }); return; }
    }
    const ndConEps = await AppDataSource.getRepository(NotaDebitoSalud).findOne({
      where: { id: nd.id }, relations: ['ref_eps'],
    });
    const facturaParaPayload: FacturaSalud = refFactura ?? ({
      invoice_number: nd.ref_numero_factura,
      cufe:           nd.ref_cufe,
      issue_date:     nd.ref_fecha_emision,
      eps:            ndConEps?.ref_eps,
    } as unknown as FacturaSalud);

    const company = await getCompany(req.user!.companyId);
    if (!company) { res.status(400).json({ error: 'Empresa no encontrada' }); return; }

    const xmlPayload = buildHealthDebitNotePayload(req.body, company, settings, facturaParaPayload, nd.nota_number);
    const xmlResult = await generateDebitNoteXml(xmlPayload) as Record<string, unknown>;
    if (xmlResult.error || xmlResult.success === false) { res.status(400).json({ error: xmlResult.error }); return; }

    const { xml_base64, cude } = xmlResult as { xml_base64: string; cude: string };
    const pdfResult = await generateDebitNotePdf({
      ...xmlPayload, cude,
      environment:     settings.environment,
      signed_filename: nd.nota_number,
      issue_datetime:  new Date().toLocaleString('sv-SE', { timeZone: 'America/Bogota' }).replace('T', ' ') + '-05:00',
      billing_reference: {
        invoice_id:   facturaParaPayload.invoice_number,
        invoice_uuid: facturaParaPayload.cufe,
        invoice_date: facturaParaPayload.issue_date,
      },
      pdf_primary_color:   settings.pdf_primary_color   ?? '#1a56db',
      logo_base64:          settings.logo_path ? (() => { try { return require('fs').readFileSync(resolveUploadPath(settings.logo_path)).toString('base64'); } catch { return undefined; } })() : undefined,
      pdf_secondary_color: settings.pdf_secondary_color ?? '#374151',
    }) as Record<string, unknown>;
    const pdfBase64 = (pdfResult.pdf_base64 as string) || '';

    const signResult = await signXml(xml_base64, { debit_note_number: nd.nota_number, cude }, settings) as Record<string, unknown>;
    if (signResult.error) { res.status(400).json({ error: 'Error firmando XML' }); return; }
    const { zip_base64, signed_filename } = signResult as { zip_base64: string; signed_filename: string };

    const dianResult = await sendToDAIN(zip_base64, signed_filename, settings.environment, settings) as Record<string, unknown>;

    nd.cude                    = cude;
    nd.status                  = (dianResult.status_code === '00' ? 'aprobada' : dianResult.status_code ? 'rechazada' : 'enviada') as NotaDebitoSaludStatus;
    nd.dian_status_code        = (dianResult.status_code as string) || undefined;
    nd.dian_response           = JSON.stringify(dianResult);
    nd.discrepancy_code        = req.body.discrepancy_code;
    nd.discrepancy_description = req.body.discrepancy_desc || req.body.discrepancy_description;
    nd.subtotal                = req.body.subtotal || 0;
    nd.tax_total               = req.body.tax_total || 0;
    nd.total                   = req.body.total || 0;
    nd.lines                   = req.body.lines;
    nd.xml_base64              = xml_base64;
    nd.zip_base64              = zip_base64;
    nd.pdf_base64              = pdfBase64;
    await repo.save(nd);
    res.json(nd);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Error al reenviar nota débito salud';
    res.status(500).json({ error: msg });
  }
});

export default router;
