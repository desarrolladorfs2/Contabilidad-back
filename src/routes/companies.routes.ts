import { Router, Response } from 'express';
import { DeepPartial } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { AppDataSource } from '../config/database';
import { Company } from '../entities/Company';
import { CompanySettings } from '../entities/CompanySettings';
import { User } from '../entities/User';
import { authMiddleware, requireRole, AuthRequest } from '../middleware/auth.middleware';
import { toUploadUrl } from '../services/uploads.service';

// NOTA: antes este archivo tenía su PROPIA copia (rota) de logoUrl() que hacía
// path.relative(uploadsDir, logoPath) tratando logoPath como si ya fuera
// absoluto — pero logo_path se guarda RELATIVO ("logos/xxx_logo.png"), así
// que path.relative lo resolvía primero contra process.cwd() y devolvía una
// ruta relativa incorrecta (ej. "../../../logos/xxx_logo.png"), rompiendo el
// <img> de "Logo actual" en Configuración. auth.routes.ts ya usaba la versión
// correcta (toUploadUrl, en uploads.service.ts); esta ruta se quedó desincronizada.
function logoUrl(logoPath?: string): string | null {
  if (!logoPath) return null;
  return toUploadUrl(logoPath);
}

const router = Router();
router.use(authMiddleware);

// GET /api/companies
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const repo = AppDataSource.getRepository(Company);
    const companies = req.user!.role !== 'superadmin'
      ? await repo.find({ where: { id: req.user!.companyId }, relations: ['settings'] })
      : await repo.find({ relations: ['settings'] });
    res.json(companies);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo empresas' });
  }
});


// GET /api/companies/me — empresa del usuario autenticado
router.get('/me', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const company = await AppDataSource.getRepository(Company).findOne({
      where: { id: req.user!.companyId },
      relations: ['settings'],
    });
    if (!company) { res.status(404).json({ error: 'Empresa no encontrada' }); return; }
    const { settings, ...companyData } = company as Company & { settings?: CompanySettings };
    res.json({ ...companyData, logo_url: logoUrl(settings?.logo_path) });
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo empresa' });
  }
});

// PUT /api/companies/me — actualiza datos de la empresa del usuario
router.put('/me', requireRole('admin', 'superadmin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const repo = AppDataSource.getRepository(Company);
    const company = await repo.findOne({ where: { id: req.user!.companyId } });
    if (!company) { res.status(404).json({ error: 'Empresa no encontrada' }); return; }

    const allowed = ['name','trade_name','address','city_code','city_name','department_code','department_name','email','phone','tax_level_code','nit_dv'];
    for (const key of allowed) {
      if (key in req.body) (company as unknown as Record<string,unknown>)[key] = req.body[key];
    }
    await repo.save(company);
    res.json(company);
  } catch (e) {
    res.status(500).json({ error: 'Error actualizando empresa' });
  }
});

// GET /api/companies/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (req.user!.role !== 'superadmin' && req.params.id !== req.user!.companyId) {
      res.status(403).json({ error: 'Sin acceso a esta empresa' }); return;
    }
    const company = await AppDataSource.getRepository(Company).findOne({
      where: { id: req.params.id },
      relations: ['settings'],
    });
    if (!company) { res.status(404).json({ error: 'Empresa no encontrada' }); return; }
    res.json(company);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo empresa' });
  }
});

// POST /api/companies
router.post('/', requireRole('superadmin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const companyRepo  = AppDataSource.getRepository(Company);
    const settingsRepo = AppDataSource.getRepository(CompanySettings);

    const { nit, name, admin_email, admin_password, admin_name, ...rest } = req.body;
    if (!nit || !name) { res.status(400).json({ error: 'NIT y nombre requeridos' }); return; }

    const company = companyRepo.create({ nit, name, ...(rest as DeepPartial<Company>) });
    const savedCompany = await companyRepo.save(company as Company);

    const settings = settingsRepo.create({ company_id: savedCompany.id });
    await settingsRepo.save(settings);

    if (admin_email && admin_password) {
      const userRepo = AppDataSource.getRepository(User);
      const hash = await bcrypt.hash(admin_password, 12);
      const user = userRepo.create({
        company_id:    savedCompany.id,
        email:         admin_email.toLowerCase(),
        name:          admin_name || 'Administrador',
        password_hash: hash,
        role:          'admin',
      });
      await userRepo.save(user);
    }

    res.status(201).json(savedCompany);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Error creando empresa';
    res.status(500).json({ error: msg });
  }
});

// PUT /api/companies/:id
router.put('/:id', requireRole('admin', 'superadmin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (req.user!.role === 'admin' && req.params.id !== req.user!.companyId) {
      res.status(403).json({ error: 'Sin acceso a esta empresa' }); return;
    }
    const repo = AppDataSource.getRepository(Company);
    const company = await repo.findOne({ where: { id: req.params.id } });
    if (!company) { res.status(404).json({ error: 'Empresa no encontrada' }); return; }

    const { nit: _nit, ...updates } = req.body;
    Object.assign(company, updates);
    await repo.save(company);
    res.json(company);
  } catch (e) {
    res.status(500).json({ error: 'Error actualizando empresa' });
  }
});

// GET /api/companies/:id/users
router.get('/:id/users', requireRole('admin', 'superadmin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (req.user!.role === 'admin' && req.params.id !== req.user!.companyId) {
      res.status(403).json({ error: 'Sin acceso' }); return;
    }
    const users = await AppDataSource.getRepository(User).find({
      where: { company_id: req.params.id },
      select: ['id', 'name', 'email', 'role', 'is_active', 'created_at'],
    });
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo usuarios' });
  }
});

// POST /api/companies/:id/users
router.post('/:id/users', requireRole('admin', 'superadmin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (req.user!.role === 'admin' && req.params.id !== req.user!.companyId) {
      res.status(403).json({ error: 'Sin acceso' }); return;
    }
    const { email, password, name, role = 'operator' } = req.body;
    if (!email || !password) { res.status(400).json({ error: 'Email y contrasena requeridos' }); return; }

    const repo = AppDataSource.getRepository(User);
    const existing = await repo.findOne({ where: { email: email.toLowerCase() } });
    if (existing) { res.status(400).json({ error: 'Email ya registrado' }); return; }

    const hash = await bcrypt.hash(password, 12);
    const user = repo.create({ company_id: req.params.id, email: email.toLowerCase(), name, role, password_hash: hash });
    await repo.save(user);
    res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role });
  } catch (e) {
    res.status(500).json({ error: 'Error creando usuario' });
  }
});

// PUT /api/companies/:id/users/:userId
router.put('/:id/users/:userId', requireRole('admin', 'superadmin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (req.user!.role === 'admin' && req.params.id !== req.user!.companyId) {
      res.status(403).json({ error: 'Sin acceso' }); return;
    }
    const repo = AppDataSource.getRepository(User);
    const user = await repo.findOne({ where: { id: req.params.userId, company_id: req.params.id } });
    if (!user) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }

    const { password, ...updates } = req.body;
    Object.assign(user, updates);
    if (password) user.password_hash = await bcrypt.hash(password, 12);
    await repo.save(user);
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role, is_active: user.is_active });
  } catch (e) {
    res.status(500).json({ error: 'Error actualizando usuario' });
  }
});

export default router;
