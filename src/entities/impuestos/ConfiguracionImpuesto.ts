import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Company } from '../Company';
import { ActividadEconomica } from '../catalogo/ActividadEconomica';
import { Municipio } from '../catalogo/Municipio';

export type TipoImpuesto = 'iva' | 'retefuente' | 'reteiva' | 'reteica' | 'ica' | 'renta' | 'cree';
export type PeriodicidadImpuesto = 'mensual' | 'bimestral' | 'cuatrimestral' | 'anual';

/**
 * Parametrización fiscal por empresa.
 * Define qué impuestos aplica la empresa, con qué periodicidad declara
 * y la tarifa específica cuando no es fija (ej: ICA varía por municipio/actividad).
 *
 * Una fila por tipo de impuesto por empresa.
 * Tabla: impuestos_configuracion
 */
@Entity('impuestos_configuracion')
@Index(['company_id', 'tipo'], { unique: true })
export class ConfiguracionImpuesto {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  /** Tipo de impuesto que parametriza este registro */
  @Column({ length: 20 })
  tipo!: TipoImpuesto;

  /** Si la empresa es responsable/agente retenedor de este impuesto */
  @Column({ default: true })
  aplica!: boolean;

  /** Frecuencia de declaración según la DIAN */
  @Column({ length: 20, default: 'bimestral' })
  periodicidad!: PeriodicidadImpuesto;

  /**
   * Tarifa en porcentaje para impuestos con tarifa variable.
   * IVA: 0, 5, 19. ICA: tarifa x mil de la ciudad (ej: 6.6 para 0,0066).
   * null = usar tarifa estándar DIAN / TarifaRetencion.
   */
  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true })
  tarifa_pct?: number;

  /**
   * Para ICA: municipio donde tributa la empresa.
   * La tarifa ICA varía por actividad económica y municipio.
   */
  @Column({ nullable: true })
  municipio_id?: string;

  @ManyToOne(() => Municipio, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'municipio_id' })
  municipio?: Municipio;

  /**
   * Para ICA: actividad económica principal de la empresa en ese municipio.
   * Permite calcular la base ICA correcta.
   */
  @Column({ nullable: true })
  actividad_economica_id?: string;

  @ManyToOne(() => ActividadEconomica, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'actividad_economica_id' })
  actividad_economica?: ActividadEconomica;

  /** Número de formulario DIAN asociado (ej: '300'=IVA, '350'=Retefuente, '490'=ICA) */
  @Column({ length: 10, nullable: true })
  formulario_dian?: string;

  @Column({ length: 500, nullable: true })
  observaciones?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
