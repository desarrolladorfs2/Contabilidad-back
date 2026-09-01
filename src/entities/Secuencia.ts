/**
 * Control de numeración consecutiva por empresa y tipo de documento.
 *
 * Garantiza números únicos sin duplicados bajo concurrencia.
 * El helper getNextNumero() debe ejecutarse en una transacción con LOCK.
 *
 * Formato generado:
 *   - con año:    COT-2026-0001
 *   - sin año:    COT-0001
 *   - sin prefijo: 0001
 *
 * Tabla: secuencias
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  UpdateDateColumn, ManyToOne, JoinColumn, Unique,
} from 'typeorm';
import { Company } from './Company';

@Entity('secuencias')
@Unique(['company_id', 'entidad'])
export class Secuencia {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  /**
   * Tipo de documento que numera esta secuencia.
   * Valores actuales: 'cotizacion'
   * Futuros: 'pedido', 'remision', 'devolucion'
   */
  @Column({ length: 50 })
  entidad!: string;

  /** Prefijo del número. Ej: 'COT', 'PED'. Puede ser vacío. */
  @Column({ length: 20, default: '' })
  prefijo!: string;

  /**
   * Último número emitido. El siguiente = ultimo_numero + 1.
   * Se incrementa atómicamente en una transacción.
   */
  @Column({ default: 0 })
  ultimo_numero!: number;

  /**
   * Longitud mínima del número (zero-padding).
   * 4 → '0001', '0023', '1234'
   */
  @Column({ default: 4 })
  longitud_minima!: number;

  /** Si true, incluye el año en el número: COT-2026-0001 */
  @Column({ default: true })
  incluir_anio!: boolean;

  /**
   * Si true, el contador reinicia a 1 cada 1 de enero.
   * ultimo_numero se resetea y se guarda el año del último reset en anio_actual.
   */
  @Column({ default: false })
  reiniciar_anio!: boolean;

  /** Año del último reinicio (para detectar cambio de año). */
  @Column({ nullable: true })
  anio_actual?: number;

  @UpdateDateColumn()
  updated_at!: Date;
}
