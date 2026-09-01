/**
 * Catálogo de tipos de documento de identidad.
 * Incluye los códigos numéricos DIAN (usados en XML de factura electrónica)
 * y los códigos legibles para la app (CC, CE, NIT…).
 *
 * Tabla: cat_tipos_documento
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('cat_tipos_documento')
export class TipoDocumentoIdentidad {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Código legible usado en la app y en formularios: CC, CE, NIT, PP… */
  @Column({ length: 10, unique: true })
  codigo!: string;

  /** Código numérico del catálogo 6 DIAN: 13, 22, 31, 41… */
  @Column({ length: 6, unique: true, nullable: true })
  codigo_dian?: string;

  @Column({ length: 120 })
  nombre!: string;

  /** El tipo aplica para identificar personas naturales */
  @Column({ default: true })
  aplica_persona_natural!: boolean;

  /** El tipo aplica para identificar personas jurídicas */
  @Column({ default: false })
  aplica_persona_juridica!: boolean;

  /**
   * El número de documento requiere dígito de verificación.
   * Aplica principalmente para NIT.
   */
  @Column({ default: false })
  requiere_dv!: boolean;

  @Column({ default: true })
  activo!: boolean;

  /** Orden de presentación en desplegables */
  @Column({ default: 0 })
  orden!: number;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
