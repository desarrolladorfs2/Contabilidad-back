/**
 * Catálogo de códigos UNSPSC (United Nations Standard Products and
 * Services Code) usados por la DIAN para identificar bienes y servicios
 * en la facturación electrónica.
 *
 * Se carga una sola vez desde el archivo oficial que compartió el cliente
 * (Bd_Cargues/Codigos_UNSPSC.xlsm) mediante el script de importación
 * backend/src/scripts/import-unspsc.ts (ver backend/src/seeds/data/unspsc.csv).
 * No es un seed automático de arranque (a diferencia de catalogo.seed.ts)
 * porque son ~49.000 filas — se importa una sola vez de forma manual, y
 * queda igual de disponible en cada arranque porque vive en la base.
 *
 * Se guarda DENORMALIZADO (un solo registro por código, con el nombre y
 * código de cada nivel superior —segmento/familia/clase— como columnas de
 * texto planas, sin tablas ni relaciones separadas por nivel) a propósito:
 * el único código que de verdad se usa en la factura es el del último
 * nivel ("Producto" en el archivo origen, columna ID PRODUCTO), y con
 * ~49.000 filas conviene poder buscarlo por nombre con una sola consulta
 * indexada (igual que se hace hoy con el municipio en Municipio.ts), sin
 * necesidad de resolver 3 tablas relacionadas en cada búsqueda.
 *
 * Tabla: cat_codigos_unspsc
 */
import {
  Entity, PrimaryGeneratedColumn, Column, Index,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('cat_codigos_unspsc')
export class CodigoUnspsc {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Código UNSPSC de 8 dígitos (nivel "Producto" / commodity) — el que se escribe en la factura. */
  @Index({ unique: true })
  @Column({ length: 8 })
  codigo!: string;

  /** Nombre del producto/servicio (nivel "Producto"), ya normalizado (sin espacios dobles ni al inicio/final). */
  @Column({ length: 300 })
  nombre!: string;

  @Column({ length: 8 })
  segmento_codigo!: string;

  @Column({ length: 200 })
  segmento_nombre!: string;

  @Column({ length: 8 })
  familia_codigo!: string;

  @Column({ length: 200 })
  familia_nombre!: string;

  @Column({ length: 8 })
  clase_codigo!: string;

  @Column({ length: 200 })
  clase_nombre!: string;

  @Column({ default: true })
  activo!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
