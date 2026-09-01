/**
 * Lineas normalizadas de una nota debito.
 * Misma estrategia de doble escritura que InvoiceLinea.
 * DebitNote.lines (JSON) se mantiene para DIAN; esta tabla es para analytics.
 * Tabla: debit_note_lineas
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import { DebitNote } from './DebitNote';
import { Producto } from './Producto';

@Entity('debit_note_lineas')
@Index(['debit_note_id'])
@Index(['producto_id'])
export class DebitNoteLinea {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  debit_note_id!: string;

  @ManyToOne(() => DebitNote, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'debit_note_id' })
  debit_note!: DebitNote;

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
