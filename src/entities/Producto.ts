/**
 * Catálogo de productos y servicios por empresa.
 * Permite reutilizar items en cotizaciones y facturas con precios e impuestos
 * precargados. El código UNSPSC/DIAN se usa en el XML de factura electrónica.
 *
 * Relaciones de catálogo via natural key (no UUID FK) para:
 *   - unidad_medida_codigo → cat_unidades_medida.codigo (UN/CEFACT: EA, HUR, KGM…)
 *   - tipo_tributo_codigo  → cat_tipos_tributo.codigo   (DIAN: 01=IVA, 04=INC, ZZ=Exento)
 *
 * Tabla: productos
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, OneToMany, Unique,
} from 'typeorm';
import { Company } from './Company';

@Entity('productos')
@Unique(['company_id', 'codigo'])
export class Producto {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  /**
   * Código interno único por empresa. Ej: 'SERV-001', 'PROD-0023'.
   * El usuario lo define; sirve para búsqueda rápida en cotizaciones/facturas.
   */
  @Column({ length: 50 })
  codigo!: string;

  /** 'producto' | 'servicio' | 'otro' */
  @Column({ length: 20, default: 'servicio' })
  tipo!: string;

  @Column({ length: 300 })
  nombre!: string;

  @Column({ type: 'text', nullable: true })
  descripcion?: string;

  /**
   * Código UN/CEFACT de unidad de medida.
   * Natural key → cat_unidades_medida.codigo
   * Ej: 'EA' (unidad), 'HUR' (hora), 'KGM' (kilogramo)
   */
  @Column({ length: 10, default: 'EA' })
  unidad_medida_codigo!: string;

  /** Precio de venta base (sin impuestos). Se puede sobrescribir en lista de precios. */
  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  precio_base!: number;

  /**
   * Código DIAN del tipo de tributo.
   * Natural key → cat_tipos_tributo.codigo
   * '01'=IVA | '04'=INC | '03'=ICA | 'ZZ'=No aplica
   */
  @Column({ length: 5, default: 'ZZ' })
  tipo_tributo_codigo!: string;

  /** Tarifa de IVA aplicable: 0, 5 o 19 */
  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  tarifa_iva!: number;

  /** Tarifa de INC aplicable: 0 o 8 */
  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  tarifa_inc!: number;

  /**
   * Código de producto estándar UNSPSC (United Nations Standard Products and Services Code).
   * Requerido en XML DIAN para algunos tipos de factura.
   * Ej: '81111500' = IT consulting services
   */
  @Column({ length: 20, nullable: true })
  codigo_unspsc?: string;

  /**
   * Código de partida arancelaria (para productos importados/exportados).
   * Se usa como alternativa al UNSPSC en el XML DIAN.
   */
  @Column({ length: 20, nullable: true })
  codigo_partida_arancelaria?: string;

  /** Código de cuenta PUC para ingresos por ventas. Ej: '41009505' */
  @Column({ length: 20, nullable: true })
  cuenta_venta?: string;

  /** Código de cuenta PUC para costo de ventas. Ej: '61009505' */
  @Column({ length: 20, nullable: true })
  cuenta_costo?: string;

  @Column({ default: true })
  activo!: boolean;

  @Column({ type: 'text', nullable: true })
  notas?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
