import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Company } from './Company';
import { ReceivedInvoice } from './ReceivedInvoice';
import { User } from './User';

/**
 * Historial de eventos RADIAN enviados a la DIAN para una factura recibida.
 *
 * Normaliza el campo `sent_events` (simple-json) de ReceivedInvoice en una
 * tabla propia, permitiendo consultar, filtrar y auditar cada evento individualmente.
 *
 * Codigos de evento RADIAN mas comunes:
 *   030 = Acuse de recibo de factura electronica
 *   032 = Recibo del bien o prestacion del servicio
 *   033 = Aceptacion expresa
 *   034 = Aceptacion tacita
 *   036 = Reclamacion
 *
 * Tabla: received_invoice_eventos
 */
@Entity('received_invoice_eventos')
@Index(['received_invoice_id'])                // join a factura recibida
@Index(['company_id', 'sent_at'])              // auditoria de eventos por fecha
@Index(['company_id', 'event_code'])           // filtrado por tipo de evento
export class ReceivedInvoiceEvento {
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

  /**
   * Codigo del evento RADIAN.
   * Ej: '030' = acuse de recibo, '032' = recibo del bien, '033' = aceptacion expresa.
   */
  @Column({ length: 5 })
  event_code!: string;

  @Column({ length: 200 })
  event_description!: string;

  /**
   * UUID del evento asignado por la DIAN al aceptar el envio.
   * Puede ser null si el envio fallo antes de recibir confirmacion.
   */
  @Column({ length: 100, nullable: true })
  event_id?: string;

  /** Codigo de respuesta de la DIAN (ej: '00' = exitoso) */
  @Column({ length: 10, nullable: true })
  dian_status_code?: string;

  /** Descripcion de la respuesta de la DIAN */
  @Column({ type: 'text', nullable: true })
  dian_status_description?: string;

  /** true si la DIAN acepto el evento exitosamente */
  @Column({ default: false })
  exitoso!: boolean;

  /** Fecha y hora en que se envio el evento a la DIAN */
  @Column({ type: 'datetime' })
  sent_at!: Date;

  /** Usuario que disparo el envio del evento */
  @Column({ nullable: true })
  enviado_por_id?: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL', eager: false })
  @JoinColumn({ name: 'enviado_por_id' })
  enviado_por?: User;

  /** Payload completo enviado a la DIAN (para debugging). Excluido de SELECTs por defecto. */
  @Column({ type: 'text', nullable: true, select: false })
  request_payload?: string;

  /** Respuesta completa de la DIAN (para debugging). Excluida de SELECTs por defecto. */
  @Column({ type: 'text', nullable: true, select: false })
  response_payload?: string;

  @CreateDateColumn()
  created_at!: Date;
}
