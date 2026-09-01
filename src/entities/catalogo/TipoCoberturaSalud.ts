/**
 * Catálogo de tipos de cobertura / plan de salud (MinSalud - Colombia).
 * Tabla: cat_tipos_cobertura_salud
 */
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('cat_tipos_cobertura_salud')
export class TipoCoberturaSalud {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Codigo interno (POS-S, POS-C, ARL, etc.) */
  @Column({ length: 30, unique: true })
  codigo!: string;

  @Column({ length: 150 })
  nombre!: string;

  @Column({ type: 'text', nullable: true })
  descripcion?: string;

  @Column({ default: true })
  activo!: boolean;

  @Column({ default: 0 })
  orden!: number;
}
