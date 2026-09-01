/**
 * Módulos contratados por empresa (tabla pivote).
 * Define qué módulos del sistema tiene habilitados cada cliente.
 *
 * Relación: companies (1) ──< empresa_modulo >── (N) modulos
 *
 * Flujo:
 *   1. Platform admin habilita módulos para la empresa en esta tabla.
 *   2. Company admin asigna esos módulos a usuarios en usuario_modulo.
 *   3. usuario_modulo solo debería contener módulos que estén activos en empresa_modulo.
 *
 * Tabla: empresa_modulo
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  ManyToOne, JoinColumn, Unique,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';
import { Company } from './Company';
import { Modulo } from './Modulo';

@Entity('empresa_modulo')
@Unique(['company_id', 'modulo_id'])
export class EmpresaModulo {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @Column()
  modulo_id!: string;

  /** Si false, el módulo está deshabilitado para esta empresa (soft disable) */
  @Column({ default: true })
  activo!: boolean;

  /**
   * Fecha desde la que el módulo está disponible.
   * null = disponible desde siempre.
   */
  @Column({ type: 'date', nullable: true })
  fecha_inicio?: string;

  /**
   * Fecha hasta la que el módulo está disponible (vencimiento de suscripción).
   * null = sin vencimiento.
   */
  @Column({ type: 'date', nullable: true })
  fecha_fin?: string;

  /** Email del usuario de plataforma que realizó la asignación */
  @Column({ length: 150, nullable: true })
  asignado_por?: string;

  /** Notas internas sobre la contratación o condiciones del módulo */
  @Column({ type: 'text', nullable: true })
  notas?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  // ── Relaciones ───────────────────────────────────────────────────────────
  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company?: Company;

  @ManyToOne(() => Modulo)
  @JoinColumn({ name: 'modulo_id' })
  modulo?: Modulo;
}
