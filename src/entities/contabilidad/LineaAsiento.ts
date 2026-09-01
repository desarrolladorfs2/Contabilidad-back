import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, ManyToMany, JoinColumn, JoinTable,
} from 'typeorm';
import { AsientoContable } from './AsientoContable';
import { CuentaPUC } from './CuentaPUC';
import { CentroCosto } from './CentroCosto';
import { Sede } from './Sede';
import { Tercero } from '../Tercero';

@Entity('lineas_asiento')
export class LineaAsiento {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  asiento_id!: string;

  @ManyToOne(() => AsientoContable, (a) => a.lineas, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'asiento_id' })
  asiento!: AsientoContable;

  @Column({ nullable: true })
  cuenta_id?: string;

  @ManyToOne(() => CuentaPUC, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'cuenta_id' })
  cuenta?: CuentaPUC;

  @Column({ nullable: true })
  tercero_id?: string;

  @ManyToOne(() => Tercero, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'tercero_id' })
  tercero?: Tercero;

  @Column({ nullable: true })
  centro_costo_id?: string;

  @ManyToOne(() => CentroCosto, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'centro_costo_id' })
  centro_costo?: CentroCosto;

  /** Ciudad de la línea (código DANE, ej: '11001') */
  @Column({ length: 20, nullable: true })
  ciudad_codigo?: string;

  /** Nombre de ciudad desnormalizado para evitar joins en reportes */
  @Column({ length: 200, nullable: true })
  ciudad_nombre?: string;

  /** Sedes asociadas a esta línea contable (una o varias) */
  @ManyToMany(() => Sede)
  @JoinTable({
    name: 'linea_asiento_sedes',
    joinColumn:        { name: 'linea_id',  referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'sede_id',   referencedColumnName: 'id' },
  })
  sedes?: Sede[];

  @Column({ length: 500, nullable: true })
  concepto?: string;

  // Campos de compatibilidad (bridge) - mantener mientras se migra la generacion automatica de asientos

  /** @deprecated Usar cuenta_id -> CuentaPUC */
  @Column({ length: 20, nullable: true })
  cuenta_codigo?: string;

  /** @deprecated Derivar del join con CuentaPUC */
  @Column({ length: 300, nullable: true })
  cuenta_nombre?: string;

  /** @deprecated Usar tercero_id -> Tercero */
  @Column({ length: 100, nullable: true })
  tercero_nit?: string;

  /** @deprecated Derivar del join con Tercero */
  @Column({ length: 200, nullable: true })
  tercero_nombre?: string;

  /** @deprecated Derivar del join con CentroCosto */
  @Column({ length: 200, nullable: true })
  centro_costo_nombre?: string;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  debito!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  credito!: number;

  @Column({ type: 'int', default: 0 })
  orden!: number;
}
