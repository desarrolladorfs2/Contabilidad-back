import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index, OneToMany,
} from 'typeorm';
import { Company } from '../Company';
import { User } from '../User';

export type TipoDeclaracion = 'iva' | 'retefuente' | 'reteica' | 'ica' | 'renta' | 'cree';
export type EstadoDeclaracion = 'pendiente' | 'presentada' | 'pagada' | 'corregida' | 'anulada';

/**
 * Registro de declaraciones tributarias presentadas o por presentar.
 *
 * Período según tipo:
 *   - IVA bimestral:        '2024-B1' a '2024-B6'  (o mensual: '2024-01')
 *   - Retefuente mensual:   '2024-01' … '2024-12'
 *   - ICA bimestral:        '2024-B1' a '2024-B6'
 *   - Renta anual:          '2024'
 *
 * Tabla: impuestos_declaraciones
 */
@Entity('impuestos_declaraciones')
@Index(['company_id', 'tipo', 'periodo'], { unique: true })
export class DeclaracionImpuesto {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  /** Tipo de impuesto declarado */
  @Column({ length: 20 })
  tipo!: TipoDeclaracion;

  /**
   * Período que cubre la declaración.
   * Formato libre según tipo: '2024-01', '2024-B2', '2024', etc.
   */
  @Column({ length: 10 })
  periodo!: string;

  /** Estado actual de la declaración */
  @Column({ length: 20, default: 'pendiente' })
  estado!: EstadoDeclaracion;

  /** Número de formulario DIAN (ej: '300' para IVA, '350' para retefuente) */
  @Column({ length: 10, nullable: true })
  formulario?: string;

  /** Número de radicación asignado por la DIAN al presentar */
  @Column({ length: 50, nullable: true })
  numero_formulario?: string;

  /** Fecha límite para presentar sin sanción */
  @Column({ type: 'date', nullable: true })
  fecha_vencimiento?: string;

  /** Fecha efectiva en que se presentó la declaración */
  @Column({ type: 'date', nullable: true })
  fecha_presentacion?: string;

  /** Fecha en que se realizó el pago total */
  @Column({ type: 'date', nullable: true })
  fecha_pago?: string;

  // ── Valores tributarios ──────────────────────────────────────────────────

  /** Base gravable calculada para el período */
  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  base_gravable!: number;

  /** Impuesto generado sobre la base gravable */
  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  impuesto_cargo!: number;

  /** Retenciones a favor o descuentos tributarios */
  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  descuentos!: number;

  /** Saldo a pagar antes de sanciones e intereses */
  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  saldo_pagar!: number;

  /** Sanciones por extemporaneidad u otras causales */
  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  sanciones!: number;

  /** Intereses moratorios */
  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  intereses!: number;

  /** Total a pagar (saldo_pagar + sanciones + intereses) */
  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  total_pagar!: number;

  // ── Auditoría ────────────────────────────────────────────────────────────

  @Column({ nullable: true })
  presentada_por_id?: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'presentada_por_id' })
  presentada_por?: User;

  @Column({ length: 1000, nullable: true })
  observaciones?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
