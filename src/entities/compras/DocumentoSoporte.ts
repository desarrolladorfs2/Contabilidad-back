import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index, OneToMany,
} from 'typeorm';
import { Company }  from '../Company';
import { Tercero }  from '../Tercero';
import { CentroCosto } from '../contabilidad/CentroCosto';
import { Sede } from '../contabilidad/Sede';

// Evitar importación circular: NotaAjusteDS importa DocumentoSoporte,
// por lo que usamos la referencia diferida en el decorador OneToMany.
// El tipo de retorno se declara como cualquier para evitar el ciclo en tiempo de compilación.

export type EstadoDocumentoSoporte =
  | 'borrador'
  | 'enviando'
  | 'aprobado_dian'
  | 'aceptado'
  | 'rechazado'
  | 'anulado';

/**
 * Tipo de Documento Soporte según el CustomizationID DIAN:
 *   DS01 → Adquisición de bienes
 *   DS02 → Adquisición de servicios
 *   DS03 → Adquisición de bienes y servicios
 *   DS04 → Cambio o permuta
 */
export type TipoDS = 'DS01' | 'DS02' | 'DS03' | 'DS04';

/**
 * Documento Soporte en adquisiciones efectuadas a no obligados a facturar.
 *
 * Resolución DIAN 0167/2021 · Art. 771-2 ET
 * DocumentTypeCode: 91
 * Roles en XML: AccountingSupplierParty = nuestra empresa (la obligada)
 *               AccountingCustomerParty = el proveedor no obligado
 *
 * Tabla: documentos_soporte
 */
@Entity('documentos_soporte')
@Index(['company_id', 'fecha_emision'])
@Index(['company_id', 'estado'])
@Index(['proveedor_tercero_id'])
export class DocumentoSoporte {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column()
  company_id!: string;

  // ── Numeración ────────────────────────────────────────────────────────

  @Column({ length: 20, default: 'DS' })
  prefijo!: string;

  @Column()
  numero!: number;

  /** Número completo formateado: prefijo + numero. Ej: "DS-000001" */
  @Column({ length: 60 })
  numero_ds!: string;

  // ── Fechas ────────────────────────────────────────────────────────────

  @Column({ type: 'date' })
  fecha_emision!: string;

  @Column({ type: 'date', nullable: true })
  fecha_vencimiento?: string;

  // ── Tipo DS ───────────────────────────────────────────────────────────

  /**
   * DS01=bienes, DS02=servicios, DS03=bienes y servicios, DS04=cambio/permuta
   * Determina el CustomizationID enviado a la DIAN.
   */
  @Column({ length: 10, default: 'DS03' })
  tipo_ds!: TipoDS;

  // ── Proveedor (persona no obligada a facturar) ────────────────────────

  /** FK opcional: si el proveedor está registrado como tercero en el sistema */
  @Column({ nullable: true })
  proveedor_tercero_id?: string;

  @ManyToOne(() => Tercero, { nullable: true, onDelete: 'SET NULL', eager: false })
  @JoinColumn({ name: 'proveedor_tercero_id' })
  proveedor_tercero?: Tercero;

  /** Natural key → cat_tipos_documento (CC, CE, PP, TI, etc.) */
  @Column({ length: 10, default: 'CC' })
  proveedor_tipo_id!: string;

  @Column({ length: 20 })
  proveedor_nit!: string;

  @Column({ length: 200 })
  proveedor_nombre!: string;

  /** Primer nombre (personas naturales) — para tag cac:Person en XML */
  @Column({ length: 100, nullable: true })
  proveedor_primer_nombre?: string;

  @Column({ length: 100, nullable: true })
  proveedor_segundo_nombre?: string;

  @Column({ length: 100, nullable: true })
  proveedor_primer_apellido?: string;

  @Column({ length: 100, nullable: true })
  proveedor_segundo_apellido?: string;

  @Column({ length: 300, nullable: true })
  proveedor_direccion?: string;

  /** Código DANE del municipio del proveedor */
  @Column({ length: 10, nullable: true })
  proveedor_ciudad_codigo?: string;

  @Column({ length: 150, nullable: true })
  proveedor_ciudad_nombre?: string;

  /** Centro de costo y sede a los que se carga este Documento Soporte (obligatorios desde esta version). */
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
   * Ciudad del documento (distinta de la ciudad del proveedor arriba) —
   * mismo concepto de "ciudad de facturación" que ya existe en Factura,
   * asociada al centro de costo/sede de este Documento Soporte.
   */
  @Column({ length: 20, nullable: true })
  ciudad_codigo?: string;

  @Column({ length: 200, nullable: true })
  ciudad_nombre?: string;

  // ── Forma / medio de pago (FBK-011 / FBK-014) ──────────────────────────
  /** '1' = Contado, '2' = Crédito (mismo catálogo que Factura/FacturaCompra) */
  @Column({ length: 5, nullable: true })
  payment_means_id?: string;

  /** Natural key → cat_medios_pago (efectivo, transferencia, cheque, etc.) */
  @Column({ length: 5, nullable: true })
  payment_method_id?: string;

  /** Cuenta de tesorería a acreditar cuando payment_means_id = '1' (contado). */
  @Column({ nullable: true })
  cuenta_tesoreria_id?: string;

  // Seguimiento de pago (FBK-031 / Cartera CxP) — mismo esquema que
  // FacturaCompra/Factura; cuotas/abonos detallados en pagos_compra.
  /** contado | credito | cuotas */
  @Column({ length: 20, default: 'contado' })
  condicion_pago!: string;

  @Column({ nullable: true })
  numero_cuotas?: number;

  /** pendiente | parcial | pagada */
  @Column({ length: 20, default: 'pendiente', nullable: true })
  estado_pago?: string;

  /** Suma de PagoCompra.valor_pagado donde esta_pagado = true, para este documento */
  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0, nullable: true })
  total_pagado?: number;

  @Column({ length: 10, nullable: true })
  proveedor_departamento_codigo?: string;

  @Column({ length: 150, nullable: true })
  proveedor_departamento_nombre?: string;

  @Column({ length: 150, nullable: true })
  proveedor_email?: string;

  @Column({ length: 30, nullable: true })
  proveedor_telefono?: string;

  // ── Líneas ────────────────────────────────────────────────────────────

  /** Líneas de detalle en formato JSON para el XML DIAN. Excluidas de queries de lista. */
  @Column({ type: 'simple-json', nullable: true, select: false })
  lineas?: Record<string, unknown>[];

  // ── Totales ───────────────────────────────────────────────────────────

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  subtotal!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  iva_total!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  total!: number;

  /** Natural key → cat_monedas.codigo_iso (ISO 4217) */
  @Column({ length: 10, default: 'COP' })
  moneda!: string;

  // ── DIAN ──────────────────────────────────────────────────────────────

  /**
   * CUDS: Código Único del Documento Soporte.
   * SHA3-256 del concatenado definido en la Res. 0167/2021.
   */
  @Column({ type: 'text', nullable: true })
  cuds?: string;

  @Column({ default: 'borrador' })
  estado!: EstadoDocumentoSoporte;

  /** Código de respuesta DIAN. '00' = aprobado. */
  @Column({ length: 10, nullable: true })
  dian_status_code?: string;

  @Column({ type: 'text', nullable: true })
  dian_status_description?: string;

  /** Respuesta cruda de la DIAN. Excluida de SELECTs por defecto. */
  @Column({ type: 'text', nullable: true, select: false })
  dian_response?: string;

  // ── Documentos generados ──────────────────────────────────────────────

  /** XML sin firmar en base64. Excluido de queries de reportes. */
  @Column({ type: 'text', nullable: true, select: false })
  xml_base64?: string;

  /** XML firmado XAdES-BES en base64. Excluido de queries de reportes. */
  @Column({ type: 'text', nullable: true, select: false })
  signed_xml_base64?: string;

  /** PDF "Documento soporte en adquisiciones..." en base64. */
  @Column({ type: 'text', nullable: true, select: false })
  pdf_base64?: string;

  /** ZIP (XML firmado + PDF) en base64. Excluido de queries de reportes. */
  @Column({ type: 'text', nullable: true, select: false })
  zip_base64?: string;

  @Column({ length: 200, nullable: true })
  archivo_firmado?: string;

  // ── Aceptación del no obligado ─────────────────────────────────────────

  /**
   * Fecha en que se registró la aceptación del no obligado.
   * null = aceptación pendiente.
   * Diseñado para migrarse a tarea programada en el futuro.
   */
  @Column({ type: 'date', nullable: true })
  aceptado_en?: string;

  // ── Notas ─────────────────────────────────────────────────────────────

  @Column({ type: 'text', nullable: true })
  notas?: string;

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
