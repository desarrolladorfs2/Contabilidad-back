import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Company }          from '../Company';
import { DocumentoSoporte } from './DocumentoSoporte';
import { Tercero }          from '../Tercero';
import { CentroCosto } from '../contabilidad/CentroCosto';
import { Sede } from '../contabilidad/Sede';

export type EstadoNotaAjusteDS =
  | 'borrador'
  | 'enviada'
  | 'aprobada'
  | 'rechazada'
  | 'anulada';

/**
 * Tipo de nota ajuste al Documento Soporte:
 *   NC_DS → Nota que reduce el valor del DS (DocumentTypeCode 92)
 *   ND_DS → Nota que incrementa el valor del DS (DocumentTypeCode 93)
 */
export type TipoNotaAjusteDS = 'NC_DS' | 'ND_DS';

/**
 * Nota de Ajuste al Documento Soporte.
 * Equivale a Nota Crédito/Débito del módulo comercial, pero referencia un DS.
 *
 * DocumentTypeCode: 92 (NC_DS) o 93 (ND_DS)
 * Tabla: notas_ajuste_ds
 */
@Entity('notas_ajuste_ds')
@Index(['company_id', 'fecha_emision'])
@Index(['company_id', 'estado'])
@Index(['documento_soporte_id'])
@Index(['proveedor_tercero_id'])
export class NotaAjusteDS {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column()
  company_id!: string;

  /** RESTRICT: no se puede anular un DS si tiene notas ajuste activas */
  @ManyToOne(() => DocumentoSoporte, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'documento_soporte_id' })
  documento_soporte!: DocumentoSoporte;

  @Column()
  documento_soporte_id!: string;

  /**
   * Desnormalización del proveedor para reportes directos sin join.
   * Se copia de DocumentoSoporte.proveedor_tercero_id al crear la nota.
   */
  @Column({ nullable: true })
  proveedor_tercero_id?: string;

  @ManyToOne(() => Tercero, { nullable: true, onDelete: 'SET NULL', eager: false })
  @JoinColumn({ name: 'proveedor_tercero_id' })
  proveedor_tercero?: Tercero;

  /**
   * Centro de costo y sede: se copian del Documento Soporte referenciado al
   * crear la nota (no se seleccionan manualmente), igual que en Notas Crédito/Débito de venta.
   */
  @Column({ nullable: true })
  centro_costo_id?: string;

  @ManyToOne(() => CentroCosto, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'centro_costo_id' })
  centro_costo?: CentroCosto;

  @Column({ nullable: true })
  sede_id?: string;

  @ManyToOne(() => Sede, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'sede_id' })
  sede?: Sede;

  /** Ciudad del documento — se copia del Documento Soporte referenciado al crear la nota. FBK-012 (remanente). */
  @Column({ length: 20, nullable: true })
  ciudad_codigo?: string;

  @Column({ length: 200, nullable: true })
  ciudad_nombre?: string;

  /** NC_DS: reduce el valor (DocTypeCode 92) | ND_DS: incrementa (DocTypeCode 93) */
  @Column({ length: 10, default: 'NC_DS' })
  tipo!: TipoNotaAjusteDS;

  @Column({ length: 20, default: 'NADS' })
  prefijo!: string;

  @Column()
  numero!: number;

  /** Número completo formateado: prefijo + numero. Ej: "NADS-000001" */
  @Column({ length: 60 })
  numero_nota_ajuste!: string;

  @Column({ type: 'date' })
  fecha_emision!: string;

  @Column({ type: 'text', nullable: true })
  descripcion?: string;

  /** Natural key → cat_codigos_discrepancia.codigo */
  @Column({ length: 5, nullable: true })
  codigo_discrepancia?: string;

  @Column({ type: 'text', nullable: true })
  descripcion_discrepancia?: string;

  @Column({ default: 'borrador' })
  estado!: EstadoNotaAjusteDS;

  @Column({ length: 10, nullable: true })
  dian_status_code?: string;

  @Column({ type: 'text', nullable: true })
  dian_status_description?: string;

  /** Respuesta cruda de la DIAN. Excluida de SELECTs por defecto. */
  @Column({ type: 'text', nullable: true, select: false })
  dian_response?: string;

  // ── Totales ───────────────────────────────────────────────────────────

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  subtotal!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  total_impuestos!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  total!: number;

  @Column({ length: 10, default: 'COP' })
  moneda!: string;

  /** Líneas de la nota en formato JSON. Excluidas de queries de lista. */
  @Column({ type: 'simple-json', nullable: true, select: false })
  lineas?: Record<string, unknown>[];

  /** CUDS de la nota ajuste */
  @Column({ type: 'text', nullable: true })
  cuds?: string;

  // ── Documentos generados ──────────────────────────────────────────────

  @Column({ type: 'text', nullable: true, select: false })
  xml_base64?: string;

  @Column({ type: 'text', nullable: true, select: false })
  signed_xml_base64?: string;

  @Column({ type: 'text', nullable: true, select: false })
  pdf_base64?: string;

  @Column({ type: 'text', nullable: true, select: false })
  zip_base64?: string;

  @Column({ length: 200, nullable: true })
  archivo_firmado?: string;

  // ── Auditoría ─────────────────────────────────────────────────────────

  /** Desnormalizado: sobrevive borrado/renombrado de usuario. */
  @Column({ nullable: true })
  creado_por_usuario_id?: string;

  @Column({ length: 120, nullable: true })
  creado_por_nombre?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
