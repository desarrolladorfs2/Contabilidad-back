/**
 * Catálogo de municipios de Colombia (DIVIPOLA - DANE).
 * El seed incluye capitales + ciudades principales.
 * La lista completa (1.122 municipios) puede cargarse desde el archivo
 * oficial DIVIPOLA del DANE cuando se requiera.
 *
 * Tabla: cat_municipios
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  ManyToOne, JoinColumn,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';
import { Departamento } from './Departamento';

@Entity('cat_municipios')
export class Municipio {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Código DANE del municipio (5 dígitos): 11001, 05001…
   * Los 2 primeros son el código del departamento.
   */
  @Column({ length: 8, unique: true })
  codigo_dane!: string;

  @Column({ length: 150 })
  nombre!: string;

  @Column({ nullable: true })
  departamento_id?: string;

  @ManyToOne(() => Departamento, { nullable: true })
  @JoinColumn({ name: 'departamento_id' })
  departamento?: Departamento;

  /** Indica si es la ciudad capital del departamento */
  @Column({ default: false })
  es_capital!: boolean;

  @Column({ default: true })
  activo!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
