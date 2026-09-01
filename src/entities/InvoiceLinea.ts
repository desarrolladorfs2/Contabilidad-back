/**
 * Lineas normalizadas de una factura.
 *
 * Estrategia de doble escritura:
 * Factura.lineas (simple-json) se mantiene para el XML DIAN y no se toca.
 * Esta tabla existe en PARALELO para analytics, reportes por producto,
 * y futura migración del generador DIAN.
 *
 * Tabla: factura_lineas
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Factura } from './Invoice';
import { Producto } from './Producto';
import { CotizacionLinea } from './CotizacionLinea';
import { CentroCosto } from './contabilidad/CentroCosto';
import { Sede } from './contabilidad/Sede';

@Entity('factura_lineas')
@Index(['factura_id'])
@Index(['producto_id'])
export class FacturaLinea {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  factura_id!: string;

  @ManyToOne(() => Factura, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'factura_id' })
  factura!: Factura;

  /** Nullable: facturas existentes y líneas libres no tienen producto del catálogo */
  @Column({ nullable: true })
  producto_id?: string;

  @ManyToOne(() => Producto, { nullable: true, eager: false })
  @JoinColumn({ name: 'producto_id' })
  producto?: Producto;

  @Column({ default: 1 })
  linea_numero!: number;

  @Column({ length: 500 })
  descripcion!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4 })
  cantidad!: number;

  /** Natural key -> cat_unidades_medida.codigo (UN/CEFACT) */
  @Column({ length: 10, default: 'EA' })
  unidad_medida_codigo!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4 })
  precio_unitario!: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  descuento_pct!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  descuento_valor!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  subtotal!: number;

  /** Natural key -> cat_tipos_tributo.codigo (DIAN) */
  @Column({ length: 5, default: 'ZZ' })
  tipo_tributo_codigo!: string;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  tarifa_iva!: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  tarifa_inc!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  valor_iva!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  valor_inc!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  total!: number;

  /** Código UNSPSC tal como fue enviado a la DIAN en esta línea */
  @Column({ length: 20, nullable: true })
  codigo_unspsc?: string;

  /** Cuenta PUC asignada a esta línea (anula la cuenta_venta del producto si se especifica). */
  @Column({ length: 20, nullable: true })
  cuenta_puc_codigo?: string;

  /** Nombre descriptivo de la cuenta PUC (snapshot para reportes). */
  @Column({ length: 200, nullable: true })
  cuenta_puc_nombre?: string;

  /** Cotización de origen si la factura viene de una cotización */
  @Column({ nullable: true })
  cotizacion_linea_id?: string;

  @ManyToOne(() => CotizacionLinea, { nullable: true, eager: false, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'cotizacion_linea_id' })
  cotizacion_linea?: CotizacionLinea;

  /**
   * Centro de costo/sede propios de esta línea — NULL significa que la línea
   * hereda el centro de costo/sede de la cabecera de la factura (comportamiento
   * por defecto). Solo se guarda un valor aquí cuando el usuario desmarca la
   * herencia y elige uno distinto para esta línea puntual.
   */
  @Column({ nullable: true })
  centro_costo_id?: string;

  @ManyToOne(() => CentroCosto, { nullable: true, eager: false, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'centro_costo_id' })
  centro_costo?: CentroCosto;

  @Column({ nullable: true })
  sede_id?: string;

  @ManyToOne(() => Sede, { nullable: true, eager: false, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'sede_id' })
  sede?: Sede;

  @CreateDateColumn()
  created_at!: Date;
}

/** @deprecated Usar FacturaLinea */
export { FacturaLinea as InvoiceLinea };
