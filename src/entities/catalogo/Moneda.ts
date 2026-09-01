/**
 * Catálogo de monedas — ISO 4217.
 * Usados en: ListaPrecio.moneda_codigo, Cotizacion.moneda_codigo, Invoice.currency
 * Tabla: cat_monedas
 */
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('cat_monedas')
export class Moneda {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Código ISO 4217: COP, USD, EUR, etc. */
  @Column({ length: 3, unique: true })
  codigo_iso!: string;

  @Column({ length: 100 })
  nombre!: string;

  /** Símbolo: $, €, £ */
  @Column({ length: 10, nullable: true })
  simbolo?: string;

  /** Solo una moneda puede ser la predeterminada (COP para Colombia) */
  @Column({ default: false })
  es_defecto!: boolean;

  @Column({ default: true })
  activo!: boolean;

  @CreateDateColumn()
  created_at!: Date;
}
