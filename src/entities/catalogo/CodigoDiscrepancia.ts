/**
 * Codigos de discrepancia DIAN para notas credito y debito.
 * Compartido entre modulo comercial y modulo salud.
 * Fuente: Resolucion DIAN - Anexo tecnico factura electronica.
 * Tabla: cat_codigos_discrepancia
 */
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/** Tipo de nota al que aplica el codigo de discrepancia */
export type TipoNotaDiscrepancia = 'credito' | 'debito' | 'ambos';

@Entity('cat_codigos_discrepancia')
export class CodigoDiscrepancia {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Codigo numerico DIAN (1, 2, 3...) */
  @Column({ length: 5, unique: true })
  codigo!: string;

  @Column({ length: 200 })
  descripcion!: string;

  /** A que tipo de nota aplica */
  @Column({ length: 10, default: 'ambos' })
  tipo_nota!: TipoNotaDiscrepancia;

  @Column({ default: true })
  activo!: boolean;

  @Column({ default: 0 })
  orden!: number;
}
