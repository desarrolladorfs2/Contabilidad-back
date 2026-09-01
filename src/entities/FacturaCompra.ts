import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';
import { Company } from './Company';
import { CentroCosto } from './contabilidad/CentroCosto';
import { Sede } from './contabilidad/Sede';

@Entity('facturas_compra')
export class FacturaCompra {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column()
  company_id!: string;

  // Datos de la factura original del proveedor
  @Column({ length: 20, nullable: true })
  invoice_prefix?: string;

  @Column({ length: 100, nullable: true })
  invoice_number_str?: string;

  @Column({ type: 'date', nullable: true })
  invoice_date?: string;

  @Column({ type: 'text', nullable: true })
  cufe?: string;

  // Datos del proveedor (snapshot)
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

  /**
   * Ciudad del documento (propia de esta Factura de Compra, distinta de la
   * ciudad del proveedor arriba) — mismo concepto que ciudad_codigo/nombre
   * en Documento Soporte. Feedback piloto FBK-012 (remanente).
   */
  @Column({ length: 20, nullable: true })
  ciudad_codigo?: string;

  @Column({ length: 200, nullable: true })
  ciudad_nombre?: string;

  @Column({ length: 100, nullable: true })
  provider_email?: string;

  @Column({ length: 30, nullable: true })
  provider_phone?: string;

  @Column({ length: 50, nullable: true })
  provider_tax_level?: string;

  /** Centro de costo y sede a los que se carga esta factura de compra (obligatorios desde esta version). */
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

  // Líneas (JSON) — excluidas de queries de lista
  @Column({ type: 'text', nullable: true, select: false })
  lines_json?: string;

  // Totales
  // Hallazgo #9: antes 'real' (float, impreciso para dinero). Se cambia a
  // decimal(18,2) hacia adelante — los valores ya guardados NO se reescriben
  // ni se recalculan, solo cambia el tipo con el que se guardan los nuevos.
  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  subtotal!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  discount_total!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  iva_total!: number;

  /**
   * true cuando el IVA de esta factura recibida se ingresó como un único
   * valor total manual (checkbox "IVA total"), en vez de calcularse sumando
   * el % de impuesto de cada ítem. Aplica solo a facturas recibidas: cuando
   * el proveedor no discrimina el IVA por ítem, no hay forma de saber el %
   * de cada línea, así que se bloquea el impuesto por ítem y se registra
   * solo el total. Sirve para que el PDF y la edición futura sepan que este
   * documento está en modo "IVA total" y no recalculen desde las líneas.
   */
  @Column({ default: false })
  iva_total_manual!: boolean;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  inc_total!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  total!: number;

  // Retenciones (FBK-009): base, tarifa y valor de Retefuente y ReteICA.
  // Se descuentan del pago al proveedor pero NO del gasto/IVA deducible.
  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  retefuente_base!: number;

  @Column({ type: 'decimal', precision: 6, scale: 2, default: 0 })
  retefuente_tarifa!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  retefuente_valor!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  reteica_base!: number;

  @Column({ type: 'decimal', precision: 6, scale: 2, default: 0 })
  reteica_tarifa!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  reteica_valor!: number;

  // Condiciones de pago
  @Column({ length: 5, nullable: true })
  payment_means_id?: string;

  @Column({ length: 5, nullable: true })
  payment_method_id?: string;

  /**
   * Cuenta de tesorería (caja/banco) a acreditar cuando payment_means_id = '1'
   * (contado). Si es crédito ('2'), se ignora y se acredita CxP. FBK-011.
   */
  @Column({ nullable: true })
  cuenta_tesoreria_id?: string;

  @Column({ type: 'date', nullable: true })
  due_date?: string;

  // Seguimiento de pago (FBK-031 / Cartera CxP) — mismo esquema que Factura
  // de ventas: condicion_pago/estado_pago/total_pagado en el documento,
  // cuotas/abonos detallados en la tabla pagos_compra (ver PagoCompra).
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

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ length: 3, default: 'COP' })
  currency!: string;

  /** true si se creó importando un XML de la DIAN */
  @Column({ default: false })
  from_xml!: boolean;

  /** PDF generado — excluido de queries de lista */
  @Column({ type: 'text', nullable: true, select: false })
  pdf_base64?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
