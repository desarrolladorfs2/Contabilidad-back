import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Company } from '../Company';

export type TipoFlujo = 'ingreso' | 'egreso' | 'ambos';

/**
 * Catálogo de categorías para clasificar movimientos de tesorería.
 * company_id = null → categoría global del sistema (seed data).
 * company_id = UUID  → categoría personalizada de la empresa.
 */
@Entity('categorias_movimiento_tesoreria')
@Index(['company_id', 'codigo'], { unique: true })
export class CategoriaMovimientoTesoreria {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ nullable: true })
  company_id?: string;

  @ManyToOne(() => Company, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company?: Company;

  @Column({ length: 20 })
  codigo!: string;

  @Column({ length: 200 })
  nombre!: string;

  /** Indica si aplica a ingresos, egresos o ambos tipos de movimiento */
  @Column({ length: 10, default: 'ambos' })
  tipo_flujo!: TipoFlujo;

  @Column({ length: 500, nullable: true })
  descripcion?: string;

  @Column({ default: true })
  activa!: boolean;

  @CreateDateColumn()
  created_at!: Date;
}
