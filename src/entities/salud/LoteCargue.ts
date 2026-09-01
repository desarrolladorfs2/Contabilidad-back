/**
 * Lote de cargue masivo de facturas de salud (evento).
 * Cada cargue de Excel genera un lote que agrupa sus registros.
 * Tabla: salud_lotes_cargue
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn,
} from 'typeorm';
import { Company } from '../Company';

@Entity('salud_lotes_cargue')
export class LoteCargue {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { nullable: false, onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ length: 255 })
  nombre_archivo!: string;

  @Column({ default: 0 })
  total_registros!: number;

  @Column({ default: 0 })
  registros_nuevos!: number;

  @Column({ default: 0 })
  registros_actualizados!: number;

  @Column({ default: 0 })
  registros_con_error!: number;

  @Column({ nullable: true })
  created_by_user_id?: string;

  @Column({ length: 120, nullable: true })
  created_by_name?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
