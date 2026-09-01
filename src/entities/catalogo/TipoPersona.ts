/**
 * Catálogo de tipos de persona — DIAN Colombia.
 * Valores: 'natural', 'juridica'
 * Usados en: Tercero.tipo_persona_codigo, Company.tipo_persona
 * Tabla: cat_tipos_persona
 */
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('cat_tipos_persona')
export class TipoPersona {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** 'natural' | 'juridica' */
  @Column({ length: 20, unique: true })
  codigo!: string;

  @Column({ length: 100 })
  nombre!: string;

  @Column({ type: 'text', nullable: true })
  descripcion?: string;

  @Column({ default: true })
  activo!: boolean;

  @CreateDateColumn()
  created_at!: Date;
}
