import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  ManyToOne, OneToMany, ManyToMany, JoinColumn, JoinTable, Index,
} from 'typeorm';
import { Company } from '../Company';
import { Sede } from './Sede';

@Entity('centros_costo')
@Index(['company_id', 'codigo'], { unique: true })
export class CentroCosto {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ length: 20 })
  codigo!: string;

  @Column({ length: 200 })
  nombre!: string;

  @Column({ length: 500, nullable: true })
  descripcion?: string;

  @Column({ nullable: true })
  padre_id?: string;

  @ManyToOne(() => CentroCosto, cc => cc.hijos, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'padre_id' })
  padre?: CentroCosto;

  @OneToMany(() => CentroCosto, cc => cc.padre)
  hijos?: CentroCosto[];

  /**
   * Sedes en las que opera este centro de costo (muchos a muchos).
   * La ciudad NO se guarda aqui: se deriva en tiempo real de `sede.municipio`
   * para no duplicar el dato y evitar que quede desactualizado si la sede cambia de municipio.
   */
  @ManyToMany(() => Sede)
  @JoinTable({
    name: 'centro_costo_sedes',
    joinColumn:        { name: 'centro_costo_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'sede_id',          referencedColumnName: 'id' },
  })
  sedes?: Sede[];

  @Column({ default: true })
  activo!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
