/**
 * Pivot M:N entre empresas y responsabilidades fiscales DIAN.
 * Reemplaza el campo company.tax_level_code (single string) que no soportaba
 * múltiples responsabilidades simultáneas (ej: O-13 + O-15 + O-24).
 *
 * Tabla: company_responsabilidades
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, ManyToOne, JoinColumn, Unique,
} from 'typeorm';
import { Company } from './Company';
import { TipoResponsabilidadFiscal } from './catalogo/TipoResponsabilidadFiscal';

@Entity('company_responsabilidades')
@Unique(['company_id', 'responsabilidad_codigo'])
export class CompanyResponsabilidad {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  /** Natural key -> cat_responsabilidades_fiscales.codigo (ej: 'O-13', 'R-99-PN') */
  @Column({ length: 20 })
  responsabilidad_codigo!: string;

  @ManyToOne(() => TipoResponsabilidadFiscal, { nullable: false, eager: false })
  @JoinColumn({ name: 'responsabilidad_codigo', referencedColumnName: 'codigo' })
  responsabilidad!: TipoResponsabilidadFiscal;

  /** true si es la responsabilidad principal (para retrocompatibilidad con tax_level_code) */
  @Column({ default: false })
  es_principal!: boolean;

  @CreateDateColumn()
  created_at!: Date;
}
