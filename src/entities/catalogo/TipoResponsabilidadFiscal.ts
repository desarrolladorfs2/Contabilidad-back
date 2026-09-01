/**
 * Catálogo de responsabilidades fiscales DIAN.
 * Se usan en el XML de factura electrónica dentro de <cac:TaxScheme>.
 * Una empresa puede tener varias responsabilidades simultáneas.
 *
 * Tabla: cat_responsabilidades_fiscales
 *
 * Códigos principales:
 *   O-13  Gran contribuyente
 *   O-15  Autorretenedor
 *   O-23  Agente de retención en la fuente
 *   O-24  Declarante de ingresos y patrimonio
 *   O-47  Régimen simple de tributación
 *   R-99-PN  No responsable de IVA (ex Régimen Simplificado)
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('cat_responsabilidades_fiscales')
export class TipoResponsabilidadFiscal {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Código DIAN: O-13, O-15, R-99-PN… */
  @Column({ length: 20, unique: true })
  codigo!: string;

  @Column({ length: 200 })
  nombre!: string;

  @Column({ type: 'text', nullable: true })
  descripcion?: string;

  /** El código aplica para personas naturales */
  @Column({ default: true })
  aplica_persona_natural!: boolean;

  /** El código aplica para personas jurídicas */
  @Column({ default: true })
  aplica_persona_juridica!: boolean;

  @Column({ default: true })
  activo!: boolean;

  @Column({ default: 0 })
  orden!: number;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
