import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Company } from '../Company';

export type TipoRetencion = 'retefuente' | 'reteiva' | 'reteica';

/**
 * Catálogo de tarifas de retención en la fuente, IVA y ICA.
 * Reemplaza las tarifas hardcodeadas en el módulo de impuestos.
 *
 * company_id = null  → tarifa global DIAN (seed data, aplica a todas las empresas)
 * company_id = UUID  → tarifa personalizada o adicional de la empresa
 *
 * Conceptos de referencia DIAN (Retefuente):
 *   - Honorarios y servicios personales: 10–11%
 *   - Servicios en general:              4%
 *   - Compras generales:                 3.5% (27 UVT)
 *   - Arrendamientos bienes raíces:      3.5%
 *   - Dividendos (>1090 UVT):            10%
 *
 * Tabla: impuestos_tarifas_retencion
 */
@Entity('impuestos_tarifas_retencion')
@Index(['company_id', 'concepto_codigo', 'tipo'], { unique: true })
export class TarifaRetencion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** null = tarifa global del sistema; UUID = personalización por empresa */
  @Column({ nullable: true })
  company_id?: string;

  @ManyToOne(() => Company, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company?: Company;

  /** Código interno del concepto (ej: 'HON', 'SVC', 'CMP', 'ARR') */
  @Column({ length: 20 })
  concepto_codigo!: string;

  /** Nombre legible del concepto (ej: 'Honorarios', 'Servicios', 'Compras') */
  @Column({ length: 200 })
  concepto_nombre!: string;

  /** Tipo de retención */
  @Column({ length: 20 })
  tipo!: TipoRetencion;

  /** Tarifa en porcentaje (ej: 11 para 11%, 3.5 para 3.5%) */
  @Column({ type: 'decimal', precision: 10, scale: 4 })
  tarifa_pct!: number;

  /**
   * Base mínima en UVT para que aplique la retención.
   * Si el pago no supera este monto (× valor UVT vigente), no se retiene.
   * Ej: Compras = 27 UVT, Servicios = 4 UVT, Honorarios = 0 UVT.
   */
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  base_minima_uvt!: number;

  @Column({ default: true })
  activa!: boolean;

  @Column({ length: 500, nullable: true })
  descripcion?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
