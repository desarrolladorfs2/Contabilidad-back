import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Company } from '../Company';
import { CentroCosto } from './CentroCosto';
import { CuentaPUC } from './CuentaPUC';
import { User } from '../User';

@Entity('presupuestos_centro_costo')
@Index(['company_id', 'centro_costo_id', 'cuenta_puc_id', 'anio', 'mes'], { unique: true })
export class PresupuestoCentroCosto {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column()
  centro_costo_id!: string;

  @ManyToOne(() => CentroCosto, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'centro_costo_id' })
  centro_costo!: CentroCosto;

  /** Cuenta PUC a la que aplica el presupuesto (opcional: puede ser solo por centro de costo) */
  @Column({ nullable: true })
  cuenta_puc_id?: string;

  @ManyToOne(() => CuentaPUC, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'cuenta_puc_id' })
  cuenta_puc?: CuentaPUC;

  @Column({ type: 'int' })
  anio!: number;

  /** Mes 1-12; null = presupuesto anual sin desagregacion mensual */
  @Column({ type: 'int', nullable: true })
  mes?: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  valor_presupuestado!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  valor_ejecutado!: number;

  @Column({ default: false })
  aprobado!: boolean;

  @Column({ nullable: true })
  aprobado_por_id?: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'aprobado_por_id' })
  aprobado_por?: User;

  @Column({ length: 500, nullable: true })
  observaciones?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
