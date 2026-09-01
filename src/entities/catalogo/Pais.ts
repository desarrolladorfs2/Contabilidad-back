/**
 * Catálogo de países (ISO 3166-1).
 * Se usa como referencia geográfica en empresas, terceros y documentos.
 *
 * Tabla: cat_paises
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('cat_paises')
export class Pais {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Código ISO 3166-1 alfa-2: CO, US, ES… */
  @Column({ length: 2, unique: true })
  codigo_iso2!: string;

  /** Código ISO 3166-1 alfa-3: COL, USA, ESP… */
  @Column({ length: 3, unique: true, nullable: true })
  codigo_iso3?: string;

  /** Código numérico ISO 3166-1: 170 (CO), 840 (US)… */
  @Column({ length: 5, unique: true, nullable: true })
  codigo_iso_num?: string;

  @Column({ length: 150 })
  nombre!: string;

  /** Nombre en inglés para referencias internacionales */
  @Column({ length: 150, nullable: true })
  nombre_en?: string;

  @Column({ default: true })
  activo!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
