import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Company } from '../Company';
import { Tercero } from '../Tercero';
import { TarifaRetencion } from './TarifaRetencion';

/**
 * Asignación de tarifa de retención a un proveedor/tercero específico.
 * Permite que la factura de compra calcule automáticamente la retención
 * correcta según el tipo de servicio que presta el proveedor,
 * en lugar de aplicar una tarifa única a todos.
 *
 * Ejemplo:
 *   - Proveedor "Consultor Jurídico S.A.S" → Honorarios (11%)
 *   - Proveedor "Ferretería El Clavo"       → Compras (3.5%)
 *   - Proveedor "Transportes Colombia"      → Servicios (4%)
 *
 * Tabla: impuestos_retenciones_tercero
 */
@Entity('impuestos_retenciones_tercero')
@Index(['company_id', 'tercero_id'], { unique: true })
export class RetencionesTercero {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column()
  tercero_id!: string;

  @ManyToOne(() => Tercero, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tercero_id' })
  tercero!: Tercero;

  /**
   * Tarifa de retefuente aplicable a este proveedor.
   * Puede ser nula si el proveedor está exento de retención
   * (ej: grandes contribuyentes con autorretención, entidades del estado).
   */
  @Column({ nullable: true })
  tarifa_retefuente_id?: string;

  @ManyToOne(() => TarifaRetencion, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'tarifa_retefuente_id' })
  tarifa_retefuente?: TarifaRetencion;

  /**
   * Tarifa de reteIVA aplicable.
   * Solo aplica si la empresa es agente retenedor de IVA.
   * Típicamente 15% del IVA facturado (es decir, 15% × 19% = 2.85% sobre base).
   */
  @Column({ nullable: true })
  tarifa_reteiva_id?: string;

  @ManyToOne(() => TarifaRetencion, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'tarifa_reteiva_id' })
  tarifa_reteiva?: TarifaRetencion;

  /**
   * Indica si el proveedor está exento de retención en la fuente.
   * Ej: entidades de gobierno, grandes contribuyentes con autorretencion.
   */
  @Column({ default: false })
  exento_retefuente!: boolean;

  @Column({ default: false })
  exento_reteiva!: boolean;

  @Column({ length: 500, nullable: true })
  observaciones?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
