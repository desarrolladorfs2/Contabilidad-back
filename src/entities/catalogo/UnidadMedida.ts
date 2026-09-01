/**
 * Catálogo de unidades de medida — códigos UN/CEFACT.
 * Usados en: Producto.unidad_medida_codigo, CotizacionLinea.unidad_medida_codigo, InvoiceLinea
 * El código va literalmente en el XML DIAN (<cbc:unitCode>).
 * Tabla: cat_unidades_medida
 */
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('cat_unidades_medida')
export class UnidadMedida {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Código UN/CEFACT: EA, KGM, MTR, HUR, etc. Va en XML DIAN. */
  @Column({ length: 10, unique: true })
  codigo!: string;

  @Column({ length: 100 })
  nombre!: string;

  /** Símbolo abreviado: und, kg, m, h */
  @Column({ length: 20, nullable: true })
  simbolo?: string;

  @Column({ default: true })
  activo!: boolean;

  @Column({ default: 0 })
  orden!: number;

  @CreateDateColumn()
  created_at!: Date;
}
