/**
 * Lista de precios por empresa.
 * Permite manejar diferentes precios por segmento de cliente:
 * "Lista General", "Lista Distribuidores", "Lista Exportación (USD)", etc.
 *
 * La lista marcada como es_defecto se usa cuando un tercero no tiene lista asignada.
 * La moneda_codigo es natural key → cat_monedas.codigo_iso (COP, USD, EUR…)
 *
 * Tabla: listas_precio
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, OneToMany,
} from 'typeorm';
import { Company } from './Company';
import { ProductoPrecio } from './ProductoPrecio';

@Entity('listas_precio')
export class ListaPrecio {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ length: 200 })
  nombre!: string;

  @Column({ type: 'text', nullable: true })
  descripcion?: string;

  /**
   * Código ISO 4217 de la moneda de esta lista.
   * Natural key → cat_monedas.codigo_iso
   */
  @Column({ length: 3, default: 'COP' })
  moneda_codigo!: string;

  /**
   * Si true, esta lista se usa cuando el tercero no tiene lista asignada.
   * Solo debe haber una lista por defecto activa por empresa.
   */
  @Column({ default: false })
  es_defecto!: boolean;

  @Column({ default: true })
  activo!: boolean;

  @Column({ type: 'date', nullable: true })
  fecha_inicio?: string;

  @Column({ type: 'date', nullable: true })
  fecha_fin?: string;

  @Column({ type: 'text', nullable: true })
  notas?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  @OneToMany(() => ProductoPrecio, (pp) => pp.lista_precio, { cascade: true })
  precios?: ProductoPrecio[];
}
