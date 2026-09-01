/**
 * Catálogo de departamentos de Colombia (DIVIPOLA - DANE).
 * Enlazado a países para soportar internacionalización futura.
 *
 * Tabla: cat_departamentos
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  ManyToOne, JoinColumn,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';
import { Pais } from './Pais';

@Entity('cat_departamentos')
export class Departamento {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Código DANE del departamento: 05, 08, 11, 25… */
  @Column({ length: 5, unique: true })
  codigo_dane!: string;

  @Column({ length: 150 })
  nombre!: string;

  @Column({ nullable: true })
  pais_id?: string;

  @ManyToOne(() => Pais, { nullable: true })
  @JoinColumn({ name: 'pais_id' })
  pais?: Pais;

  @Column({ default: true })
  activo!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
