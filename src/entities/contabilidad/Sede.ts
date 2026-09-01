import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Company } from '../Company';
import { Municipio } from '../catalogo/Municipio';
import { User } from '../User';

@Entity('sedes')
@Index(['company_id', 'codigo'], { unique: true })
export class Sede {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ length: 20 })
  codigo!: string;

  @Column({ length: 200 })
  nombre!: string;

  @Column({ nullable: true })
  municipio_id?: string;

  @ManyToOne(() => Municipio, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'municipio_id' })
  municipio?: Municipio;

  @Column({ length: 300, nullable: true })
  direccion?: string;

  @Column({ length: 50, nullable: true })
  telefono?: string;

  @Column({ nullable: true })
  responsable_id?: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'responsable_id' })
  responsable?: User;

  @Column({ length: 500, nullable: true })
  descripcion?: string;

  @Column({ default: true })
  activo!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
