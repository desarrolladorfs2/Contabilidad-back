/**
 * Novedad — mensajes del carrusel "Novedades y actualizaciones" del hub principal.
 *
 * Reemplaza el arreglo hardcodeado que antes vivía en hub.component.ts. Cada
 * fila es un mensaje con su categoría (antes llamada "label": Actualización,
 * Mejora, Próximamente, etc.), su color asociado (usado para el punto, la
 * etiqueta y el borde de la tarjeta) y el texto del mensaje.
 *
 * company_id es opcional a propósito: en null, la novedad es un anuncio
 * GLOBAL visible para todas las empresas del sistema (equivalente al
 * comportamiento anterior, donde todo el arreglo era el mismo para todos).
 * Con company_id definido, la novedad solo se muestra a esa empresa —
 * así los mensajes pueden variar según la empresa asociada, como se pidió.
 *
 * Tabla: novedades
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Company } from './Company';

@Entity('novedades')
@Index(['company_id', 'activa'])
export class Novedad {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** null = anuncio global, visible para todas las empresas. */
  @Column({ nullable: true })
  company_id?: string | null;

  @ManyToOne(() => Company, { nullable: true, onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'company_id' })
  company?: Company;

  /** Título/categoría del mensaje (ej. "Actualización", "Mejora", "Próximamente"). */
  @Column({ length: 40 })
  categoria!: string;

  /** Color hexadecimal asociado a la categoría — punto, etiqueta y borde de la tarjeta. */
  @Column({ length: 20, default: '#6366f1' })
  color!: string;

  /** Texto del mensaje mostrado en la tarjeta. */
  @Column({ length: 300 })
  mensaje!: string;

  /** Si es false, la novedad no se muestra aunque esté dentro de vigencia. */
  @Column({ type: 'boolean', default: true })
  activa!: boolean;

  /** Orden de aparición en el carrusel (ascendente). */
  @Column({ default: 0 })
  orden!: number;

  /** Rango de vigencia opcional — fuera de este rango, la novedad no se muestra. */
  @Column({ type: 'date', nullable: true })
  fecha_inicio?: string;

  @Column({ type: 'date', nullable: true })
  fecha_fin?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
