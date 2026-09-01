import { Router, Response } from 'express';
import * as fs from 'fs';
import { AppDataSource } from '../config/database';
import { FacturaCompra } from '../entities/FacturaCompra';
import { CompanySettings } from '../entities/CompanySettings';
import { Company } from '../entities/Company';
import { Tercero } from '../entities/Tercero';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { generateInvoicePdf } from '../services/dian.service';
import { resolveUploadPath } from '../services/uploads.service';

const router = Router();
router.use(authMiddleware);

// ── helpers ──────────────────────────────────────────────────────────────────

function readLogo(settings: CompanySettings): string | undefined {
  const logoPath = settings.logoParaPdf;
  if (!logoPath) return undefined;
  try { return fs.readFileSync(resolveUploadPath(logoPath)).toString('base64'); } catch { return undefined; }
}

function buildPdfPayload(
  company: Company,
  settings: CompanySettings,
  body: Record<string, any>,
  logo_base64?: string,
): Record<string, any> {
  const provider = (body.provider as Record<string, any>) || {};

  // Para Factura de Compra:
  //   issuer   = proveedor (quien nos vendió)
  //   customer = nuestra empresa (somos el comprador)
  const issuer = {
    nit:             provider.id_number   || '',
    name:            provider.name        || '',
    address:         provider.address     || '',
    city_name:       provider.city_name   || '',
    document_type:   provider.id_type     || '31',
    tax_level_code:  provider.tax_level_code || 'R-99-PN',
    email:           provider.email       || undefined,
    phone:           provider.phone       || undefined,
  };

  const customer = {
    nit:            company.nit,
    name:           company.name,
    address:        company.address || '',
    city_name:      company.city_name || '',
    document_type:  '31',
    tax_level_code: company.tax_level_code || 'O-13',
  };

  const lines: any[] = (body.lines || []).map((l: any) => ({
    description:     l.description || '',
    unspsc_code:     l.unspsc_code || '81111501',
    quantity:        +l.quantity   || 1,
    unit_code:       l.unit_code   || 'EA',
    unit_price:      +l.unit_price || 0,
    discount_rate:   +l.discount_rate || 0,
    discount_amount: +l.discount_amount || 0,
    tax_type:        l.tax_type || 'IVA',
    tax_rate:        +l.tax_rate || 0,
    tax_amount:      +l.tax_amount || 0,
    line_total:      +l.line_total || 0,
    subtotal_bruto:  +l.subtotal_bruto || +l.unit_price * +l.quantity || 0,
  }));

  return {
    issuer,
    customer,
    prefix:           '',
    number:           body.invoice_number_str || '',
    issue_date:       body.invoice_date || new Date().toISOString().slice(0, 10),
    lines,
    subtotal:         body.subtotal       || 0,
    discount_total:   body.discount_total || 0,
    tax_total:        (body.iva_total || 0) + (body.inc_total || 0),
    iva_total:        body.iva_total       || 0,
    // IVA total manual: cuando el proveedor no discrimina el IVA por ítem,
    // el usuario ingresa un único valor total en vez de calcularlo sumando
    // el % de cada línea. El generador de PDF usa este flag+valor para
    // mostrar el IVA como un solo total y ocultar el detalle por ítem.
    iva_total_manual: !!body.iva_total_manual,
    inc_total:        body.inc_total       || 0,
    total:            body.total           || 0,
    payment_means_id: body.payment_means_id  || '1',
    payment_method_id:body.payment_method_id || '42',
    currency:         body.currency || 'COP',
    note:             body.notes || '',
    cufe:             body.cufe || '',
    // Indicador de tipo de documento para el PDF
    document_type:    'compra',
    pdf_primary_color:   settings.pdf_primary_color   || undefined,
    pdf_secondary_color: settings.pdf_secondary_color || undefined,
    logo_base64,
    resolution_number: settings.resolution_number || '',
    resolution_prefix: settings.invoice_prefix    || '',
    software_id:       settings.software_id       || '',
    environment:       settings.environment        || '2',
  };
}

// ── GET /api/facturas-compra ──────────────────────────────────────────────────

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const companyId = req.user!.companyId;
    const page     = +(req.query['page']  || 1);
    const limit    = +(req.query['limit'] || 20);
    const search   = (req.query['search']    as string) || '';
    const dateFrom = (req.query['date_from'] as string) || '';
    const dateTo   = (req.query['date_to']   as string) || '';

    const repo = AppDataSource.getRepository(FacturaCompra);
    const qb = repo.createQueryBuilder('fc')
      .where('fc.company_id = :companyId', { companyId })
      .orderBy('fc.created_at', 'DESC');

    if (search.trim()) {
      qb.andWhere(
        '(fc.invoice_number_str LIKE :s OR fc.provider_name LIKE :s OR fc.provider_nit LIKE :s)',
        { s: `%${search.trim()}%` },
      );
    }
    if (dateFrom) qb.andWhere('fc.invoice_date >= :df', { df: dateFrom });
    if (dateTo)   qb.andWhere('fc.invoice_date <= :dt', { dt: dateTo });

    const [items, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();
    res.json({ items, total, page, limit });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/facturas-compra ─────────────────────────────────────────────────

router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const companyId = req.user!.companyId;
    const body = req.body as Record<string, any>;

    if (!body.centro_costo_id) { res.status(400).json({ error: 'El centro de costo es obligatorio' }); return; }
    if (!body.sede_id) { res.status(400).json({ error: 'La sede es obligatoria' }); return; }

    // FBK-017: el NIT/cédula digitado debe corresponder a un tercero existente
    // marcado como proveedor (es_proveedor = true) antes de guardar.
    const providerBody = (body.provider as Record<string, any>) || {};
    const provNit = String(providerBody.id_number || '').replace(/\D/g, '');
    if (!provNit) { res.status(400).json({ error: 'El NIT/identificación del proveedor es obligatorio' }); return; }
    const terceroProveedor = await AppDataSource.getRepository(Tercero)
      .findOne({ where: { company_id: companyId, nit: provNit } });
    if (!terceroProveedor) {
      res.status(400).json({ error: `El NIT/cédula "${providerBody.id_number}" no corresponde a ningún tercero registrado. Cree el tercero (marcado como proveedor) antes de guardar la factura.` });
      return;
    }
    if (!terceroProveedor.es_proveedor) {
      res.status(400).json({ error: `El tercero "${terceroProveedor.nombre}" (NIT ${terceroProveedor.nit}) existe pero no está marcado como proveedor. Actualice el tercero antes de guardar la factura.` });
      return;
    }

    const settingsRepo = AppDataSource.getRepository(CompanySettings);
    const companyRepo  = AppDataSource.getRepository(Company);
    const [settings, company] = await Promise.all([
      settingsRepo.findOne({ where: { company_id: companyId } }),
      companyRepo.findOne({ where: { id: companyId } }),
    ]);
    if (!settings || !company) {
      res.status(400).json({ error: "Configuración de empresa no encontrada" }); return;
    }

    const logo = readLogo(settings);
    const pdfPayload = buildPdfPayload(company, settings, body, logo);

    let pdf_base64 = '';
    try {
      const result = await generateInvoicePdf(pdfPayload) as any;
      pdf_base64 = result.pdf_base64 || '';
    } catch (pyErr: any) {
      console.error('[FacturaCompra] Error generando PDF:', pyErr?.message || pyErr);
    }

    const provider = (body.provider as Record<string, any>) || {};
    const repo = AppDataSource.getRepository(FacturaCompra);
    const fc = repo.create({
      company_id:         companyId,
      invoice_prefix:     body.invoice_prefix     || undefined,
      invoice_number_str: body.invoice_number_str || undefined,
      invoice_date:       body.invoice_date        || undefined,
      cufe:               body.cufe               || undefined,
      provider_nit:       provider.id_number      || undefined,
      provider_id_type:   provider.id_type        || undefined,
      provider_name:      provider.name           || undefined,
      provider_address:   provider.address        || undefined,
      provider_city_name: provider.city_name      || undefined,
      provider_city_code: provider.city_code      || undefined,
      provider_email:     provider.email          || undefined,
      provider_phone:     provider.phone          || undefined,
      provider_tax_level: provider.tax_level_code || undefined,
      centro_costo_id:    body.centro_costo_id,
      sede_id:            body.sede_id,
      ciudad_codigo:      body.ciudad_codigo || undefined,
      ciudad_nombre:      body.ciudad_nombre || undefined,
      lines_json:         JSON.stringify(body.lines || []),
      subtotal:           body.subtotal       || 0,
      discount_total:     body.discount_total || 0,
      iva_total:          body.iva_total      || 0,
      iva_total_manual:   !!body.iva_total_manual,
      inc_total:          body.inc_total      || 0,
      total:              body.total          || 0,
      retefuente_base:    body.retefuente_base   || 0,
      retefuente_tarifa:  body.retefuente_tarifa || 0,
      retefuente_valor:   body.retefuente_valor  || 0,
      reteica_base:       body.reteica_base   || 0,
      reteica_tarifa:     body.reteica_tarifa || 0,
      reteica_valor:      body.reteica_valor  || 0,
      payment_means_id:   body.payment_means_id  || undefined,
      payment_method_id:  body.payment_method_id || undefined,
      cuenta_tesoreria_id: body.cuenta_tesoreria_id || undefined,
      due_date:           body.due_date      || undefined,
      notes:              body.notes         || undefined,
      description:        body.description   || undefined,
      currency:           body.currency      || 'COP',
      from_xml:           !!body.from_xml,
      pdf_base64,
    });

    const saved = await repo.save(fc);
    res.status(201).json({ id: saved.id, invoice_number_str: saved.invoice_number_str, pdf_base64 });
  } catch (e: any) {
    console.error('[FacturaCompra]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/facturas-compra/:id/pdf ──────────────────────────────────────────

router.get('/:id/pdf', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const companyId = req.user!.companyId;
    const repo = AppDataSource.getRepository(FacturaCompra);
    const fc = await repo.createQueryBuilder('fc')
      .addSelect('fc.pdf_base64')
      .where('fc.id = :id AND fc.company_id = :companyId', { id: req.params['id'], companyId })
      .getOne();

    if (!fc || !fc.pdf_base64) {
      res.status(404).json({ error: "PDF no encontrado" }); return;
    }
    const buf = Buffer.from(fc.pdf_base64, 'base64');
    const filename = `FC-${(fc.invoice_number_str || fc.id).replace(/[^a-zA-Z0-9\-_]/g, '_')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.send(buf);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/facturas-compra/:id ──────────────────────────────────────────

router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const companyId = req.user!.companyId;
    const repo = AppDataSource.getRepository(FacturaCompra);
    const fc = await repo.findOne({ where: { id: req.params['id'], company_id: companyId } });
    if (!fc) { res.status(404).json({ error: 'No encontrada' }); return; }
    await repo.remove(fc);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
