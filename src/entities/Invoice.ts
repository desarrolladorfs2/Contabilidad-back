import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, ManyToOne, JoinColumn, OneToMany, Index,
} from 'typeorm';
import { Company } from './Company';
import { Tercero } from './Tercero';
import { CreditNote } from './CreditNote';
import { DebitNote } from './DebitNote';
import { CentroCosto } from './contabilidad/CentroCosto';
import { Sede } from './contabilidad/Sede';

/**
 * Estados posibles de una factura electrónica.
 */
export type EstadoFactura =
  | 'borrador'
  | 'firmada'
  | 'enviada'
  | 'aprobada'
  | 'rechazada';

/** @deprecated Usar EstadoFactura */
export type InvoiceStatus = EstadoFactura;

/** Clase principal de Factura electrónica de venta. Tabla: facturas */
@Entity('facturas')
@Index(['company_id', 'fecha_emision'])
@Index(['company_id', 'estado'])
@Index(['company_id', 'estado_pago'])
@Index(['company_id', 'medio_pago'])
@Index(['cliente_tercero_id'])
export class Factura {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Company, (c) => c.facturas, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column()
  company_id!: string;

  @Column({ length: 20, nullable: true })
  prefijo?: string;

  @Column({ nullable: true })
  numero?: number;

  @Column({ length: 50 })
  numero_factura!: string;

  @Column({ type: 'date' })
  fecha_emision!: string;

  @Column({ type: 'text', nullable: true })
  descripcion?: string;

  /** Notas / observaciones de la factura (campo UBL Note). */
  @Column({ type: 'text', nullable: true })
  notas?: string;

  @Column({ length: 50, nullable: true })
  hora_emision?: string;

  @Column({ default: 'borrador' })
  estado!: EstadoFactura;

  @Column({ type: 'text', nullable: true })
  cufe?: string;

  @Column({ length: 10, nullable: true })
  dian_status_code?: string;

  @Column({ type: 'text', nullable: true })
  dian_status_description?: string;

  /** Respuesta cruda de la DIAN. Excluida de SELECTs por defecto (puede ser grande). */
  @Column({ type: 'text', nullable: true, select: false })
  dian_response?: string;

  /**
   * FK al tercero (cliente). Nullable para facturas históricas y de salud.
   * Los campos cliente_* son el snapshot inmutable requerido por el XML DIAN.
   */
  @Column({ nullable: true })
  cliente_tercero_id?: string;

  @ManyToOne(() => Tercero, { nullable: true, eager: false, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'cliente_tercero_id' })
  cliente_tercero?: Tercero;

  // Snapshot DIAN del cliente (inmutable tras firma)
  @Column({ length: 30, nullable: true })
  cliente_nit?: string;

  @Column({ length: 30, nullable: true })
  cliente_tipo_id?: string;

  @Column({ length: 200, nullable: true })
  cliente_nombre?: string;

  @Column({ length: 100, nullable: true })
  cliente_correo?: string;

  @Column({ length: 30, nullable: true })
  cliente_telefono?: string;

  @Column({ length: 50, nullable: true })
  cliente_ciudad_codigo?: string;

  @Column({ length: 100, nullable: true })
  cliente_ciudad_nombre?: string;

  @Column({ length: 10, nullable: true })
  cliente_departamento_codigo?: string;

  @Column({ length: 100, nullable: true })
  cliente_departamento_nombre?: string;

  @Column({ length: 300, nullable: true })
  cliente_direccion?: string;

  /** Natural key -> cat_responsabilidades_fiscales.codigo */
  @Column({ length: 20, default: 'R-99-PN' })
  cliente_nivel_tributario!: string;

  // Totales
  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  subtotal!: number;

  /**
   * Hallazgo critico #2 (auditoria 2026-08-31): antes no existia ninguna
   * columna donde guardar el descuento total de la factura, asi que se
   * perdia. subtotal ahora se guarda NETO (ya restado este descuento).
   */
  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  descuento_total!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  total_impuestos!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  iva_total!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  inc_total!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  total!: number;

  // Retención en la fuente (informativa — no va al XML DIAN)
  @Column({ default: false })
  tiene_retencion!: boolean;

  @Column({ type: 'decimal', precision: 6, scale: 2, default: 0 })
  tarifa_retencion!: number;

  /** Monto retenido = (subtotal neto de descuentos) × tarifa_retencion / 100 */
  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  valor_retencion!: number;

  @Column({ length: 200, nullable: true })
  concepto_retencion?: string;

  /** Natural key -> cat_monedas.codigo_iso (ISO 4217) */
  @Column({ length: 10, default: 'COP' })
  moneda!: string;

  // Payload DIAN (excluidos de SELECTs por defecto - pueden pesar decenas de KB)

  /** Payload enviado al firmador DIAN. Redundante con FacturaLinea para analytics. */
  @Column({ type: 'simple-json', nullable: true, select: false })
  generation_payload?: Record<string, unknown>;

  /** Lineas en formato JSON para el XML DIAN. Usar FacturaLinea para analytics. */
  @Column({ type: 'simple-json', nullable: true, select: false })
  lineas?: Record<string, unknown>[];

  /** XML firmado en base64. Excluido de queries de reportes. */
  @Column({ type: 'text', nullable: true, select: false })
  xml_base64?: string;

  /** PDF en base64. Excluido de queries de reportes. */
  @Column({ type: 'text', nullable: true, select: false })
  pdf_base64?: string;

  /** ZIP (XML + PDF) en base64. Excluido de queries de reportes. */
  @Column({ type: 'text', nullable: true, select: false })
  zip_base64?: string;

  @Column({ length: 200, nullable: true })
  archivo_firmado?: string;

  @Column({ default: false })
  es_salud!: boolean;

  /** RIPS en base64. Excluido de queries de reportes. */
  @Column({ type: 'text', nullable: true, select: false })
  rips_json_base64?: string;

  @Column({ length: 200, nullable: true })
  rips_filename?: string;

  // Condiciones de pago

  /** contado | credito | cuotas */
  @Column({ length: 20, default: 'contado' })
  condicion_pago!: string;

  /** Natural key -> cat_medios_pago.codigo. Ej: '10'=efectivo, '47'=transferencia */
  @Column({ length: 50, nullable: true })
  medio_pago?: string;

  @Column({ type: 'date', nullable: true })
  fecha_vencimiento?: string;

  @Column({ nullable: true })
  numero_cuotas?: number;

  /** pendiente | parcial | pagada */
  @Column({ length: 20, default: 'pendiente', nullable: true })
  estado_pago?: string;

  /** Suma de PagoFactura.valor_pagado donde esta_pagado = true */
  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0, nullable: true })
  total_pagado?: number;

  /**
   * Ciudad a la que se carga la factura para efectos de centros de costo e informes.
   * Código DANE del municipio (ej: '11001' = Bogotá).
   */
  @Column({ length: 20, nullable: true })
  ciudad_codigo?: string;

  /** Nombre de ciudad desnormalizado para reportes sin join al catálogo. */
  @Column({ length: 200, nullable: true })
  ciudad_nombre?: string;

  /**
   * Centro de costo y sede de la factura (obligatorios a nivel de aplicación desde esta version).
   * La ciudad NO se guarda aparte: se deriva de `sede.municipio` (igual que en CentroCosto).
   * Nullable a nivel de columna para no romper registros historicos creados antes de este cambio.
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

  /** Usuario que creó el registro. Desnormalizado: sobrevive borrado/renombrado de usuario. */
  @Column({ nullable: true })
  created_by_user_id?: string;

  @Column({ length: 120, nullable: true })
  created_by_name?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  // Relaciones
  @OneToMany(() => CreditNote, (cn) => cn.factura)
  notas_credito?: CreditNote[];

  @OneToMany(() => DebitNote, (dn) => dn.factura)
  notas_debito?: DebitNote[];
}

/** @deprecated Usar Factura */
export { Factura as Invoice };
