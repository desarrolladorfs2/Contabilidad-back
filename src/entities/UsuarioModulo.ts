import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { User } from './User';
import { Modulo } from './Modulo';

@Entity('usuario_modulos')
@Index(['user_id', 'modulo_id'], { unique: true })
export class UsuarioModulo {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  user_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column()
  modulo_id!: string;

  @ManyToOne(() => Modulo, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'modulo_id' })
  modulo!: Modulo;

  @Column({ default: true })
  activo!: boolean;

  @CreateDateColumn()
  fecha_asignacion!: Date;

  /** Email del admin que asignó este módulo */
  @Column({ length: 200, nullable: true })
  asignado_por?: string;
}
