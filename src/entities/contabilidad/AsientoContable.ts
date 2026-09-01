import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, OneToMany, JoinColumn, Index,
} from 'typeorm';
import { Company } from '../Company';
import { User } from '../User';
import { Sede } from './Sede';
import { LineaAsiento } from './LineaAsiento';

export type EstadoAsiento = 'borrador' | 'aprobado' | 'anulado';
export type OrigenAsiento = 'manual' | 'factura' | 'compra' | 'salud' | 'tesoreria' | 'nomina' | 'ajuste';

@Entity('asientos_contables')
@Index(['company_id', 'numero'], { unique: true, where: '"numero" IS NOT NULL' })
export class AsientoContable {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  /** Numero consecutivo por empresa; se asigna al aprobar */
  @Column({ type: 'int', nullable: true })
  numero?: number;

  @Column({ type: 'date' })
  fecha!: string;

  /** Periodo contable YYYY-MM (derivado de fecha; almacenado para queries eficientes) */
  @Column({ length: 7, nullable: true })
  periodo?: string;

  @Column({ length: 20, default: 'borrador' })
  estado!: EstadoAsiento;

  @Column({ length: 20, nullable: true })
  origen?: OrigenAsiento;

  /** Tipo del documento de origen (factura, compra, salud, tesoreria...) */
  @Column({ length: 30, nullable: true })
  referencia_tipo?: string;

  /** ID del documento de origen en su tabla respectiva */
  @Column({ nullable: true })
  referencia_id?: string;

  @Column({ length: 500, nullable: true })
  descripcion?: string;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  total_debito!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  total_credito!: number;

  @Column({ nullable: true })
  sede_id?: string;

  @ManyToOne(() => Sede, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'sede_id' })
  sede?: Sede;

  @Column({ nullable: true })
  aprobado_por_id?: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'aprobado_por_id' })
  aprobado_por?: User;

  @Column({ nullable: true })
  anulado_por_id?: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'anulado_por_id' })
  anulado_por?: User;

  @Column({ type: 'date', nullable: true })
  fecha_anulacion?: string;

  @Column({ length: 500, nullable: true })
  motivo_anulacion?: string;

  @OneToMany(() => LineaAsiento, linea => linea.asiento, { cascade: true })
  lineas!: LineaAsiento[];

  @Column({ nullable: true })
  created_by_user_id?: string;

  @Column({ length: 120, nullable: true })
  created_by_name?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
