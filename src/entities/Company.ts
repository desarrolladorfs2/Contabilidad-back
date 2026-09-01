import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, OneToMany, OneToOne, ManyToOne, JoinColumn,
} from 'typeorm';
import { CompanySettings } from './CompanySettings';
import { Factura } from './Invoice';
import { ReceivedInvoice } from './ReceivedInvoice';
import { User } from './User';
import { Plan } from './Plan';
import { CompanyResponsabilidad } from './CompanyResponsabilidad';

/**
 * Empresa / Tenant.
 * Cada empresa es un cliente independiente del SaaS.
 * Toda la informacion de operacion (facturas, usuarios, modulos) esta aislada por company_id.
 */
@Entity('companies')
export class Company {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Identificacion tributaria
  @Column({ length: 20 })
  nit!: string;

  @Column({ length: 2, nullable: true })
  nit_dv?: string;

  /** Tipo de persona segun DIAN. Natural key -> cat_tipos_persona.codigo: 'natural' | 'juridica' */
  @Column({ length: 10, nullable: true })
  tipo_persona?: string;

  // Razon social y nombre
  @Column({ length: 200 })
  name!: string;

  @Column({ length: 200, nullable: true })
  trade_name?: string;

  /**
   * Responsabilidad tributaria principal DIAN (retrocompatibilidad XML DIAN).
   * Natural key -> cat_responsabilidades_fiscales.codigo
   * Para multiples responsabilidades simultaneas usar la tabla company_responsabilidades.
   */
  @Column({ length: 100, default: 'R-99-PN' })
  tax_level_code!: string;

  // Contacto y ubicacion
  @Column({ length: 300, nullable: true })
  address?: string;

  /** Codigo DANE del municipio: 11001, 05001... Natural key -> cat_municipios.codigo_dane */
  @Column({ length: 10, nullable: true })
  city_code?: string;

  @Column({ length: 150, nullable: true })
  city_name?: string;

  /** Codigo DANE del departamento: 11, 05... Natural key -> cat_departamentos.codigo_dane */
  @Column({ length: 10, nullable: true })
  department_code?: string;

  @Column({ length: 150, nullable: true })
  department_name?: string;

  @Column({ length: 150, nullable: true })
  email?: string;

  @Column({ length: 30, nullable: true })
  phone?: string;

  // Estado
  @Column({ default: true })
  activo!: boolean;

  // Plan de suscripcion
  @Column({ nullable: true })
  plan_id?: string;

  @ManyToOne(() => Plan, { nullable: true, eager: false })
  @JoinColumn({ name: 'plan_id' })
  plan?: Plan;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  // Relaciones
  @OneToOne(() => CompanySettings, (cs) => cs.company, { nullable: true })
  settings?: CompanySettings;

  @OneToMany(() => Factura, (f) => f.company)
  facturas?: Factura[];

  @OneToMany(() => ReceivedInvoice, (ri) => ri.company)
  received_invoices?: ReceivedInvoice[];

  @OneToMany(() => User, (u) => u.company)
  users?: User[];

  @OneToMany(() => CompanyResponsabilidad, (r) => r.company, { cascade: false })
  responsabilidades?: CompanyResponsabilidad[];
}
