import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Company } from './Company';
import { Tercero } from './Tercero';

export type ReceivedInvoiceStatus =
  | 'pendiente'
  | 'acuse_enviado'
  | 'bien_recibido'
  | 'aceptada'
  | 'reclamada';

export type ReceivedPaymentStatus = 'pendiente' | 'parcial' | 'pagada';

export interface RadianEvent {
  code: string;
  description: string;
  event_id: string;
  sent_at: string;
  dian_status: string | null;
  dian_desc: string | null;
  success: boolean;
}

@Entity('received_invoices')
@Index(['company_id', 'invoice_date'])
@Index(['company_id', 'status'])
@Index(['company_id', 'payment_status'])
@Index(['tercero_id'])
export class ReceivedInvoice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, (c) => c.received_invoices, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  /** FK al tercero proveedor registrado. null si aun no esta registrado. */
  @Column({ nullable: true })
  tercero_id?: string;

  @ManyToOne(() => Tercero, { nullable: true, eager: false })
  @JoinColumn({ name: 'tercero_id' })
  tercero?: Tercero;

  /** Numero de documento del proveedor (ej: 'SETP990000319'). Unico por empresa. */
  @Column({ length: 100 })
  invoice_id!: string;

  @Column({ type: 'text', nullable: true })
  invoice_cufe?: string;

  @Column({ type: 'date', nullable: true })
  invoice_date?: string;

  /** Fecha limite de pago al proveedor */
  @Column({ type: 'date', nullable: true })
  payment_due_date?: string;

  // Totales
  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true, default: 0 })
  subtotal?: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true, default: 0 })
  tax_total?: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  total!: number;

  /** Monto ya pagado al proveedor (pagos parciales o total) */
  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  total_paid!: number;

  /** Natural key -> cat_monedas.codigo_iso (ISO 4217) */
  @Column({ length: 10, default: 'COP' })
  currency!: string;

  // Proveedor (snapshot al momento de recibir)
  @Column({ length: 30, nullable: true })
  provider_nit?: string;

  @Column({ length: 200, nullable: true })
  provider_name?: string;

  /** Estado del flujo RADIAN */
  @Column({ length: 30, default: 'pendiente' })
  status!: ReceivedInvoiceStatus;

  /** Estado de pago al proveedor */
  @Column({ length: 20, default: 'pendiente' })
  payment_status!: ReceivedPaymentStatus;

  /**
   * @deprecated Usar ReceivedInvoiceEvento (tabla separada) para el historial RADIAN.
   * Se mantiene por compatibilidad con el codigo existente de envio de eventos.
   */
  @Column({ type: 'simple-json', nullable: true })
  sent_events?: RadianEvent[];

  /**
   * @deprecated Usar ReceivedInvoiceLinea (tabla separada) para las lineas normalizadas.
   * Se mantiene para display del XML RADIAN original.
   */
  @Column({ type: 'simple-json', nullable: true })
  lines?: Record<string, unknown>[];

  /** XML UBL original en base64 */
  @Column({ type: 'text', nullable: true })
  raw_xml_base64?: string;


  /** Usuario que creó el registro. Desnormalizado: sobrevive borrado/renombrado de usuario. */
  @Column({ nullable: true })
  created_by_user_id?: string;

  @Column({ length: 120, nullable: true })
  created_by_name?: string;

  @CreateDateColumn()
  registered_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
