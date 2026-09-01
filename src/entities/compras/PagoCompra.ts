import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Company } from '../Company';
import { MedioPago } from '../catalogo/MedioPago';
import { MovimientoTesoreria } from '../tesoreria/MovimientoTesoreria';

/** abono = cuota inicial / anticipo; cuota = cuota periódica; pago_libre = pago sin plan */
export type TipoPagoCompra = 'abono' | 'cuota' | 'pago_libre';

/** A qué tipo de documento de compra pertenece este pago (referencia polimórfica). */
export type DocumentoCompraTipo = 'factura_compra' | 'documento_soporte';

/**
 * Pago o cuota de un documento de compra (Factura de Compra o Documento
 * Soporte). Tabla: pagos_compra.
 *
 * Referencia polimórfica (documento_tipo + documento_id) en vez de FK,
 * porque TypeORM no soporta una relación @ManyToOne hacia dos entidades
 * distintas — mismo patrón ya usado en AsientoContable.referencia_tipo/id.
 * Mirror exacto de PagoFactura (ventas) para mantener "la misma filosofía"
 * en Cartera CxP. FBK-031.
 */
@Entity('pagos_compra')
@Index(['documento_tipo', 'documento_id'])
@Index(['company_id', 'fecha_pago'])
@Index(['company_id', 'esta_pagado'])
export class PagoCompra {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Company, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company?: Company;

  @Column({ nullable: true })
  company_id?: string;

  /** 'factura_compra' | 'documento_soporte' */
  @Column({ length: 30 })
  documento_tipo!: DocumentoCompraTipo;

  /** id de FacturaCompra o DocumentoSoporte, según documento_tipo */
  @Column()
  documento_id!: string;

  /** Tipo de movimiento */
  @Column({ length: 20, default: 'cuota' })
  tipo!: TipoPagoCompra;

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

  /** Medio de pago utilizado. FK a cat_medios_pago. */
  @Column({ nullable: true })
  medio_pago_id?: string;

  @ManyToOne(() => MedioPago, { nullable: true, onDelete: 'SET NULL', eager: false })
  @JoinColumn({ name: 'medio_pago_id' })
  medio_pago?: MedioPago;

  /** Movimiento de tesorería asociado al pago (egreso). */
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
