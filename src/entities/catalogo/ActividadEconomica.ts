/**
 * Catálogo de actividades económicas CIIU Rev. 4 adaptada para Colombia (DANE/DIAN).
 * Se usa en el RUT de la empresa y en algunos documentos tributarios.
 *
 * Estructura jerárquica CIIU:
 *   Sección   (letra A-U)         → ej: G
 *   División  (2 dígitos)         → ej: 47
 *   Grupo     (3 dígitos)         → ej: 471
 *   Clase     (4 dígitos) ← DIAN  → ej: 4711
 *
 * El seed incluye los ~60 códigos más comunes para empresas colombianas.
 * La lista completa (621 clases) está disponible en:
 * https://www.dane.gov.co/files/nomenclaturas/CIIU_Rev4ac.pdf
 *
 * Tabla: cat_actividades_economicas
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('cat_actividades_economicas')
export class ActividadEconomica {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Código CIIU de 4 dígitos (clase): 4711, 6201, 8610… */
  @Column({ length: 10, unique: true })
  codigo_ciiu!: string;

  @Column({ length: 300 })
  descripcion!: string;

  /** Letra de sección CIIU: A, C, F, G, J, K, L, M, N, P, Q, S… */
  @Column({ length: 3, nullable: true })
  seccion?: string;

  /** Nombre de la sección */
  @Column({ length: 150, nullable: true })
  seccion_nombre?: string;

  /** Código de división (2 dígitos): 47, 62, 86… */
  @Column({ length: 5, nullable: true })
  division?: string;

  /** Código de grupo (3 dígitos): 471, 620, 861… */
  @Column({ length: 5, nullable: true })
  grupo?: string;

  @Column({ default: true })
  activo!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
