/**
 * Catálogo de tipos de tributo — códigos DIAN Colombia.
 * Usados en: Producto.tipo_tributo_codigo, CotizacionLinea.tipo_tributo_codigo, InvoiceLinea
 * El código va en el XML DIAN (<cbc:ID> dentro de TaxScheme).
 * Tabla: cat_tipos_tributo
 */
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('cat_tipos_tributo')
export class TipoTributo {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Código DIAN:
   * '01' = IVA — Impuesto sobre las ventas
   * '04' = INC — Impuesto Nacional al Consumo
   * '03' = ICA — Impuesto de industria, comercio y avisos
   * 'ZZ' = No aplica / Exento
   */
  @Column({ length: 5, unique: true })
  codigo!: string;

  /** Nombre corto: 'IVA', 'INC', 'ICA', 'Exento' */
  @Column({ length: 50 })
  nombre!: string;

  @Column({ type: 'text', nullable: true })
  descripcion?: string;

  @Column({ default: true })
  aplica_ventas!: boolean;

  @Column({ default: true })
  activo!: boolean;

  @Column({ default: 0 })
  orden!: number;

  @CreateDateColumn()
  created_at!: Date;
}
