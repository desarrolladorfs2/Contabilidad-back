import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';
import { Tercero } from './Tercero';
import { Company } from './Company';

// Contactos de un tercero (cliente o proveedor).
// Un tercero puede tener multiples contactos: gerente, contador, comprador, etc.
// El contacto con is_principal = true es el que se usa por defecto en documentos.
// Tabla: tercero_contactos
@Entity('tercero_contactos')
export class TerceroContacto {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** FK directa a empresa para queries O(1) sin JOIN a Tercero. NOT NULL. */
  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { nullable: false, eager: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column()
  tercero_id!: string;

  @ManyToOne(() => Tercero, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tercero_id' })
  tercero!: Tercero;

  @Column({ length: 200 })
  nombre!: string;

  @Column({ length: 100, nullable: true })
  cargo?: string;

  @Column({ length: 200, nullable: true })
  email?: string;

  @Column({ length: 30, nullable: true })
  telefono?: string;

  @Column({ length: 30, nullable: true })
  celular?: string;

  /** Si true, este contacto se usa por defecto al generar documentos para el tercero */
  @Column({ default: false })
  is_principal!: boolean;

  @Column({ type: 'text', nullable: true })
  notas?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
