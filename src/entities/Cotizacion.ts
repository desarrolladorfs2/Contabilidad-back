/**
 * Cotizacion / Propuesta comercial.
 *
 * Flujo de estados:
 *   borrador -> enviada -> aprobada -> convertida (a factura)
 *                      -> rechazada
 *   (cualquier estado) -> vencida (si fecha_vencimiento < hoy y no esta convertida)
 *
 * Al convertirse a factura, convertida_a_factura_id se llena y estado = 'convertida'.
 * El numero se genera con la entidad Secuencia (cotizacion).
 *
 * Snapshot del cliente: los campos cliente_* se copian del tercero al crear la cotizacion.
 * Esto preserva el historial aunque el tercero cambie despues.
 *
 * Tabla: cotizaciones
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, OneToMany,
} from 'typeorm';
import { Company } from './Company';
import { Tercero } from './Tercero';
import { User } from './User';
import { ListaPrecio } from './ListaPrecio';
import { CotizacionLinea } from './CotizacionLinea';
import { Invoice } from './Invoice';

export type CotizacionEstado = 'borrador' | 'enviada' | 'aprobada' | 'rechazada' | 'vencida' | 'convertida';

@Entity('cotizaciones')
export class Cotizacion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  /** Numero legible generado por Secuencia. Ej: 'COT-2026-0001'. */
  @Column({ length: 30 })
  numero!: string;

  @Column({ length: 20, default: 'COT' })
  prefijo!: string;

  // Cliente
  @Column({ nullable: true })
  tercero_id?: string;

  @ManyToOne(() => Tercero, { eager: false, nullable: true })
  @JoinColumn({ name: 'tercero_id' })
  tercero?: Tercero;

  /** Snapshot: NIT del cliente al momento de crear */
  @Column({ length: 30, nullable: true })
  cliente_nit?: string;

  /** Snapshot: nombre del cliente al momento de crear */
  @Column({ length: 200, nullable: true })
  cliente_nombre?: string;

  /** Snapshot: email del cliente al momento de crear */
  @Column({ length: 200, nullable: true })
  cliente_email?: string;

  // Fechas
  @Column({ type: 'date' })
  fecha_emision!: string;

  @Column({ type: 'date', nullable: true })
  fecha_vencimiento?: string;

  // Estado
  @Column({ default: 'borrador' })
  estado!: CotizacionEstado;

  // Totales
  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  subtotal!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  descuento_total!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  iva_total!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  inc_total!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  impuestos_total!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  total!: number;

  /** Codigo ISO 4217 de la moneda. Natural key -> cat_monedas.codigo_iso */
  @Column({ length: 3, default: 'COP' })
  moneda_codigo!: string;

  /** Tasa de cambio respecto a COP al momento de emitir. 1 para COP. */
  @Column({ type: 'decimal', precision: 14, scale: 4, default: 1 })
  tasa_cambio!: number;

  // Referencias
  @Column({ nullable: true })
  lista_precio_id?: string;

  @ManyToOne(() => ListaPrecio, { nullable: true, eager: false })
  @JoinColumn({ name: 'lista_precio_id' })
  lista_precio?: ListaPrecio;

  @Column({ nullable: true })
  usuario_id?: string;

  @ManyToOne(() => User, { nullable: true, eager: false })
  @JoinColumn({ name: 'usuario_id' })
  usuario?: User;

  /** Nombre del usuario desnormalizado para display rápido. */
  @Column({ length: 120, nullable: true })
  usuario_nombre?: string;

  // Textos
  @Column({ type: 'text', nullable: true })
  terminos_condiciones?: string;

  @Column({ type: 'text', nullable: true })
  observaciones_cliente?: string;

  @Column({ type: 'text', nullable: true })
  notas_internas?: string;

  // Conversion a factura
  /** ID de la factura creada al aprobar esta cotizacion */
  @Column({ nullable: true })
  convertida_a_factura_id?: string;

  @ManyToOne(() => Invoice, { nullable: true, eager: false, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'convertida_a_factura_id' })
  convertida_a_factura?: Invoice;

  /** Cuando se convirtio */
  @Column({ type: 'datetime', nullable: true })
  converted_at?: Date;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  // Relaciones
  @OneToMany(() => CotizacionLinea, (l) => l.cotizacion, { cascade: true, eager: false })
  lineas?: CotizacionLinea[];
}
