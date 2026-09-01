import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, OneToMany, JoinColumn, Index,
} from 'typeorm';
import { Company } from '../Company';

export type NaturalezaCuenta = 'debito' | 'credito';
export type TipoCuenta = 'activo' | 'pasivo' | 'patrimonio' | 'ingreso' | 'gasto' | 'costo' | 'orden';
export type NivelCuenta = 1 | 2 | 3 | 4 | 5;

@Entity('cuentas_puc')
@Index(['company_id', 'codigo'], { unique: true })
export class CuentaPUC {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ length: 20 })
  codigo!: string;

  @Column({ length: 300 })
  nombre!: string;

  @Column({ length: 20 })
  tipo!: TipoCuenta;

  @Column({ type: 'int', default: 1 })
  nivel!: NivelCuenta;

  @Column({ length: 20 })
  naturaleza!: NaturalezaCuenta;

  @Column({ nullable: true })
  padre_id?: string;

  @ManyToOne(() => CuentaPUC, cuenta => cuenta.hijos, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'padre_id' })
  padre?: CuentaPUC;

  @OneToMany(() => CuentaPUC, cuenta => cuenta.padre)
  hijos?: CuentaPUC[];

  @Column({ default: false })
  acepta_movimientos!: boolean;

  @Column({ default: false })
  requiere_tercero!: boolean;

  /**
   * Si true, toda línea de asiento que use esta cuenta debe traer un
   * Centro de Costo asignado — se valida al momento de aprobar el asiento
   * (ver POST /contabilidad/asientos/:id/aprobar). Feedback piloto FBK-018.
   */
  @Column({ default: false })
  requiere_centro_costo!: boolean;

  @Column({ default: true })
  activa!: boolean;

  @Column({ type: 'text', nullable: true })
  notas?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
