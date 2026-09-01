/**
 * Lineas normalizadas de una nota credito.
 * Misma estrategia de doble escritura que InvoiceLinea.
 * CreditNote.lines (JSON) se mantiene para DIAN; esta tabla es para analytics.
 * Tabla: credit_note_lineas
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { CreditNote } from './CreditNote';
import { Producto } from './Producto';

@Entity('credit_note_lineas')
@Index(['credit_note_id'])
@Index(['producto_id'])
export class CreditNoteLinea {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  credit_note_id!: string;

  @ManyToOne(() => CreditNote, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'credit_note_id' })
  credit_note!: CreditNote;

  @Column({ nullable: true })
  producto_id?: string;

  @ManyToOne(() => Producto, { nullable: true, eager: false })
  @JoinColumn({ name: 'producto_id' })
  producto?: Producto;

  @Column({ default: 1 })
  linea_numero!: number;

  @Column({ length: 500 })
  descripcion!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4 })
  cantidad!: number;

  /** Natural key -> cat_unidades_medida.codigo */
  @Column({ length: 10, default: 'EA' })
  unidad_medida_codigo!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4 })
  precio_unitario!: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  descuento_pct!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  descuento_valor!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  subtotal!: number;

  /** Natural key -> cat_tipos_tributo.codigo */
  @Column({ length: 5, default: 'ZZ' })
  tipo_tributo_codigo!: string;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  tarifa_iva!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  valor_iva!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  valor_inc!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  total!: number;

  @CreateDateColumn()
  created_at!: Date;
}
