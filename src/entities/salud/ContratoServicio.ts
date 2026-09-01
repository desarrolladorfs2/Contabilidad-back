/**
 * Tabla pivot entre ContratoSalud y ServicioSalud.
 * Define que servicios estan habilitados en un contrato y a que precio.
 * Tabla: salud_contrato_servicios
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Unique,
} from 'typeorm';
import { Company } from '../Company';
import { ContratoSalud } from './ContratoSalud';
import { ServicioSalud } from './ServicioSalud';

@Entity('salud_contrato_servicios')
@Unique(['contrato_id', 'servicio_id'])
export class ContratoServicio {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** FK directa al tenant para queries O(1) sin JOIN encadenado. */
  @Column({ nullable: true })
  company_id?: string;

  @ManyToOne(() => Company, { nullable: true, onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column()
  contrato_id!: string;

  @ManyToOne(() => ContratoSalud, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'contrato_id' })
  contrato!: ContratoSalud;

  @Column()
  servicio_id!: string;

  @ManyToOne(() => ServicioSalud, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'servicio_id' })
  servicio!: ServicioSalud;

  /** Precio pactado en este contrato. Si null, se usa ServicioSalud.valor_base. */
  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  valor_acordado?: number;

  @Column({ default: true })
  habilitado!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
