import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Company } from '../Company';
import { CuentaTesoreria } from '../tesoreria/CuentaTesoreria';
import { User } from '../User';

export type EstadoConciliacion = 'en_proceso' | 'conciliada' | 'anulada';

/**
 * Cabecera de una conciliación bancaria por período.
 * Una conciliación por cuenta por mes (unique).
 * Los movimientos marcados como 'conciliado' quedan vinculados por conciliacion_id
 * desde MovimientoTesoreria (campo opcional, se puede agregar al crecer el módulo).
 */
@Entity('conciliaciones_bancarias')
@Index(['company_id', 'cuenta_id', 'periodo'], { unique: true })
export class ConciliacionBancaria {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  /** Cuenta bancaria / caja que se concilia */
  @Column()
  cuenta_id!: string;

  @ManyToOne(() => CuentaTesoreria, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'cuenta_id' })
  cuenta!: CuentaTesoreria;

  /** Período de conciliación YYYY-MM */
  @Column({ length: 7 })
  periodo!: string;

  /** Fecha del extracto bancario */
  @Column({ type: 'date' })
  fecha_extracto!: string;

  /** Saldo según el extracto bancario */
  @Column({ type: 'decimal', precision: 18, scale: 2 })
  saldo_extracto!: number;

  /** Saldo según libros contables al cierre del período */
  @Column({ type: 'decimal', precision: 18, scale: 2 })
  saldo_libros!: number;

  /** Diferencia (saldo_extracto − saldo_libros); debe ser 0 al conciliar */
  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  diferencia!: number;

  @Column({ length: 20, default: 'en_proceso' })
  estado!: EstadoConciliacion;

  // ── Cierre de conciliación ───────────────────────────────────────────────
  @Column({ nullable: true })
  cerrada_por_id?: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'cerrada_por_id' })
  cerrada_por?: User;

  @Column({ type: 'date', nullable: true })
  fecha_cierre?: string;

  @Column({ length: 500, nullable: true })
  observaciones?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
