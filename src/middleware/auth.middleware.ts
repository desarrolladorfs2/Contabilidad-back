import { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';
import { AppDataSource } from '../config/database';
import { User } from '../entities/User';

export interface AuthRequest extends Request {
  user?: { id: string; companyId: string; role: string; email: string; name: string; };
}

/**
 * Exige que JWT_SECRET esté configurado en el entorno — sin fallback a un
 * valor hardcodeado. Si el proceso corre sin esta variable, la app no debe
 * arrancar en vez de emitir/aceptar tokens firmados con un secreto público
 * conocido en el código fuente.
 */
export function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET no está configurado. Defínelo en el archivo .env antes de arrancar el servidor.');
  }
  return secret;
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  // Acepta token en header Authorization: Bearer <token>
  // O como query param ?token=<token> (necesario para descargas directas <a href>)
  const token = header?.startsWith('Bearer ')
    ? header.slice(7)
    : (req.query.token as string | undefined);

  if (!token) {
    res.status(401).json({ error: 'Token requerido' });
    return;
  }
  try {
    const secret  = requireJwtSecret();
    const decoded = jwt.verify(token, secret) as {
      userId: string; companyId: string; role: string; email: string; name?: string;
    };
    req.user = {
      id:        decoded.userId,
      companyId: decoded.companyId,
      role:      decoded.role,
      email:     decoded.email,
      name:      decoded.name ?? decoded.email,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    const role = (req as AuthRequest).user?.role || '';
    // superadmin bypasses all role restrictions
    if (role === 'superadmin' || roles.includes(role)) {
      next();
      return;
    }
    res.status(403).json({ error: 'Sin permisos' });
  };
}
