/**
 * Pivot M:N entre planes y módulos.
 * Define qué módulos están habilitados para cada plan comercial.
 * La tabla empresa_modulo sigue siendo la fuente de verdad sobre qué módulos
 * tiene activos CADA EMPRESA; este pivot define la oferta por plan.
 *
 * Tabla: plan_modulo
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, ManyToOne, JoinColumn, Unique,
} from 'typeorm';
import { Plan } from './Plan';
import { Modulo } from './Modulo';

@Entity('plan_modulo')
@Unique(['plan_id', 'modulo_id'])
export class PlanModulo {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  plan_id!: string;

  @ManyToOne(() => Plan, { onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'plan_id' })
  plan!: Plan;

  @Column()
  modulo_id!: string;

  @ManyToOne(() => Modulo, { onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'modulo_id' })
  modulo!: Modulo;

  /** Permite deshabilitar un módulo de un plan sin eliminar el registro */
  @Column({ default: true })
  activo!: boolean;

  @CreateDateColumn()
  created_at!: Date;
}
