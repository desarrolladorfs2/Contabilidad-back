import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Company } from '../Company';
import { Tercero } from '../Tercero';
import { CentroCosto } from '../contabilidad/CentroCosto';
import { Sede } from '../contabilidad/Sede';

/**
 * Estado del documento recibido, derivado de los eventos RADIAN ya enviados
 * (o registrados manualmente). Se recalcula en cada endpoint de evento —
 * columna denormalizada solo para acelerar el listado/filtro (igual patrón
 * que `estado` en DocumentoSoporte).
 */
export type EstadoDocumentoRecibido =
  | 'pendiente'
  | 'acuse_enviado'
  | 'bien_recibido'
  | 'reclamado'
  | 'aceptado_expreso'
  | 'aceptado_tacito';

/** Código de evento RADIAN (Res. 000085/2022) */
export type CodigoEventoRadian = '030' | '031' | '032' | '033' | '034';

/**
 * Documentos Recibidos — facturas electrónicas de venta emitidas por
 * proveedores hacia esta empresa (receptor), con soporte para los eventos
 * RADIAN del comprador: Acuse de recibo (030), Reclamo (031),
 * Recibo del bien/servicio (032), Aceptación expresa (033), además del
 * registro manual de Aceptación tácita (arts. 773-774 Código de Comercio).
 *
 * Se puede crear importando el XML UBL de la factura del proveedor
 * (from_xml = true, se auto-completan proveedor/CUFE/líneas) o de forma
 * 100% manual (from_xml = false) — igual filosofía que Facturas Recibidas
 * (facturas_compra), pero con el soporte adicional de eventos DIAN que
 * ese módulo no tiene.
 *
 * Tabla: documentos_recibidos
 */
@Entity('documentos_recibidos')
@Index(['company_id', 'invoice_date'])
@Index(['company_id', 'estado'])
@Index(['proveedor_tercero_id'])
export class DocumentoRecibido {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column()
  company_id!: string;

  // ── Datos de la factura original del proveedor ────────────────────────

  @Column({ length: 20, nullable: true })
  invoice_prefix?: string;

  @Column({ length: 100, nullable: true })
  invoice_number_str?: string;

  @Column({ type: 'date', nullable: true })
  invoice_date?: string;

  /** CUFE de la factura del proveedor — requerido para construir eventos RADIAN */
  @Column({ type: 'text', nullable: true })
  cufe?: string;

  // ── Proveedor (emisor de la factura recibida) ─────────────────────────

  /** FK opcional: si el proveedor está registrado como tercero en el sistema */
  @Column({ nullable: true })
  proveedor_tercero_id?: string;

  @ManyToOne(() => Tercero, { nullable: true, onDelete: 'SET NULL', eager: false })
  @JoinColumn({ name: 'proveedor_tercero_id' })
  proveedor_tercero?: Tercero;

  @Column({ length: 30, nullable: true })
  provider_nit?: string;

  @Column({ length: 30, nullable: true })
  provider_id_type?: string;

  @Column({ length: 200, nullable: true })
  provider_name?: string;

  @Column({ length: 300, nullable: true })
  provider_address?: string;

  @Column({ length: 100, nullable: true })
  provider_city_name?: string;

  @Column({ length: 50, nullable: true })
  provider_city_code?: string;

  @Column({ length: 100, nullable: true })
  provider_email?: string;

  @Column({ length: 30, nullable: true })
  provider_phone?: string;

  @Column({ length: 50, nullable: true })
  provider_tax_level?: string;

  // ── Líneas ──────────────────────────────────────────────────────────────

  /** Líneas de detalle en JSON. Excluidas de queries de lista. */
  @Column({ type: 'text', nullable: true, select: false })
  lines_json?: string;

  // ── Totales ───────────────────────────────────────────────────────────

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  subtotal!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  discount_total!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  iva_total!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  inc_total!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  total!: number;

  @Column({ length: 3, default: 'COP' })
  currency!: string;

  // ── Condiciones de pago ──────────────────────────────────────────────

  @Column({ length: 5, nullable: true })
  payment_means_id?: string;

  @Column({ length: 5, nullable: true })
  payment_method_id?: string;

  @Column({ type: 'date', nullable: true })
  due_date?: string;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  /** true si se creó importando el XML UBL de la factura del proveedor */
  @Column({ default: false })
  from_xml!: boolean;

  /** XML original de la factura del proveedor (importado). Excluido de listas. */
  @Column({ type: 'text', nullable: true, select: false })
  xml_base64?: string;

  /** PDF de registro interno (no el original del proveedor). Excluido de listas. */
  @Column({ type: 'text', nullable: true, select: false })
  pdf_base64?: string;

  // ── Estado derivado (para listado/filtro) ────────────────────────────

  @Column({ default: 'pendiente' })
  estado!: EstadoDocumentoRecibido;

  // ── Evento 030 · Acuse de recibo ──────────────────────────────────────

  @Column({ type: 'datetime', nullable: true })
  acuse_recibo_en?: Date;

  @Column({ length: 60, nullable: true })
  acuse_recibo_evento_id?: string;

  @Column({ length: 10, nullable: true })
  acuse_recibo_status_code?: string;

  @Column({ type: 'text', nullable: true, select: false })
  acuse_recibo_response?: string;

  /** XML del evento (firmado si la firma fue exitosa, si no el sin firmar) */
  @Column({ type: 'text', nullable: true, select: false })
  acuse_recibo_xml_base64?: string;

  // ── Evento 032 · Recibo del bien/servicio ─────────────────────────────

  @Column({ type: 'datetime', nullable: true })
  recibo_bien_en?: Date;

  @Column({ length: 60, nullable: true })
  recibo_bien_evento_id?: string;

  @Column({ length: 10, nullable: true })
  recibo_bien_status_code?: string;

  @Column({ type: 'text', nullable: true, select: false })
  recibo_bien_response?: string;

  @Column({ type: 'text', nullable: true, select: false })
  recibo_bien_xml_base64?: string;

  // ── Evento 031 · Reclamo ──────────────────────────────────────────────

  @Column({ type: 'datetime', nullable: true })
  reclamo_en?: Date;

  @Column({ length: 60, nullable: true })
  reclamo_evento_id?: string;

  @Column({ length: 10, nullable: true })
  reclamo_status_code?: string;

  @Column({ type: 'text', nullable: true, select: false })
  reclamo_response?: string;

  @Column({ type: 'text', nullable: true, select: false })
  reclamo_xml_base64?: string;

  @Column({ type: 'text', nullable: true })
  reclamo_motivo?: string;

  /**
   * Categoría del reclamo según codelist DIAN `FaltadeAceptacion.gc`
   * ('01' = Falta de aceptación parcial, '02' = Falta de aceptación total).
   * Va como atributos @listID/@name de cbc:ResponseCode en el XML del evento 031.
   */
  @Column({ length: 2, nullable: true })
  reclamo_categoria?: string;

  // ── Evento 033 · Aceptación expresa ───────────────────────────────────

  @Column({ type: 'datetime', nullable: true })
  aceptacion_expresa_en?: Date;

  @Column({ length: 60, nullable: true })
  aceptacion_expresa_evento_id?: string;

  @Column({ length: 10, nullable: true })
  aceptacion_expresa_status_code?: string;

  @Column({ type: 'text', nullable: true, select: false })
  aceptacion_expresa_response?: string;

  @Column({ type: 'text', nullable: true, select: false })
  aceptacion_expresa_xml_base64?: string;

  // ── Evento 034 · Aceptación tácita (art. 773-774 Código de Comercio) ──
  // Es un evento RADIAN real y transmisible (ApplicationResponse con
  // cac:ReceiverParty = DIAN, NIT 800197268), no un simple registro manual:
  // requiere 030+032 previos, es excluyente con 031/033, e incluye la nota
  // jurada obligatoria de que transcurrieron 3 días hábiles sin reclamo ni
  // aceptación expresa.

  @Column({ type: 'datetime', nullable: true })
  aceptacion_tacita_en?: Date;

  @Column({ length: 60, nullable: true })
  aceptacion_tacita_evento_id?: string;

  @Column({ length: 10, nullable: true })
  aceptacion_tacita_status_code?: string;

  @Column({ type: 'text', nullable: true, select: false })
  aceptacion_tacita_response?: string;

  @Column({ type: 'text', nullable: true, select: false })
  aceptacion_tacita_xml_base64?: string;

  /** Centro de costo y sede a los que se carga este documento recibido (obligatorios desde esta version). */
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

  /**
   * Ciudad del documento (distinta de provider_city_*, que es la ciudad del
   * proveedor) — mismo concepto de "ciudad de facturación" que ya existe en
   * Factura, asociada al centro de costo/sede de este documento.
   */
  @Column({ length: 20, nullable: true })
  ciudad_codigo?: string;

  @Column({ length: 200, nullable: true })
  ciudad_nombre?: string;

  // ── Auditoría ─────────────────────────────────────────────────────────

  @Column({ nullable: true })
  creado_por_usuario_id?: string;

  @Column({ length: 120, nullable: true })
  creado_por_nombre?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
