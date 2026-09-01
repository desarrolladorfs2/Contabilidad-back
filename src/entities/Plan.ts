/**
 * Planes de suscripcion del SaaS.
 * Define los paquetes comerciales disponibles para los clientes.
 *
 * La tabla empresa_modulo sigue siendo la fuente de verdad sobre que modulos
 * tiene activos cada empresa; el plan es el concepto comercial/billing.
 *
 * Tabla: planes
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('planes')
export class Plan {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 100, unique: true })
  nombre!: string;

  @Column({ type: 'text', nullable: true })
  descripcion?: string;

  /** Numero maximo de usuarios activos. -1 = ilimitado. */
  @Column({ default: 5 })
  max_usuarios!: number;

  /** Almacenamiento maximo en MB. -1 = ilimitado. */
  @Column({ default: 500 })
  max_almacenamiento_mb!: number;

  /** Precio mensual en la moneda indicada. null = gratuito. */
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  precio_mensual?: number;

  /** Precio anual (generalmente precio_mensual * 10 para incluir 2 meses gratis). */
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  precio_anual?: number;

  /** Moneda ISO 4217: COP, USD, EUR. */
  @Column({ length: 5, default: 'COP' })
  moneda!: string;

  @Column({ default: false })
  es_prueba!: boolean;

  /** Dias de duracion del periodo de prueba. Solo aplica si es_prueba = true. */
  @Column({ nullable: true })
  duracion_prueba_dias?: number;

  @Column({ default: true })
  activo!: boolean;

  /** Orden de presentacion en la pantalla de planes. */
  @Column({ default: 0 })
  orden!: number;

  /** Notas internas (no se muestra al cliente). */
  @Column({ type: 'text', nullable: true })
  notas_internas?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
