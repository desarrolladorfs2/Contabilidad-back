import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { Company } from '../Company';
import { CuentaPUC } from './CuentaPUC';

/**
 * Parametriza qué cuentas PUC se usan automáticamente para cada tipo de evento.
 * Permite que el motor contable genere asientos sin intervención manual.
 *
 * Ejemplo:
 *   evento = 'venta'           → débito 1305 (Clientes CxC),   crédito 4135 (Ingresos)
 *   evento = 'venta_iva'       → débito 1305,                   crédito 2408 (IVA por pagar)
 *   evento = 'cobro_cliente'   → débito 1110 (Banco),           crédito 1305 (Clientes CxC)
 *   evento = 'descuento_venta' → débito 4175 (Desc. comerciales), crédito 1305 (Clientes CxC)
 */
export type EventoContable =
  | 'venta'
  | 'venta_iva'
  | 'venta_salud'
  | 'cobro_pago_usuario_salud'
  | 'cobro_cliente'
  | 'compra'
  | 'compra_iva'
  | 'pago_proveedor'
  | 'nota_credito_emitida'
  | 'nota_debito_emitida'
  | 'nota_credito_recibida'
  | 'nota_debito_recibida'
  | 'ingreso_tesoreria'
  | 'egreso_tesoreria'
  | 'traslado_tesoreria'
  | 'ajuste_inventario'
  | 'descuento_venta';

@Entity('configuracion_contable')
@Index(['company_id', 'evento'], { unique: true })
export class ConfiguracionContable {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ length: 60 })
  evento!: EventoContable;

  // ── Cuenta que se debita ─────────────────────────────────────────────────
  @Column({ nullable: true })
  cuenta_debito_id?: string;

  @ManyToOne(() => CuentaPUC, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'cuenta_debito_id' })
  cuenta_debito?: CuentaPUC;

  // ── Cuenta que se acredita ───────────────────────────────────────────────
  @Column({ nullable: true })
  cuenta_credito_id?: string;

  @ManyToOne(() => CuentaPUC, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'cuenta_credito_id' })
  cuenta_credito?: CuentaPUC;

  @Column({ length: 500, nullable: true })
  descripcion?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
