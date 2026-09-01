import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Company } from './Company';

export type UserRole = 'superadmin' | 'admin' | 'operator' | 'viewer';

@Entity('users')
@Index(['company_id', 'email'], { unique: true })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Company, (c) => c.users)
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column()
  company_id!: string;

  @Column({ length: 150 })
  email!: string;

  @Column({ length: 200 })
  name!: string;

  @Column({ type: 'text' })
  password_hash!: string;

  @Column({ default: 'operator' })
  role!: UserRole;

  @Column({ default: true })
  is_active!: boolean;

  @Column({ length: 10, nullable: true })
  tipo_documento?: string;

  @Column({ length: 30, nullable: true })
  numero_documento?: string;

  @Column({ length: 80, nullable: true })
  primer_nombre?: string;

  @Column({ length: 80, nullable: true })
  segundo_nombre?: string;

  @Column({ length: 80, nullable: true })
  primer_apellido?: string;

  @Column({ length: 80, nullable: true })
  segundo_apellido?: string;

  @Column({ length: 150, nullable: true })
  cargo?: string;

  @Column({ length: 30, nullable: true })
  telefono?: string;

  @Column({ type: 'text', nullable: true })
  notas?: string;

  @Column({ type: 'date', nullable: true })
  fecha_inicio?: string;

  @Column({ type: 'date', nullable: true })
  fecha_fin?: string;

  @Column({ default: true })
  debe_cambiar_password!: boolean;

  @Column({ type: 'datetime', nullable: true })
  ultimo_login?: Date;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
