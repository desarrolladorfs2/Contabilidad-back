/**
 * Catalogo de servicios/procedimientos de salud de la IPS.
 * Cada servicio tiene un codigo CUPS (o CUM para medicamentos) unico por empresa.
 * Los campos RIPS son defaults que se pueden sobreescribir por linea en la factura.
 * Tabla: salud_servicios
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Unique,
} from 'typeorm';
import { Company } from '../Company';

/** Categorias de servicio RIPS — natural key -> cat_categorias_rips.codigo */
export type CategoriaRips =
  | 'consultas'
  | 'procedimientos'
  | 'urgencias'
  | 'hospitalizacion'
  | 'medicamentos'
  | 'otrosServicios';

@Entity('salud_servicios')
@Unique(['company_id', 'codigo_cups'])
export class ServicioSalud {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { nullable: false, onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  /** Codigo CUPS (5 digitos) o CUM para medicamentos */
  @Column({ length: 20 })
  codigo_cups!: string;

  @Column({ length: 300 })
  nombre!: string;

  @Column({ type: 'text', nullable: true })
  descripcion?: string;

  /** Natural key -> cat_categorias_rips.codigo */
  @Column({ length: 30 })
  categoria!: CategoriaRips;

  /** Valor base de referencia (tarifa manual de la IPS) */
  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  valor_base!: number;

  @Column({ default: true })
  activo!: boolean;

  // Campos RIPS por defecto (se usan al generar el JSON RIPS si no se especifican en la linea)
  @Column({ length: 30, nullable: true })
  modalidad_grupo_servicio?: string;

  @Column({ length: 30, nullable: true })
  grupo_servicios?: string;

  @Column({ length: 30, nullable: true })
  finalidad_tecnologia_salud?: string;

  @Column({ length: 30, nullable: true })
  causa_motivo_atencion?: string;

  @Column({ length: 30, nullable: true })
  tipo_diagnostico_principal?: string;

  @Column({ length: 30, nullable: true })
  via_ingreso?: string;

  /**
   * SAL-021: código de servicio (habilitación REPS) — Resolución 2275/2023 /
   * 948:2026. Solo aplica a consultas y procedimientos (el RIPS no lo exige
   * para medicamentos/otrosServicios). Se define una vez por servicio (CUPS)
   * aquí en el catálogo, para que esté disponible tanto en el cargue masivo
   * como en el formulario manual sin tener que digitarlo cada vez; una fila
   * de la plantilla de cargue puede sobreescribirlo puntualmente si trae un
   * valor distinto.
   */
  @Column({ length: 30, nullable: true })
  cod_servicio?: string;

  @Column({ length: 30, nullable: true })
  tipo_medicamento?: string;

  @Column({ length: 30, nullable: true })
  tipo_otro_servicio?: string;

  /** Natural key -> cat_unidades_medida.codigo (ej: 'UN', 'ML', 'DIA') */
  @Column({ length: 20, nullable: true })
  unidad_medida?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
