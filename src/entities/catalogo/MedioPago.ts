/**
 * Catálogo de medios de pago — códigos estándar DIAN.
 * Usados en: Invoice.payment_method, Tercero.medio_pago_codigo, Cotizacion
 * Tabla: cat_medios_pago
 */
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('cat_medios_pago')
export class MedioPago {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Código numérico DIAN (string porque puede ser '10', '47', etc.) */
  @Column({ length: 5, unique: true })
  codigo!: string;

  @Column({ length: 150 })
  nombre!: string;

  @Column({ type: 'text', nullable: true })
  descripcion?: string;

  @Column({ default: true })
  activo!: boolean;

  @Column({ default: 0 })
  orden!: number;

  @CreateDateColumn()
  created_at!: Date;
}
