/**
 * Categorias de servicios RIPS segun resolucion MinSalud.
 * Determina en que seccion del JSON RIPS se incluye el servicio.
 * Tabla: cat_categorias_rips
 */
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('cat_categorias_rips')
export class CategoriaRips {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Codigo RIPS (consultas, procedimientos, medicamentos, etc.) */
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
