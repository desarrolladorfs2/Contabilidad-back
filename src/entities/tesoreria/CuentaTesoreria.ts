import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Company } from '../Company';
import { Sede } from '../contabilidad/Sede';

export type TipoCuentaBanco = 'corriente' | 'ahorros' | 'fiducia' | 'electronica';
export type TipoCuentaTesoreria = 'banco' | 'caja' | 'cartera';

@Entity('cuentas_tesoreria')
@Index(['company_id', 'nombre'], { unique: true })
export class CuentaTesoreria {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ length: 200 })
  nombre!: string;

  @Column({ length: 20, default: 'banco' })
  tipo!: TipoCuentaTesoreria;

  /** Solo para tipo banco: clasificacion del producto bancario */
  @Column({ length: 20, nullable: true })
  tipo_cuenta_banco?: TipoCuentaBanco;

  @Column({ length: 200, nullable: true })
  banco?: string;

  @Column({ length: 50, nullable: true })
  numero_cuenta?: string;

  /** Código de moneda ISO (COP, USD...) — campo simple, no FK, para que el
   *  formulario de cuentas pueda guardarlo directamente sin un picker. */
  @Column({ length: 3, default: 'COP' })
  moneda!: string;

  /** Código de cuenta PUC asociada (texto libre, ej "1105") — referencia
   *  informativa para el usuario, no una FK real al plan de cuentas. */
  @Column({ length: 20, nullable: true })
  cuenta_contable?: string;

  @Column({ type: 'text', nullable: true })
  notas?: string;

  @Column({ nullable: true })
  sede_id?: string;

  @ManyToOne(() => Sede, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'sede_id' })
  sede?: Sede;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  saldo_inicial!: number;

  @Column({ default: true })
  activa!: boolean;

  @Column({ length: 500, nullable: true })
  descripcion?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
