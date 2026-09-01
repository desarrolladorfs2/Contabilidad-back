import { Router, Response } from 'express';
import multer from 'multer';
import { AppDataSource, forceSqljsSave } from '../config/database';
import { CompanySettings, ModuleKey } from '../entities/CompanySettings';
import { authMiddleware, requireRole, AuthRequest } from '../middleware/auth.middleware';
import { saveCertificate, deleteCertificate, encryptPassword, saveLogo } from '../services/certificate.service';

const router = Router();
router.use(authMiddleware);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

/** Normaliza un valor date de TypeORM (puede ser Date object o string) a YYYY-MM-DD en UTC.
 *  Evita el off-by-one que ocurre cuando el browser interpreta el timestamp con timezone local. */
function normalizeDateField(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

const DATE_FIELDS: (keyof CompanySettings)[] = [
  'resolution_date', 'resolution_start_date', 'resolution_end_date',
  'health_resolution_date', 'health_resolution_start_date', 'health_resolution_end_date',
  'ds_resolution_date', 'ds_resolution_start_date', 'ds_resolution_end_date',
  'cert_expires_at',
];

// GET /api/settings
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const settings = await AppDataSource.getRepository(CompanySettings).findOne({
      where: { company_id: req.user!.companyId },
    });
    if (!settings) { res.status(404).json({ error: 'Configuracion no encontrada' }); return; }

    const s = settings as unknown as Record<string, unknown>;
    const { cert_password_encrypted: _pw, cert_path: _cp, ...safe } = s;

    // Normalizar fechas a YYYY-MM-DD puro para que el <input type="date"> del frontend
    // no sufra desfase de timezone al hacer patchValue.
    for (const f of DATE_FIELDS) {
      if (f in safe) safe[f] = normalizeDateField(safe[f]);
    }

    res.json({ ...safe, has_certificate: !!(settings.cert_path && settings.cert_filename) });
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo configuracion' });
  }
});

// PUT /api/settings
router.put('/', requireRole('admin', 'superadmin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const repo = AppDataSource.getRepository(CompanySettings);
    let settings = await repo.findOne({ where: { company_id: req.user!.companyId } });
    if (!settings) settings = repo.create({ company_id: req.user!.companyId });

    const allowed: (keyof CompanySettings)[] = [
      'software_id', 'software_pin', 'technical_key_test', 'technical_key_prod',
      'environment', 'resolution_number', 'resolution_prefix',
      'resolution_from', 'resolution_to', 'resolution_date',
      'resolution_start_date', 'resolution_end_date',
      'next_invoice_number', 'invoice_prefix',
      'next_credit_note_number', 'credit_note_prefix',
      'next_debit_note_number', 'debit_note_prefix',
      'health_prefix', 'next_health_invoice_number',
      'health_resolution_number', 'health_resolution_date',
      'health_resolution_start_date', 'health_resolution_end_date',
      'health_resolution_from', 'health_resolution_to',
      // SAL-057: prefijo/consecutivo de Notas Crédito y Débito de Salud — ya
      // existían en la entidad CompanySettings pero faltaban en esta lista
      // blanca, así que el formulario de Ajustes no podía guardarlos.
      'health_credit_note_prefix', 'next_health_credit_note_number',
      'health_debit_note_prefix', 'next_health_debit_note_number',
      // Documento Soporte (DS) — numeración y resolución/autorización DIAN
      'ds_prefix', 'next_ds_number',
      'nota_ajuste_ds_prefix', 'next_nota_ajuste_ds_number',
      'ds_resolution_number', 'ds_resolution_date',
      'ds_resolution_prefix', 'ds_resolution_from', 'ds_resolution_to',
      'ds_resolution_start_date', 'ds_resolution_end_date',
      'enabled_modules',
      'pdf_primary_color', 'pdf_secondary_color',
      // Nómina electrónica
      'software_id_nomina', 'software_pin_nomina',
      'test_set_id_nomina', 'software_security_code_nomina',
      'next_payroll_document_number',
    'nit_dv',
    'nomina_prefix',
      // RADIAN — Eventos (Res. 000085/2022)
      'software_id_radian', 'software_pin_radian', 'next_radian_evento_number',
    ];
    for (const key of allowed) {
      if (key in req.body) (settings as unknown as Record<string, unknown>)[key] = req.body[key];
    }
    await repo.save(settings);
    await forceSqljsSave();
    res.json({ message: 'Configuracion guardada' });
  } catch (e) {
    res.status(500).json({ error: 'Error guardando configuracion' });
  }
});

// PUT /api/settings/modules
router.put('/modules', requireRole('admin', 'superadmin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { enabled_modules } = req.body as { enabled_modules: ModuleKey[] };
    if (!Array.isArray(enabled_modules)) { res.status(400).json({ error: 'enabled_modules debe ser un array' }); return; }

    const repo = AppDataSource.getRepository(CompanySettings);
    const settings = await repo.findOne({ where: { company_id: req.user!.companyId } });
    if (!settings) { res.status(404).json({ error: 'Configuracion no encontrada' }); return; }

    settings.enabled_modules = enabled_modules;
    await repo.save(settings);
    await forceSqljsSave();
    res.json({ enabled_modules: settings.enabled_modules });
  } catch (e) {
    res.status(500).json({ error: 'Error actualizando modulos' });
  }
});

// POST /api/settings/certificate
router.post('/certificate', requireRole('admin', 'superadmin'), upload.single('certificate'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      if (!req.file) { res.status(400).json({ error: 'Archivo de certificado requerido' }); return; }
      const { cert_password } = req.body;
      if (!cert_password) { res.status(400).json({ error: 'Contrasena del certificado requerida' }); return; }

      const repo = AppDataSource.getRepository(CompanySettings);
      const settings = await repo.findOne({ where: { company_id: req.user!.companyId } });
      if (!settings) { res.status(404).json({ error: 'Configuracion no encontrada' }); return; }

      if (settings.cert_path) deleteCertificate(settings.cert_path);

      const certPath = saveCertificate(req.file.buffer, req.file.originalname, req.user!.companyId);
      settings.cert_filename           = req.file.originalname;
      settings.cert_path               = certPath;
      settings.cert_password_encrypted = encryptPassword(cert_password);
      // Hallazgo #57: certificados subidos a partir de ahora se cifran en
      // disco (saveCertificate ya los cifra) — este flag lo deja registrado
      // para que la lectura posterior sepa que debe desencriptar.
      settings.cert_encrypted_at_rest  = true;
      if (req.body.cert_expires_at) settings.cert_expires_at = req.body.cert_expires_at;

      await repo.save(settings);
      await forceSqljsSave();
      res.json({ message: 'Certificado cargado correctamente', filename: settings.cert_filename });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Error cargando certificado';
      res.status(500).json({ error: msg });
    }
  },
);

// DELETE /api/settings/certificate
router.delete('/certificate', requireRole('admin', 'superadmin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const repo = AppDataSource.getRepository(CompanySettings);
    const settings = await repo.findOne({ where: { company_id: req.user!.companyId } });
    if (!settings || !settings.cert_path) { res.status(404).json({ error: 'No hay certificado configurado' }); return; }

    deleteCertificate(settings.cert_path);
    settings.cert_path               = undefined;
    settings.cert_filename           = undefined;
    settings.cert_password_encrypted = undefined;
    settings.cert_expires_at         = undefined;
    await repo.save(settings);
    await forceSqljsSave();
    res.json({ message: 'Certificado eliminado' });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando certificado' });
  }
});

// POST /api/settings/logo
router.post('/logo', requireRole('admin', 'superadmin'), upload.single('logo'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      if (!req.file) { res.status(400).json({ error: 'Imagen requerida' }); return; }

      const logoPath = saveLogo(req.file.buffer, req.file.originalname, req.user!.companyId);
      const repo = AppDataSource.getRepository(CompanySettings);
      const settings = await repo.findOne({ where: { company_id: req.user!.companyId } });
      if (!settings) { res.status(404).json({ error: 'Configuracion no encontrada' }); return; }

      settings.logo_path = logoPath;
      await repo.save(settings);
      await forceSqljsSave();
      res.json({ message: 'Logo cargado correctamente' });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Error cargando logo';
      res.status(500).json({ error: msg });
    }
  },
);

export default router;
