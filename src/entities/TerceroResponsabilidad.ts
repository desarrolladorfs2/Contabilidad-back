/**
 * Pivot M:N entre terceros y responsabilidades fiscales DIAN.
 * Reemplaza el campo tercero.nivel_tributario (single string) que no soportaba
 * múltiples responsabilidades simultáneas.
 *
 * Tabla: tercero_responsabilidades
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, ManyToOne, JoinColumn, Unique,
} from 'typeorm';
import { Tercero } from './Tercero';
import { TipoResponsabilidadFiscal } from './catalogo/TipoResponsabilidadFiscal';

@Entity('tercero_responsabilidades')
@Unique(['tercero_id', 'responsabilidad_codigo'])
export class TerceroResponsabilidad {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  tercero_id!: string;

  @ManyToOne(() => Tercero, { onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'tercero_id' })
  tercero!: Tercero;

  /** Natural key -> cat_responsabilidades_fiscales.codigo (ej: 'O-13', 'R-99-PN') */
  @Column({ length: 20 })
  responsabilidad_codigo!: string;

  @ManyToOne(() => TipoResponsabilidadFiscal, { nullable: false, eager: false })
  @JoinColumn({ name: 'responsabilidad_codigo', referencedColumnName: 'codigo' })
  responsabilidad!: TipoResponsabilidadFiscal;

  /** true si es la responsabilidad principal (para retrocompatibilidad con nivel_tributario) */
  @Column({ default: false })
  es_principal!: boolean;

  @CreateDateColumn()
  created_at!: Date;
}
