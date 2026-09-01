import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, ManyToOne, OneToMany, JoinColumn,
} from 'typeorm';

@Entity('modulos')
export class Modulo {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Codigo unico legible: 'comercial', 'facturas', 'salud-eps', etc. */
  @Column({ length: 80, unique: true })
  codigo!: string;

  @Column({ length: 120 })
  nombre!: string;

  @Column({ length: 300, nullable: true })
  descripcion?: string;

  /** true = es submodulo, false = modulo principal */
  @Column({ default: false })
  es_submodulo!: boolean;

  /** FK al modulo padre. null = modulo raiz */
  @Column({ nullable: true })
  modulo_padre_id?: string;

  @ManyToOne(() => Modulo, (m) => m.submodulos, { nullable: true, eager: false, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'modulo_padre_id' })
  modulo_padre?: Modulo;

  @OneToMany(() => Modulo, (m) => m.modulo_padre)
  submodulos?: Modulo[];

  /** Para ordenar en el menu y en la plantilla Excel */
  @Column({ default: 0 })
  orden!: number;

  /** Icono Tabler (ti-...) para el futuro UI */
  @Column({ length: 80, nullable: true })
  icono?: string;

  @Column({ default: true })
  activo!: boolean;

  @CreateDateColumn()
  created_at!: Date;
}
