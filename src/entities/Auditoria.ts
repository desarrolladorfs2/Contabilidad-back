/**
 * Registro inmutable de auditoría del sistema.
 *
 * Principios de diseño:
 *   - NUNCA se edita ni elimina un registro de auditoría.
 *   - user_email se desnormaliza para que el log sea legible
 *     incluso si el usuario fue eliminado después.
 *   - datos_anteriores y datos_nuevos son JSON strings del estado
 *     del objeto antes y después de la operación.
 *   - El log nunca debe romper el flujo principal (ver auditoria.service.ts).
 *   - Las llamadas al log se agregan ruta por ruta conforme se van
 *     construyendo o refinando los módulos del sistema.
 *
 * Índices recomendados para producción:
 *   - (company_id, created_at DESC) → listar eventos por empresa
 *   - (entidad, entidad_id)         → historial de un registro específico
 *   - (user_id, created_at DESC)    → actividad de un usuario
 *
 * Tabla: auditoria
 */
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
} from 'typeorm';

// ── Constantes para accion y entidad ──────────────────────────────────────────

export const AUDITORIA_ACCION = {
  // Usuarios
  LOGIN:              'login',
  LOGOUT:             'logout',
  LOGIN_FALLIDO:      'login_fallido',
  CAMBIO_PASSWORD:    'cambio_password',
  RESET_PASSWORD:     'reset_password',
  // CRUD genérico
  CREAR:              'crear',
  ACTUALIZAR:         'actualizar',
  ELIMINAR:           'eliminar',
  INACTIVAR:          'inactivar',
  ACTIVAR:            'activar',
  // Módulos y permisos
  ASIGNAR_MODULOS:    'asignar_modulos',
  REVOCAR_MODULOS:    'revocar_modulos',
  // Documentos DIAN
  ENVIAR_DIAN:        'enviar_dian',
  ANULAR:             'anular',
  // Archivos
  SUBIR_ARCHIVO:      'subir_archivo',
  ELIMINAR_ARCHIVO:   'eliminar_archivo',
} as const;

export const AUDITORIA_ENTIDAD = {
  USUARIO:            'usuario',
  EMPRESA:            'empresa',
  EMPRESA_SETTINGS:   'empresa_settings',
  FACTURA:            'factura',
  NOTA_CREDITO:       'nota_credito',
  NOTA_DEBITO:        'nota_debito',
  FACTURA_SALUD:      'factura_salud',
  TERCERO:            'tercero',
  MODULO:             'modulo',
  EMPRESA_MODULO:     'empresa_modulo',
  USUARIO_MODULO:     'usuario_modulo',
  COTIZACION:         'cotizacion',
  NOTA_CREDITO_SALUD: 'nota_credito_salud',
  NOTA_DEBITO_SALUD:  'nota_debito_salud',
  FACTURA_RECIBIDA:   'factura_recibida',
  ASIENTO:            'asiento',
  CUENTA_TESORERIA:   'cuenta_tesoreria',
  PLAN:               'plan',
  CERTIFICADO:        'certificado',
} as const;

@Entity('auditoria')
export class Auditoria {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // ── Contexto de empresa y usuario ────────────────────────────────────────
  /** Empresa donde ocurrió el evento. null para acciones de plataforma. */
  @Column({ nullable: true })
  company_id?: string;

  /** Usuario que ejecutó la acción. null para acciones del sistema/seed. */
  @Column({ nullable: true })
  user_id?: string;

  /**
   * Email del usuario al momento del evento (desnormalizado).
   * Permite leer el log aunque el usuario haya sido eliminado.
   */
  @Column({ nullable: true })
  user_email?: string;

  // ── Descripción del evento ───────────────────────────────────────────────
  /** Acción realizada. Usar constantes AUDITORIA_ACCION. */
  @Column({ length: 50 })
  accion!: string;

  /** Tipo de entidad afectada. Usar constantes AUDITORIA_ENTIDAD. */
  @Column({ length: 80 })
  entidad!: string;

  /** ID del registro afectado. */
  @Column({ nullable: true })
  entidad_id?: string;

  // ── Datos del cambio ─────────────────────────────────────────────────────
  /**
   * Estado del objeto ANTES de la operación (JSON string).
   * Se llena en: actualizar, eliminar, inactivar.
   * Se omiten campos sensibles como password_hash.
   */
  @Column({ type: 'text', nullable: true })
  datos_anteriores?: string;

  /**
   * Estado del objeto DESPUÉS de la operación (JSON string).
   * Se llena en: crear, actualizar, activar.
   * Se omiten campos sensibles como password_hash.
   */
  @Column({ type: 'text', nullable: true })
  datos_nuevos?: string;

  // ── Contexto de red ──────────────────────────────────────────────────────
  /** IPv4 o IPv6 del cliente. */
  @Column({ length: 45, nullable: true })
  ip_address?: string;

  @Column({ type: 'text', nullable: true })
  user_agent?: string;

  // ── Resultado ────────────────────────────────────────────────────────────
  /** 'exitoso' | 'fallido' | 'error' */
  @Column({ length: 20, default: 'exitoso' })
  resultado!: string;

  /** Información adicional sobre el evento o el error. */
  @Column({ type: 'text', nullable: true })
  mensaje?: string;

  /** Timestamp de creación — inmutable, generado por la BD. */
  @CreateDateColumn()
  created_at!: Date;
}
