/**
 * EPS, ADRES, ARL y CCF con las que la IPS tiene contratos.
 * Tabla: salud_eps
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Unique,
} from 'typeorm';
import { Company } from '../Company';

/** Tipo de entidad administradora de salud */
export type EpsTipo = 'EPS' | 'ADRES' | 'ARL' | 'CCF';

@Entity('salud_eps')
@Unique(['company_id', 'nit'])
export class Eps {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { nullable: false, onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ length: 20 })
  nit!: string;

  @Column({ length: 200 })
  nombre!: string;

  @Column({ length: 200, nullable: true })
  nombre_comercial?: string;

  @Column({ length: 10, default: 'EPS' })
  tipo!: EpsTipo;

  /** Codigo asignado por ADRES / MinSalud. Unico por empresa. */
  @Column({ length: 10, nullable: true, unique: false })
  codigo_adres?: string;

  @Column({ length: 150, nullable: true })
  email?: string;

  @Column({ length: 30, nullable: true })
  telefono?: string;

  @Column({ length: 300, nullable: true })
  direccion?: string;

  // Ubicacion — snapshot DIVIPOLA
  @Column({ length: 10, nullable: true })
  ciudad_codigo?: string;

  @Column({ length: 150, nullable: true })
  ciudad_nombre?: string;

  @Column({ length: 10, nullable: true })
  departamento_codigo?: string;

  @Column({ length: 150, nullable: true })
  departamento_nombre?: string;

  @Column({ length: 200, nullable: true })
  representante_legal?: string;

  @Column({ type: 'text', nullable: true })
  observaciones?: string;

  @Column({ default: true })
  activo!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
