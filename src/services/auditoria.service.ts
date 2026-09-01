/**
 * Helper de auditoría.
 * Llama a este helper desde cualquier ruta para registrar eventos.
 *
 * Uso básico:
 *   await registrarAuditoria({
 *     req,
 *     accion:    AUDITORIA_ACCION.CREAR,
 *     entidad:   AUDITORIA_ENTIDAD.USUARIO,
 *     entidadId: nuevoUsuario.id,
 *     datosNuevos: { email: nuevoUsuario.email, role: nuevoUsuario.role },
 *   });
 *
 * El helper NUNCA lanza error ni bloquea el flujo principal.
 * Si la BD de auditoría falla, solo se imprime en consola.
 */
import { Request } from 'express';
import { AppDataSource } from '../config/database';
import { Auditoria } from '../entities/Auditoria';
import { AuthRequest } from '../middleware/auth.middleware';

export { AUDITORIA_ACCION, AUDITORIA_ENTIDAD } from '../entities/Auditoria';

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface AuditoriaParams {
  /** Request de Express — extrae automáticamente userId, companyId, ip, userAgent */
  req?: Request | AuthRequest;

  // Sobreescribir datos del request si es necesario (ej: acciones del sistema)
  companyId?: string;
  userId?:    string;
  userEmail?: string;

  /** Acción realizada. Usar constantes AUDITORIA_ACCION. */
  accion: string;

  /** Entidad afectada. Usar constantes AUDITORIA_ENTIDAD. */
  entidad: string;

  /** ID del registro afectado. */
  entidadId?: string;

  /**
   * Estado previo del objeto.
   * Omitir campos sensibles: password_hash, cert_data, cert_password_encrypted.
   */
  datosAnteriores?: Record<string, unknown> | null;

  /**
   * Estado nuevo del objeto.
   * Omitir campos sensibles.
   */
  datosNuevos?: Record<string, unknown> | null;

  /** 'exitoso' | 'fallido' | 'error'. Default: 'exitoso'. */
  resultado?: 'exitoso' | 'fallido' | 'error';

  /** Contexto adicional (mensaje de error, razón de rechazo, etc.). */
  mensaje?: string;
}

// ── Campos a nunca loguear ────────────────────────────────────────────────────

const CAMPOS_SENSIBLES = new Set([
  'password_hash', 'password', 'cert_data',
  'cert_password_encrypted', 'cert_path', 'software_pin',
  'technical_key_prod', 'technical_key_test',
]);

function sanitizar(obj: Record<string, unknown> | null | undefined): string | undefined {
  if (!obj) return undefined;
  const limpio: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    limpio[k] = CAMPOS_SENSIBLES.has(k) ? '[REDACTED]' : v;
  }
  return JSON.stringify(limpio);
}

// ── Helper principal ──────────────────────────────────────────────────────────

export async function registrarAuditoria(params: AuditoriaParams): Promise<void> {
  try {
    const repo = AppDataSource.getRepository(Auditoria);

    // Extraer datos del request si se proporcionó
    const authReq  = params.req as AuthRequest | undefined;
    const companyId = params.companyId ?? authReq?.user?.companyId;
    const userId    = params.userId    ?? authReq?.user?.id;
    const userEmail = params.userEmail ?? authReq?.user?.email;

    // IP — considerar proxies (X-Forwarded-For)
    let ip: string | undefined;
    if (params.req) {
      const forwarded = params.req.headers['x-forwarded-for'];
      ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0])
        ?? params.req.socket?.remoteAddress
        ?? undefined;
    }

    const userAgent = params.req?.headers?.['user-agent'];

    await repo.save(repo.create({
      company_id:       companyId,
      user_id:          userId,
      user_email:       userEmail,
      accion:           params.accion,
      entidad:          params.entidad,
      entidad_id:       params.entidadId,
      datos_anteriores: sanitizar(params.datosAnteriores ?? undefined),
      datos_nuevos:     sanitizar(params.datosNuevos     ?? undefined),
      ip_address:       ip,
      user_agent:       typeof userAgent === 'string' ? userAgent.slice(0, 500) : undefined,
      resultado:        params.resultado ?? 'exitoso',
      mensaje:          params.mensaje,
    }));
  } catch (e) {
    // El log NUNCA debe romper el flujo principal
    console.error('[Auditoria] Error registrando evento:', e);
  }
}

// ── Helpers de conveniencia ───────────────────────────────────────────────────

/** Atajo para registrar un login exitoso */
export async function auditarLogin(
  req: Request,
  userId: string,
  userEmail: string,
  companyId: string,
): Promise<void> {
  await registrarAuditoria({
    req, companyId, userId, userEmail,
    accion:  'login',
    entidad: 'usuario',
    entidadId: userId,
    resultado: 'exitoso',
  });
}

/** Atajo para registrar un intento de login fallido */
export async function auditarLoginFallido(
  req: Request,
  emailIntentado: string,
): Promise<void> {
  await registrarAuditoria({
    req,
    accion:    'login_fallido',
    entidad:   'usuario',
    resultado: 'fallido',
    mensaje:   `Intento fallido para: ${emailIntentado}`,
  });
}
