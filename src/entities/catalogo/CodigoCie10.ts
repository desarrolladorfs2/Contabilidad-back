/**
 * Catálogo de códigos CIE-10 (Clasificación Internacional de Enfermedades,
 * décima versión) usados en los RIPS de facturación en salud para
 * identificar el diagnóstico de cada servicio (consulta, procedimiento,
 * medicamento, etc.).
 *
 * Se carga una sola vez desde la tabla de referencia que compartió el
 * cliente (Bd_Cargues/TablaReferencia_CIE10__1.xlsx) mediante el script de
 * importación backend/src/scripts/import-cie10.ts (ver
 * backend/src/seeds/data/cie10.csv). No es un seed automático de arranque
 * (a diferencia de catalogo.seed.ts) porque son ~12.600 filas — se importa
 * una sola vez de forma manual, y queda igual de disponible en cada
 * arranque porque vive en la base.
 *
 * Mismo patrón que Municipio.ts y CodigoUnspsc.ts: un id interno (uuid)
 * como llave primaria, y el código real (la "llave natural" que de verdad
 * se usa en el RIPS) como columna indexada y única para buscar rápido por
 * código o por nombre con una sola consulta.
 *
 * El archivo de origen trae 4 columnas (Codigo, Nombre, Descripcion,
 * Habilitado). "Descripcion" en el archivo es en realidad el nombre de la
 * categoría/grupo del diagnóstico (ej. "COLERA" agrupa a A000/A001/A009),
 * no una descripción larga — se guarda tal cual con ese mismo nombre de
 * columna para no inventar un significado distinto al que trae el archivo
 * del cliente.
 *
 * Tabla: cat_codigos_cie10
 */
import {
  Entity, PrimaryGeneratedColumn, Column, Index,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('cat_codigos_cie10')
export class CodigoCie10 {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Código CIE-10 (ej. A000, E109, J00) — el que se usa en el RIPS. */
  @Index({ unique: true })
  @Column({ length: 10 })
  codigo!: string;

  /** Nombre específico del diagnóstico, ya normalizado (sin espacios dobles ni al inicio/final). */
  @Column({ length: 300 })
  nombre!: string;

  /** Nombre de la categoría/grupo al que pertenece el diagnóstico (ej. "COLERA"). */
  @Column({ length: 250 })
  descripcion!: string;

  @Column({ default: true })
  activo!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
