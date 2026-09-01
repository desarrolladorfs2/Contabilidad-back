import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Company } from '../Company';
import { User } from '../User';

@Entity('cierres_periodo')
@Index(['company_id', 'periodo'], { unique: true })
export class CierrePeriodo {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  /** Periodo contable en formato YYYY-MM */
  @Column({ length: 7 })
  periodo!: string;

  @Column({ type: 'date' })
  fecha_cierre!: string;

  @Column({ nullable: true })
  cerrado_por_id?: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'cerrado_por_id' })
  cerrado_por?: User;

  @Column({ nullable: true })
  reabierto_por_id?: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'reabierto_por_id' })
  reabierto_por?: User;

  @Column({ type: 'date', nullable: true })
  fecha_reapertura?: string;

  @Column({ length: 500, nullable: true })
  observaciones?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
