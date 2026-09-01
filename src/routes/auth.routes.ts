import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { AppDataSource } from '../config/database';
import { User } from '../entities/User';
import { Company } from '../entities/Company';
import { CompanySettings } from '../entities/CompanySettings';
import { UsuarioModulo } from '../entities/UsuarioModulo';
import { authMiddleware, AuthRequest, requireJwtSecret } from '../middleware/auth.middleware';
import { auditarLogin, auditarLoginFallido } from '../services/auditoria.service';
import { toUploadUrl } from '../services/uploads.service';

/** Devuelve los códigos de módulos activos para un usuario */
async function getModulosCodigos(userId: string): Promise<string[]> {
  const umRepo = AppDataSource.getRepository(UsuarioModulo);
  const rows = await umRepo.find({
    where: { user_id: userId, activo: true },
    relations: ['modulo'],
  });
  return rows
    .filter(r => r.modulo?.activo)
    .map(r => r.modulo.codigo);
}

function logoUrl(logoPath?: string): string | null {
  if (!logoPath) return null;
  return toUploadUrl(logoPath);
}

const router = Router();

// Protección básica contra fuerza bruta: máx. 10 intentos de login por IP cada 15 min.
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en unos minutos.' },
});

// Mismo límite para /setup — crea la primera empresa+admin, solo debería ejecutarse una vez,
// pero mientras el sistema no está configurado el endpoint queda abierto sin auth alguna.
const setupRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Intenta de nuevo en unos minutos.' },
});

// /cambiar-password ya requiere JWT válido, pero igual limitamos intentos de fuerza bruta
// contra password_actual (un atacante con un JWT robado podría intentar adivinarla).
const cambiarPasswordRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Intenta de nuevo en unos minutos.' },
});

// POST /api/auth/login
// Soporta multi-empresa: si el mismo email existe en varias empresas, primero verifica
// la contraseña y devuelve { requires_company, companies }. El cliente re-envía con
// company_id para obtener el JWT de la empresa seleccionada.
router.post('/login', loginRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { email, password, company_id } = req.body as { email: string; password: string; company_id?: string };
  if (!email || !password) {
    res.status(400).json({ error: 'Email y contraseña requeridos' });
    return;
  }
  try {
    const userRepo = AppDataSource.getRepository(User);

    let user: User | null = null;

    if (company_id) {
      // Selección directa de empresa (segundo paso del selector)
      user = await userRepo.findOne({
        where: { email: email.toLowerCase(), is_active: true, company_id },
        relations: ['company', 'company.settings'],
      });
    } else {
      // Buscar todos los usuarios con ese email en empresas activas
      const candidates = await userRepo.find({
        where: { email: email.toLowerCase(), is_active: true },
        relations: ['company', 'company.settings'],
      });

      if (candidates.length === 0) {
        await auditarLoginFallido(req, email.toLowerCase());
        res.status(401).json({ error: 'Credenciales inválidas' });
        return;
      }

      if (candidates.length > 1) {
        // Verificar contraseña con el primer candidato (todos comparten el mismo email/pw)
        const pwOk = await bcrypt.compare(password, candidates[0].password_hash);
        if (!pwOk) {
          await auditarLoginFallido(req, email.toLowerCase());
          res.status(401).json({ error: 'Credenciales inválidas' });
          return;
        }
        // Devolver lista de empresas para que el frontend muestre el selector
        res.json({
          requires_company: true,
          companies: candidates.map(u => ({
            id: u.company_id,
            name: u.company?.name ?? '',
            nit:  u.company?.nit  ?? '',
          })),
        });
        return;
      }

      user = candidates[0];
    }

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      await auditarLoginFallido(req, email.toLowerCase());
      res.status(401).json({ error: 'Credenciales inválidas' });
      return;
    }

    // Actualizar último login
    user.ultimo_login = new Date();
    await userRepo.save(user);

    const modulos = await getModulosCodigos(user.id);
    const secret  = requireJwtSecret();
    const expires = process.env.JWT_EXPIRES_IN || '8h';
    const token = jwt.sign(
      { userId: user.id, companyId: user.company_id, role: user.role, email: user.email, name: user.name, modulos },
      secret,
      { expiresIn: expires } as jwt.SignOptions,
    );

    // Registrar auditoría de login exitoso
    await auditarLogin(req, user.id, user.email, user.company_id);

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        modulos,
        debe_cambiar_password: user.debe_cambiar_password,
      },
      company: user.company
        ? { id: user.company.id, name: user.company.name, nit: user.company.nit, logo_url: logoUrl(user.company.settings?.logo_path) }
        : null,
    });
  } catch (e) {
    res.status(500).json({ error: 'Error en login' });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userRepo = AppDataSource.getRepository(User);
    const user = await userRepo.findOne({
      where: { id: req.user!.id },
      relations: ['company', 'company.settings'],
    });
    if (!user) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }
    const modulos = await getModulosCodigos(user.id);
    res.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role, modulos },
      company: user.company
        ? {
            ...user.company,
            logo_url: logoUrl(user.company.settings?.logo_path),
          }
        : null,
    });
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo perfil' });
  }
});

// POST /api/auth/setup — crea la primera empresa + admin (solo si no hay usuarios)
router.post('/setup', setupRateLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const userRepo    = AppDataSource.getRepository(User);
    const companyRepo = AppDataSource.getRepository(Company);

    const existing = await userRepo.count();
    if (existing > 0) {
      res.status(400).json({ error: 'El sistema ya está configurado' });
      return;
    }

    const { company_nit, company_name, admin_email, admin_password, admin_name } = req.body;
    if (!company_nit || !company_name || !admin_email || !admin_password) {
      res.status(400).json({ error: 'Faltan campos requeridos' });
      return;
    }

    // Crear empresa
    const company = companyRepo.create({ nit: company_nit, name: company_name });
    await companyRepo.save(company);

    // Crear settings vacíos
    const settingsRepo = AppDataSource.getRepository(CompanySettings);
    const settings = settingsRepo.create({ company_id: company.id });
    await settingsRepo.save(settings);

    // Crear admin
    const hash = await bcrypt.hash(admin_password, 12);
    const user = userRepo.create({
      company_id:    company.id,
      email:         admin_email.toLowerCase(),
      name:          admin_name || 'Administrador',
      password_hash: hash,
      role:          'admin',
    });
    await userRepo.save(user);

    res.status(201).json({ message: 'Sistema configurado correctamente', company_id: company.id });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Error en setup';
    res.status(500).json({ error: msg });
  }
});

// POST /api/auth/cambiar-password — cambia contraseña y limpia el flag debe_cambiar_password
router.post('/cambiar-password', authMiddleware, cambiarPasswordRateLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { password_actual, password_nueva } = req.body;
    if (!password_nueva || password_nueva.length < 6) {
      res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
      return;
    }
    const userRepo = AppDataSource.getRepository(User);
    const user = await userRepo.findOne({ where: { id: req.user!.id } });
    if (!user) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }

    // Si debe_cambiar_password está en false, exigir la contraseña actual
    if (!user.debe_cambiar_password) {
      if (!password_actual) { res.status(400).json({ error: 'Debes proporcionar la contraseña actual' }); return; }
      const ok = await bcrypt.compare(password_actual, user.password_hash);
      if (!ok) { res.status(401).json({ error: 'Contraseña actual incorrecta' }); return; }
    }

    user.password_hash        = await bcrypt.hash(password_nueva, 10);
    user.debe_cambiar_password = false;
    await userRepo.save(user);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Error cambiando contraseña' }); }
});

export default router;
