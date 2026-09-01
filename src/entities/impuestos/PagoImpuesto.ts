import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  ManyToOne, JoinColumn,
} from 'typeorm';
import { Company } from '../Company';
import { DeclaracionImpuesto } from './DeclaracionImpuesto';
import { CuentaTesoreria } from '../tesoreria/CuentaTesoreria';
import { AsientoContable } from '../contabilidad/AsientoContable';
import { User } from '../User';

/**
 * Registro de pagos realizados para una declaración tributaria.
 * Una declaración puede tener múltiples pagos (cuotas, pagos parciales,
 * pago de sanciones posterior al pago del impuesto, etc.).
 *
 * Tabla: impuestos_pagos
 */
@Entity('impuestos_pagos')
export class PagoImpuesto {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  /** Declaración a la que corresponde este pago */
  @Column()
  declaracion_id!: string;

  @ManyToOne(() => DeclaracionImpuesto, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'declaracion_id' })
  declaracion!: DeclaracionImpuesto;

  /** Fecha efectiva del pago */
  @Column({ type: 'date' })
  fecha_pago!: string;

  /** Monto pagado */
  @Column({ type: 'decimal', precision: 18, scale: 2 })
  valor!: number;

  /**
   * Referencia de la transacción bancaria o recibo oficial de pago DIAN.
   * Ej: número de recibo electrónico de pago (REP).
   */
  @Column({ length: 100, nullable: true })
  referencia_pago?: string;

  /**
   * Cuenta de tesorería (banco/caja) desde la que salió el dinero.
   * Permite cuadrar el egreso en el módulo de tesorería.
   */
  @Column({ nullable: true })
  cuenta_tesoreria_id?: string;

  @ManyToOne(() => CuentaTesoreria, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'cuenta_tesoreria_id' })
  cuenta_tesoreria?: CuentaTesoreria;

  /**
   * Asiento contable generado automáticamente al registrar el pago.
   * Débito: impuesto por pagar / Crédito: banco.
   */
  @Column({ nullable: true })
  asiento_id?: string;

  @ManyToOne(() => AsientoContable, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'asiento_id' })
  asiento?: AsientoContable;

  @Column({ nullable: true })
  registrado_por_id?: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'registrado_por_id' })
  registrado_por?: User;

  @Column({ length: 500, nullable: true })
  observaciones?: string;

  @CreateDateColumn()
  created_at!: Date;
}
