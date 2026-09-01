/**
 * Precio de un producto dentro de una lista de precios.
 * Relación N:M entre Producto y ListaPrecio con datos adicionales (precio, descuento).
 *
 * Si un producto no tiene fila en la lista activa, se usa Producto.precio_base.
 *
 * Tabla: producto_precios
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Unique,
} from 'typeorm';
import { ListaPrecio } from './ListaPrecio';
import { Producto } from './Producto';

@Entity('producto_precios')
@Unique(['lista_precio_id', 'producto_id'])
export class ProductoPrecio {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  lista_precio_id!: string;

  @ManyToOne(() => ListaPrecio, (lp) => lp.precios, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'lista_precio_id' })
  lista_precio!: ListaPrecio;

  @Column()
  producto_id!: string;

  @ManyToOne(() => Producto, { onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'producto_id' })
  producto!: Producto;

  /** Precio específico para esta lista. Reemplaza Producto.precio_base. */
  @Column({ type: 'decimal', precision: 18, scale: 4 })
  precio!: number;

  /** Descuento porcentual adicional sobre este precio (0–100). Default 0. */
  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  descuento_pct!: number;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
