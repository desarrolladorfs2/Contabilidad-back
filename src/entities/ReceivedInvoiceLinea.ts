import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Company } from './Company';
import { ReceivedInvoice } from './ReceivedInvoice';
import { UnidadMedida } from './catalogo/UnidadMedida';
import { TipoTributo } from './catalogo/TipoTributo';

/**
 * Lineas normalizadas de una factura recibida (proveedor).
 *
 * Normaliza el campo `lines` (simple-json) de ReceivedInvoice en una
 * tabla propia, permitiendo:
 *   - Reportes de compras por producto/servicio
 *   - Calculo automatico de retenciones por linea
 *   - Analisis de IVA soportado por categoria de gasto
 *
 * Tabla: received_invoice_lineas
 */
@Entity('received_invoice_lineas')
@Index(['received_invoice_id'])                // join basico
@Index(['company_id', 'tipo_tributo_codigo'])  // analisis de IVA soportado
export class ReceivedInvoiceLinea {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column()
  received_invoice_id!: string;

  @ManyToOne(() => ReceivedInvoice, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'received_invoice_id' })
  received_invoice!: ReceivedInvoice;

  @Column({ default: 1 })
  linea_numero!: number;

  @Column({ length: 500 })
  descripcion!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4 })
  cantidad!: number;

  /**
   * Natural key -> cat_unidades_medida.codigo (UN/CEFACT).
   * Ej: 'EA' = unidad, 'KGM' = kilogramo, 'HUR' = hora.
   */
  @Column({ length: 10, default: 'EA', nullable: true })
  unidad_medida_codigo!: string;

  @ManyToOne(() => UnidadMedida, { nullable: true, onDelete: 'SET NULL', eager: false })
  @JoinColumn({ name: 'unidad_medida_codigo', referencedColumnName: 'codigo' })
  unidad_medida?: UnidadMedida;

  @Column({ type: 'decimal', precision: 18, scale: 4 })
  precio_unitario!: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  descuento_pct!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  descuento_valor!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  subtotal!: number;

  /**
   * Natural key -> cat_tipos_tributo.codigo (DIAN).
   * Ej: '01' = IVA, '04' = INC, 'ZZ' = no aplica.
   */
  @Column({ length: 5, default: 'ZZ', nullable: true })
  tipo_tributo_codigo!: string;

  @ManyToOne(() => TipoTributo, { nullable: true, onDelete: 'SET NULL', eager: false })
  @JoinColumn({ name: 'tipo_tributo_codigo', referencedColumnName: 'codigo' })
  tipo_tributo?: TipoTributo;

  /** Tarifa de IVA aplicada en esta linea (ej: 19.00) */
  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  tarifa_iva!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  valor_iva!: number;

  /**
   * Retefuente calculada para esta linea.
   * Se completa al liquidar la factura, segun la tarifa configurada para el proveedor.
   */
  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  tarifa_retefuente!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  valor_retefuente!: number;

  /** ReteIVA calculada para esta linea */
  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  tarifa_reteiva!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  valor_reteiva!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  total!: number;

  /** Codigo UNSPSC del producto/servicio tal como aparece en la factura del proveedor */
  @Column({ length: 20, nullable: true })
  codigo_unspsc?: string;

  @CreateDateColumn()
  created_at!: Date;
}
