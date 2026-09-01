/**
 * Nota Debito de factura electronica de salud.
 * Referencia siempre a una FacturaSalud existente.
 * Tabla: notas_debito_salud
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Unique,
} from 'typeorm';
import { Company } from '../Company';
import { FacturaSalud } from './FacturaSalud';
import { Eps } from './Eps';

export type NotaDebitoSaludStatus =
  | 'borrador'
  | 'enviada'
  | 'aprobada'
  | 'aceptada'
  | 'rechazada';

@Entity('notas_debito_salud')
@Unique(['company_id', 'nota_number'])
export class NotaDebitoSalud {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { nullable: false, onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ nullable: true })
  factura_id?: string;

  /** RESTRICT: no se puede eliminar una factura que tenga notas debito.
   *  Entrega 52: ahora es opcional -- una nota independiente (de una factura de
   *  salud no registrada en este sistema) no tiene factura local asociada; en
   *  ese caso el numero/CUFE/fecha/EPS quedan en los campos ref_* de abajo. */
  @ManyToOne(() => FacturaSalud, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'factura_id' })
  factura?: FacturaSalud;

  /** Referencia manual (Entrega 52) cuando no hay factura_id: datos de la
   *  factura de salud tal como los escribio el usuario, para BillingReference. */
  @Column({ length: 50, nullable: true })
  ref_numero_factura?: string;

  @Column({ length: 100, nullable: true })
  ref_cufe?: string;

  @Column({ type: 'date', nullable: true })
  ref_fecha_emision?: string;

  /** EPS elegida a mano cuando la nota es independiente (no hay factura local
   *  de la que derivar la EPS via factura.eps). */
  @Column({ nullable: true })
  ref_eps_id?: string;

  @ManyToOne(() => Eps, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'ref_eps_id' })
  ref_eps?: Eps;

  /** Numero completo de la nota debito (prefix + number). Unico por empresa. */
  @Column({ length: 50 })
  nota_number!: string;

  @Column({ length: 20, default: 'NDSS' })
  prefix!: string;

  @Column()
  number!: number;

  @Column({ type: 'date' })
  issue_date!: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'text', nullable: true })
  cude?: string;

  /** Codigo de discrepancia DIAN. Natural key -> cat_codigos_discrepancia.codigo */
  @Column({ length: 5, nullable: true })
  discrepancy_code?: string;

  @Column({ type: 'text', nullable: true })
  discrepancy_description?: string;

  @Column({ length: 15, default: 'borrador' })
  status!: NotaDebitoSaludStatus;

  @Column({ length: 10, nullable: true })
  dian_status_code?: string;

  @Column({ type: 'text', nullable: true })
  dian_status_description?: string;

  @Column({ type: 'text', nullable: true })
  dian_response?: string;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  subtotal!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  tax_total!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  total!: number;

  @Column({ length: 10, default: 'COP' })
  currency!: string;

  @Column({ type: 'simple-json', nullable: true })
  lines?: Record<string, unknown>[];

  @Column({ type: 'text', nullable: true })
  xml_base64?: string;

  @Column({ type: 'text', nullable: true })
  pdf_base64?: string;

  @Column({ type: 'text', nullable: true })
  zip_base64?: string;


  /** Usuario que creó el registro. Desnormalizado: sobrevive borrado/renombrado de usuario. */
  @Column({ nullable: true })
  created_by_user_id?: string;

  @Column({ length: 120, nullable: true })
  created_by_name?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
