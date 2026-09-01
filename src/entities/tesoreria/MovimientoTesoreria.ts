import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Company } from '../Company';
import { CuentaTesoreria } from './CuentaTesoreria';
import { AsientoContable } from '../contabilidad/AsientoContable';
import { MedioPago } from '../catalogo/MedioPago';

export type TipoMovimiento = 'ingreso' | 'egreso' | 'traslado';
export type EstadoMovimiento = 'pendiente' | 'conciliado' | 'anulado';

@Entity('movimientos_tesoreria')
export class MovimientoTesoreria {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  /** Numero consecutivo por empresa */
  @Column({ type: 'int', nullable: true })
  numero?: number;

  @Column({ type: 'date' })
  fecha!: string;

  @Column({ length: 20 })
  tipo!: TipoMovimiento;

  @Column({ length: 20, default: 'pendiente' })
  estado!: EstadoMovimiento;

  @Column()
  cuenta_id!: string;

  @ManyToOne(() => CuentaTesoreria, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'cuenta_id' })
  cuenta!: CuentaTesoreria;

  /** Solo para tipo traslado: cuenta destino */
  @Column({ nullable: true })
  cuenta_destino_id?: string;

  @ManyToOne(() => CuentaTesoreria, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'cuenta_destino_id' })
  cuenta_destino?: CuentaTesoreria;

  @Column({ type: 'decimal', precision: 18, scale: 2 })
  valor!: number;

  /** NIT del tercero (texto libre) — campo simple, no FK, para que el
   *  formulario de movimientos pueda guardarlo directamente sin un picker. */
  @Column({ length: 30, nullable: true })
  tercero_nit?: string;

  /** Nombre de categoría (texto libre/lista desplegable del frontend) — no
   *  es una FK real a un catálogo de categorías. */
  @Column({ length: 100, nullable: true })
  categoria?: string;

  @Column({ nullable: true })
  medio_pago_id?: string;

  @ManyToOne(() => MedioPago, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'medio_pago_id' })
  medio_pago?: MedioPago;

  /** Tipo del documento de origen (factura, compra, salud...) */
  @Column({ length: 30, nullable: true })
  origen_tipo?: string;

  /** ID del documento de origen */
  @Column({ nullable: true })
  origen_id?: string;

  /** Asiento contable generado para este movimiento */
  @Column({ nullable: true })
  asiento_id?: string;

  @ManyToOne(() => AsientoContable, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'asiento_id' })
  asiento?: AsientoContable;

  @Column({ length: 500, nullable: true })
  concepto?: string;

  @Column({ length: 100, nullable: true })
  referencia?: string;

  @Column({ nullable: true })
  created_by_user_id?: string;

  @Column({ length: 120, nullable: true })
  created_by_name?: string;

  /** Conciliación bancaria formal (cierre de período) a la que quedó vinculado este movimiento */
  @Column({ nullable: true })
  conciliacion_id?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
