/**
 * Un registro individual dentro de un lote de cargue.
 * Cada registro corresponde a una factura de salud evento por paciente.
 * La referencia_externa es la clave de negocio para el upsert (no duplicar).
 * Tabla: salud_registros_cargue
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index, Unique,
} from 'typeorm';
import { Company } from '../Company';
import { LoteCargue } from './LoteCargue';
import { CentroCosto } from '../contabilidad/CentroCosto';
import { Sede } from '../contabilidad/Sede';

export type RegistroCargueStatus = 'pendiente' | 'en_revision' | 'cerrada' | 'error';

@Entity('salud_registros_cargue')
@Unique(['company_id', 'referencia_externa'])
export class RegistroCargue {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { nullable: false, onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column()
  lote_id!: string;

  @ManyToOne(() => LoteCargue, { nullable: false, onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'lote_id' })
  lote!: LoteCargue;

  /** Factura de salud creada/vinculada a partir de este registro */
  @Column({ nullable: true })
  factura_salud_id?: string;

  /**
   * Clave de negocio única que pone el usuario en el Excel.
   * Permite el upsert: si ya existe con este ID, actualiza en vez de duplicar.
   */
  @Index()
  @Column({ length: 100 })
  referencia_externa!: string;

  /** Usuario al que está asignada esta factura para cierre */
  @Column({ nullable: true })
  asignado_a_user_id?: string;

  @Column({ length: 120, nullable: true })
  asignado_a_user_name?: string;

  @Column({ length: 20, default: 'pendiente' })
  status!: RegistroCargueStatus;

  @Column({ type: 'text', nullable: true })
  error_detalle?: string;

  // Campos denormalizados para la vista de lista sin parsear JSON
  @Column({ length: 10, nullable: true })
  paciente_tipo_doc?: string;

  @Column({ length: 30, nullable: true })
  paciente_num_doc?: string;

  @Column({ length: 200, nullable: true })
  paciente_nombre?: string;

  /** Fecha más temprana de atención de los servicios del paciente */
  @Column({ type: 'date', nullable: true })
  fecha_atencion?: string;

  /** Datos completos del cargue en JSON (pacientes + servicios) para reconstruir la factura */
  @Column({ type: 'simple-json', nullable: true })
  datos_raw?: Record<string, unknown>;

  /**
   * Centro de costo y sede asignados a este registro antes de generar la
   * factura de salud — deben ser uno de los permitidos por el contrato del lote
   * (`lote.contrato.centros_costo` / `lote.contrato.sedes`). Se copian a la
   * FacturaSalud cuando el registro se cierra y genera la factura.
   */
  @Column({ nullable: true })
  centro_costo_id?: string;

  @ManyToOne(() => CentroCosto, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'centro_costo_id' })
  centro_costo?: CentroCosto;

  @Column({ nullable: true })
  sede_id?: string;

  @ManyToOne(() => Sede, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'sede_id' })
  sede?: Sede;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
