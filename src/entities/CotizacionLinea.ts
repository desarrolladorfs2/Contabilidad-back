/**
 * Línea de una cotización.
 * El producto_id es nullable para permitir líneas libres (sin producto del catálogo).
 * Los catálogos se referencian via natural key:
 *   - unidad_medida_codigo → cat_unidades_medida.codigo
 *   - tipo_tributo_codigo  → cat_tipos_tributo.codigo
 *
 * Tabla: cotizacion_lineas
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';
import { Cotizacion } from './Cotizacion';
import { Producto } from './Producto';

@Entity('cotizacion_lineas')
export class CotizacionLinea {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  cotizacion_id!: string;

  @ManyToOne(() => Cotizacion, (c) => c.lineas, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cotizacion_id' })
  cotizacion!: Cotizacion;

  /** Orden de la línea dentro de la cotización (1, 2, 3…) */
  @Column({ default: 1 })
  linea_numero!: number;

  /** Nullable: líneas libres no necesitan producto del catálogo */
  @Column({ nullable: true })
  producto_id?: string;

  @ManyToOne(() => Producto, { nullable: true, eager: false })
  @JoinColumn({ name: 'producto_id' })
  producto?: Producto;

  @Column({ length: 500 })
  descripcion!: string;

  @Column({ type: 'text', nullable: true })
  detalle?: string;

  @Column({ type: 'decimal', precision: 18, scale: 4 })
  cantidad!: number;

  /**
   * Código UN/CEFACT — natural key → cat_unidades_medida.codigo
   * Default 'EA' (unidad)
   */
  @Column({ length: 10, default: 'EA' })
  unidad_medida_codigo!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4 })
  precio_unitario!: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  descuento_pct!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  descuento_valor!: number;

  /** cantidad × precio_unitario − descuento_valor */
  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  subtotal!: number;

  /**
   * Natural key → cat_tipos_tributo.codigo
   * '01'=IVA | '04'=INC | 'ZZ'=No aplica
   */
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

  /** subtotal + valor_iva + valor_inc */
  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  total!: number;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
