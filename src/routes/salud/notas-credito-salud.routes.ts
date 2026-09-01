import { Router, Response } from 'express';
import { AppDataSource } from '../../config/database';
import { reservarConsecutivo } from '../../utils/consecutivo.util';
import { NotaCreditoSalud, NotaCreditoSaludStatus } from '../../entities/salud/NotaCreditoSalud';
import { FacturaSalud } from '../../entities/salud/FacturaSalud';
import { Eps } from '../../entities/salud/Eps';
import { CompanySettings } from '../../entities/CompanySettings';
import { Company } from '../../entities/Company';
import { authMiddleware, requireRole, AuthRequest } from '../../middleware/auth.middleware';
import {
  generateCreditNoteXml,
  generateCreditNotePdf,
  signXml,
  sendToDAIN,
} from '../../services/dian.service';
import { buildHealthCreditNotePayload } from '../../utils/dian-payload.utils';
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

// GET /api/salud/notas-credito
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { page = '1', limit = '20', search = '', status = '', factura_id = '' } = req.query as Record<string, string>;
    // Entrega 52: antes se filtraba por empresa via innerJoin a la factura (fac.company_id),
    // lo cual excluia en silencio cualquier nota "independiente" sin factura_id. Ahora se
    // filtra directo por nc.company_id, y el join a la factura es LEFT. Tambien se corrige
    // ILIKE (Postgres) -> LIKE (unico soportado por SQLite, ya senalado en la auditoria).
    let qb = AppDataSource.getRepository(NotaCreditoSalud)
      .createQueryBuilder('nc')
      .leftJoin('nc.factura', 'fac')
      .where('nc.company_id = :cid', { cid: req.user!.companyId });

    if (status)     qb = qb.andWhere('nc.status = :status', { status });
    if (factura_id) qb = qb.andWhere('nc.factura_id = :factura_id', { factura_id });
    if (search) {
      const s = `%${search}%`;
      qb = qb.andWhere(
        '(nc.nota_number LIKE :s OR fac.invoice_number LIKE :s OR nc.ref_numero_factura LIKE :s)',
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

    const items = entities.map(nc => ({ ...nc, es_independiente: !nc.factura_id }));
    res.json({ items, total, page: +page, limit: +limit });
  } catch {
    res.status(500).json({ error: 'Error listando notas crédito salud' });
  }
});

// GET /api/salud/notas-credito/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const nc = await AppDataSource.getRepository(NotaCreditoSalud).findOne({
      where: { id: req.params.id, company_id: req.user!.companyId },
      relations: ['factura', 'ref_eps'],
    });
    if (!nc) { res.status(404).json({ error: 'Nota crédito salud no encontrada' }); return; }
    res.json({ ...nc, es_independiente: !nc.factura_id });
  } catch {
    res.status(500).json({ error: 'Error obteniendo nota crédito salud' });
  }
});

// GET /api/salud/notas-credito/:id/pdf
router.get('/:id/pdf', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const nc = await AppDataSource.getRepository(NotaCreditoSalud).findOne({
      where: { id: req.params.id, company_id: req.user!.companyId },
    });
    if (!nc) { res.status(404).json({ error: 'Nota no encontrada' }); return; }

    if (nc.pdf_base64) {
      const buf = Buffer.from(nc.pdf_base64, 'base64');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${nc.nota_number}.pdf"`);
      res.send(buf);
      return;
    }

    // Fallback: regenerate PDF from stored XML/data
    if (!nc.xml_base64 || !nc.cude) {
      res.status(404).json({ error: 'PDF no disponible: nota sin XML o CUDE' }); return;
    }
    const settings = await getSettings(req.user!.companyId);
    const company  = await AppDataSource.getRepository(Company).findOne({ where: { id: req.user!.companyId } });
    if (!settings || !company) { res.status(400).json({ error: 'Configuracion no encontrada' }); return; }
    // Entrega 52: la nota puede ser independiente (sin factura_id local); en ese caso
    // se arma un objeto FacturaSalud "de mentira" con los datos de referencia guardados
    // (numero/CUFE/fecha/EPS elegida a mano) para que el generador de PDF no cambie.
    let refFactura: FacturaSalud | null = null;
    if (nc.factura_id) {
      refFactura = await AppDataSource.getRepository(FacturaSalud).findOne({
        where: { id: nc.factura_id }, relations: ['eps'],
      });
      if (!refFactura) { res.status(404).json({ error: 'Factura referenciada no encontrada' }); return; }
    }
    const ncConEps = await AppDataSource.getRepository(NotaCreditoSalud).findOne({
      where: { id: nc.id }, relations: ['ref_eps'],
    });
    const facturaParaPayload: FacturaSalud = refFactura ?? ({
      invoice_number: nc.ref_numero_factura,
      cufe:           nc.ref_cufe,
      issue_date:     nc.ref_fecha_emision,
      eps:            ncConEps?.ref_eps,
    } as unknown as FacturaSalud);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeBody: Record<string, any> = {
      lines:                   nc.lines || [],
      discrepancy_code:        '1',
      currency:                nc.currency || 'COP',
    };
    const xmlPayload = buildHealthCreditNotePayload(fakeBody, company, settings, facturaParaPayload, nc.nota_number);
    const pdfResult = await generateCreditNotePdf({
      ...xmlPayload,
      cude:                nc.cude,
      environment:         settings.environment,
      signed_filename:     nc.nota_number,
      issue_datetime:      `${nc.issue_date}T00:00:00-05:00`,
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
    nc.pdf_base64 = pdfResult.pdf_base64 as string;
    await AppDataSource.getRepository(NotaCreditoSalud).save(nc);

    const buf = Buffer.from(nc.pdf_base64, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${nc.nota_number}.pdf"`);
    res.send(buf);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: 'Error descargando PDF', detail: msg });
  }
});

// GET /api/salud/notas-credito/:id/zip
router.get('/:id/zip', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const nc = await AppDataSource.getRepository(NotaCreditoSalud).findOne({
      where: { id: req.params.id, company_id: req.user!.companyId },
    });
    if (!nc || !nc.zip_base64) {
      res.status(404).json({ error: 'ZIP no disponible' }); return;
    }
    const buf = Buffer.from(nc.zip_base64, 'base64');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${nc.nota_number}.zip"`);
    res.send(buf);
  } catch {
    res.status(500).json({ error: 'Error descargando ZIP' });
  }
});

// POST /api/salud/notas-credito
router.post('/', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const settings = await getSettings(req.user!.companyId);
    if (!settings) { res.status(400).json({ error: 'Sin configuracion DIAN' }); return; }

    // Entrega 52: notas independientes -- si no llega factura_id (o no se encuentra
    // localmente por numero+CUFE), la nota se crea igual, con los datos escritos a mano
    // (numero, CUFE, fecha, EPS elegida) como referencia legal ante la DIAN.
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

    if (refFactura && refFactura.status !== 'aprobada' && refFactura.status !== 'anulada') {
      // 'anulada' = marcada localmente como anulada pero sigue aprobada en DIAN → se puede NC
      res.status(400).json({ error: 'Solo se pueden crear notas crédito sobre facturas aprobadas por la DIAN' }); return;
    }

    const esIndependiente = !refFactura;
    let refEps: Eps | null = null;
    if (esIndependiente) {
      refEps = await AppDataSource.getRepository(Eps).findOne({ where: { id: refEpsId, company_id: req.user!.companyId } });
      if (!refEps) { res.status(400).json({ error: 'EPS no encontrada' }); return; }

      // Bloqueo por numero+CUFE: no se puede anular dos veces la misma factura independiente.
      if (String(req.body.discrepancy_code) === '2') {
        const dupNc = await AppDataSource.getRepository(NotaCreditoSalud).findOne({
          where: { company_id: req.user!.companyId, ref_numero_factura: refNumeroManual, ref_cufe: refCufeManual, discrepancy_code: '2' },
        });
        if (dupNc) { res.status(400).json({ error: 'Ya existe una nota crédito de anulación para esa factura' }); return; }
      }
    }

    const facturaParaPayload: FacturaSalud = refFactura ?? ({
      invoice_number: refNumeroManual,
      cufe:           refCufeManual,
      issue_date:     refFechaManual,
      eps:            refEps,
    } as unknown as FacturaSalud);

    const company = await getCompany(req.user!.companyId);
    if (!company) { res.status(400).json({ error: 'Empresa no encontrada' }); return; }

    const xmlPayload = buildHealthCreditNotePayload(req.body, company, settings, facturaParaPayload);
    const xmlResult = await generateCreditNoteXml(xmlPayload) as Record<string, unknown>;
    if (xmlResult.error || xmlResult.success === false) { res.status(400).json({ error: xmlResult.error }); return; }

    const { xml_base64, cude, credit_note_number } = xmlResult as { xml_base64: string; cude: string; credit_note_number: string };

    const issueDatetime = new Date().toLocaleString('sv-SE', { timeZone: 'America/Bogota' }).replace('T', ' ') + '-05:00';
    const pdfResult = await generateCreditNotePdf({
      ...xmlPayload,
      cude,
      environment:     settings.environment,
      signed_filename: credit_note_number,
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

    const signResult = await signXml(xml_base64, { credit_note_number, cude }, settings) as Record<string, unknown>;
    if (signResult.error) { res.status(400).json({ error: 'Error firmando XML' }); return; }

    const { zip_base64, signed_filename } = signResult as { zip_base64: string; signed_filename: string };
    const dianResult = await sendToDAIN(zip_base64, signed_filename, settings.environment, settings) as Record<string, unknown>;

    // Hallazgo #53: el incremento del consecutivo debe ser atómico en BD (mismo
    // patrón ya usado para facturas de salud regulares) para evitar colisión de
    // números bajo carga concurrente — antes se leía settings.next_health_credit_note_number
    // y se guardaba +1 al final del request, con ventana de carrera entre ambas.
    const prefix = settings.health_credit_note_prefix || 'NCSS';
    const number = await reservarConsecutivo(AppDataSource, req.user!.companyId, 'next_health_credit_note_number');

    const repo = AppDataSource.getRepository(NotaCreditoSalud);
    const nc = repo.create({
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
      nota_number:             credit_note_number,
      issue_date:              new Date().toLocaleString('sv-SE', { timeZone: 'America/Bogota' }).slice(0, 10),
      description:             req.body.description || undefined,
      status:                  (dianResult.status_code === '00' ? 'aprobada' : dianResult.status_code ? 'rechazada' : 'enviada') as NotaCreditoSaludStatus,
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
    await repo.save(nc);

    // Hallazgo #54: registrarAuditoria estaba importada pero nunca se invocaba en
    // este módulo (asimetría respecto a Notas Débito de Salud, que sí la registra).
    await registrarAuditoria({
      req, accion: AUDITORIA_ACCION.CREAR, entidad: AUDITORIA_ENTIDAD.NOTA_CREDITO_SALUD,
      entidadId: nc.id, datosNuevos: { nota_number: nc.nota_number, total: nc.total, factura_id: nc.factura_id },
    });

    res.status(201).json({
      id:          nc.id,
      nota_number: nc.nota_number,
      cude:        nc.cude,
      status:      nc.status,
      dian_response: dianResult,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Error generando nota crédito salud';
    console.error('[NCSS]', msg);
    res.status(500).json({ error: msg });
  }
});

// PUT /api/salud/notas-credito/:id — reenviar rechazada
router.put('/:id', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const repo = AppDataSource.getRepository(NotaCreditoSalud);
    const nc = await repo.findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!nc) { res.status(404).json({ error: 'Nota crédito salud no encontrada' }); return; }
    if (!['rechazada', 'enviada'].includes(nc.status)) {
      res.status(400).json({ error: 'Solo se pueden reenviar notas rechazadas o enviadas' }); return;
    }

    const settings = await getSettings(req.user!.companyId);
    if (!settings) { res.status(400).json({ error: 'Sin configuracion DIAN' }); return; }

    // Entrega 52: si la nota es independiente (sin factura_id local), se arma un
    // objeto FacturaSalud "de mentira" con la referencia guardada, igual que en /pdf.
    let refFactura: FacturaSalud | null = null;
    if (nc.factura_id) {
      refFactura = await AppDataSource.getRepository(FacturaSalud).findOne({
        where: { id: nc.factura_id }, relations: ['eps'],
      });
      if (!refFactura) { res.status(404).json({ error: 'Factura de referencia no encontrada' }); return; }
    }
    const ncConEps = await AppDataSource.getRepository(NotaCreditoSalud).findOne({
      where: { id: nc.id }, relations: ['ref_eps'],
    });
    const facturaParaPayload: FacturaSalud = refFactura ?? ({
      invoice_number: nc.ref_numero_factura,
      cufe:           nc.ref_cufe,
      issue_date:     nc.ref_fecha_emision,
      eps:            ncConEps?.ref_eps,
    } as unknown as FacturaSalud);

    const company = await getCompany(req.user!.companyId);
    if (!company) { res.status(400).json({ error: 'Empresa no encontrada' }); return; }

    const xmlPayload = buildHealthCreditNotePayload(req.body, company, settings, facturaParaPayload, nc.nota_number);
    const xmlResult = await generateCreditNoteXml(xmlPayload) as Record<string, unknown>;
    if (xmlResult.error || xmlResult.success === false) { res.status(400).json({ error: xmlResult.error }); return; }

    const { xml_base64, cude } = xmlResult as { xml_base64: string; cude: string };
    const pdfResult = await generateCreditNotePdf({
      ...xmlPayload, cude,
      environment:     settings.environment,
      signed_filename: nc.nota_number,
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

    const signResult = await signXml(xml_base64, { credit_note_number: nc.nota_number, cude }, settings) as Record<string, unknown>;
    if (signResult.error) { res.status(400).json({ error: 'Error firmando XML' }); return; }
    const { zip_base64, signed_filename } = signResult as { zip_base64: string; signed_filename: string };

    const dianResult = await sendToDAIN(zip_base64, signed_filename, settings.environment, settings) as Record<string, unknown>;

    nc.cude                    = cude;
    nc.status                  = (dianResult.status_code === '00' ? 'aprobada' : dianResult.status_code ? 'rechazada' : 'enviada') as NotaCreditoSaludStatus;
    nc.dian_status_code        = (dianResult.status_code as string) || undefined;
    nc.dian_response           = JSON.stringify(dianResult);
    nc.discrepancy_code        = req.body.discrepancy_code;
    nc.discrepancy_description = req.body.discrepancy_desc || req.body.discrepancy_description;
    nc.subtotal                = req.body.subtotal || 0;
    nc.tax_total               = req.body.tax_total || 0;
    nc.total                   = req.body.total || 0;
    nc.lines                   = req.body.lines;
    nc.xml_base64              = xml_base64;
    nc.zip_base64              = zip_base64;
    nc.pdf_base64              = pdfBase64;
    await repo.save(nc);
    res.json(nc);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Error al reenviar nota crédito salud';
    res.status(500).json({ error: msg });
  }
});

export default router;
