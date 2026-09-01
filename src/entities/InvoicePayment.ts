import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Factura } from './Invoice';
import { Company } from './Company';
import { MedioPago } from './catalogo/MedioPago';
import { MovimientoTesoreria } from './tesoreria/MovimientoTesoreria';

/** abono = cuota inicial / anticipo; cuota = cuota periódica; pago_libre = pago sin plan */
export type TipoPagoFactura = 'abono' | 'cuota' | 'pago_libre';

/** @deprecated Usar TipoPagoFactura */
export type InvoicePaymentType = TipoPagoFactura;

/** Pago o cuota de una factura. Tabla: pagos_factura */
@Entity('pagos_factura')
@Index(['factura_id'])
@Index(['company_id', 'fecha_pago'])
@Index(['company_id', 'esta_pagado'])
export class PagoFactura {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Nullable en DB para compatibilidad con filas históricas sin company_id.
   * Regla de negocio: siempre requerido al crear/actualizar desde el route.
   */
  @ManyToOne(() => Company, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company?: Company;

  @Column({ nullable: true })
  company_id?: string;

  @ManyToOne(() => Factura, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'factura_id' })
  factura!: Factura;

  @Column()
  factura_id!: string;

  /** Tipo de movimiento */
  @Column({ length: 20, default: 'cuota' })
  tipo!: TipoPagoFactura;

  /** 1-based: cuota 1, cuota 2... 0 = abono inicial */
  @Column({ default: 0 })
  cuota_numero!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2 })
  valor!: number;

  /** Fecha de vencimiento de esta cuota */
  @Column({ type: 'date', nullable: true })
  fecha_vencimiento?: string;

  /** Fecha en que se registró el pago efectivo */
  @Column({ type: 'date', nullable: true })
  fecha_pago?: string;

  /** Si la cuota ha sido pagada */
  @Column({ default: false })
  esta_pagado!: boolean;

  /** Monto real pagado (puede diferir de valor por abonos parciales) */
  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  valor_pagado?: number;

  /**
   * Medio de pago utilizado.
   * FK a cat_medios_pago - permite reportes de recaudo por medio de pago.
   */
  @Column({ nullable: true })
  medio_pago_id?: string;

  @ManyToOne(() => MedioPago, { nullable: true, onDelete: 'SET NULL', eager: false })
  @JoinColumn({ name: 'medio_pago_id' })
  medio_pago?: MedioPago;

  /**
   * Movimiento de tesorería asociado al pago.
   * Permite trazabilidad entre cartera cobrada y el ingreso bancario.
   */
  @Column({ nullable: true })
  movimiento_tesoreria_id?: string;

  @ManyToOne(() => MovimientoTesoreria, { nullable: true, onDelete: 'SET NULL', eager: false })
  @JoinColumn({ name: 'movimiento_tesoreria_id' })
  movimiento_tesoreria?: MovimientoTesoreria;

  @Column({ type: 'text', nullable: true })
  notas?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}

/** @deprecated Usar PagoFactura */
export { PagoFactura as InvoicePayment };
