import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, OneToMany, Unique,
  BeforeInsert, BeforeUpdate,
} from 'typeorm';
import { Company } from './Company';
import { TerceroContacto } from './TerceroContacto';
import { TerceroResponsabilidad } from './TerceroResponsabilidad';
import { CentroCosto } from './contabilidad/CentroCosto';

/** Tipos de documento colombianos que son siempre puramente numéricos. */
const TIPOS_ID_NUMERICOS = new Set(['CC', 'NIT', 'RC', 'TI', 'NUIP']);

/**
 * Deja el número de documento en el formato en que se guarda de verdad, según el
 * tipo de documento — misma lógica para cualquier ruta que cree o edite un
 * tercero (formulario, importación masiva, scripts): CC/NIT/RC/TI/NUIP siempre
 * numéricos (se quitan puntos, espacios, guiones); los tipos de documento
 * extranjero (CE, PP, DE, TE, PT, SIN) se dejan tal como se escribieron, porque
 * legítimamente traen letras (pasaportes, cédulas de extranjería, NIT de otro
 * país...) — ver Cambios/41_documento_extranjero_texto_libre.txt.
 * Exportada para que terceros.routes.ts (importación masiva) pueda usar
 * exactamente la misma regla al revisar si un NIT ya existe, en vez de comparar
 * el texto crudo del archivo contra el valor ya normalizado en la base.
 */
export function normalizarNit(nit: string, tipoId: string): string {
  const esNumerico = TIPOS_ID_NUMERICOS.has(tipoId);
  if (esNumerico) {
    const soloDigitos = String(nit).replace(/\D/g, '');
    return soloDigitos || String(nit).trim();
  }
  return String(nit).trim();
}

// Terceros: clientes y/o proveedores de la empresa.
// Un tercero puede ser ambos simultaneamente (es_cliente + es_proveedor).
// Los campos ciudad_X y departamento_X son snapshots del catalogo DIVIPOLA
// para preservar historial aunque el catalogo cambie.
// Tabla: terceros
@Entity('terceros')
@Unique(['company_id', 'nit'])
export class Tercero {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  // Identificacion tributaria

  @Column({ length: 20 })
  nit!: string;

  /** Digito de verificacion del NIT. Solo aplica cuando tipo_id = 'NIT'. */
  @Column({ length: 2, nullable: true })
  nit_dv?: string;

  /** Natural key -> cat_tipos_documento.codigo. Ej: 'CC', 'NIT', 'CE', 'PP' */
  @Column({ length: 10, default: 'NIT' })
  tipo_id!: string;

  // Nombres

  @Column({ length: 200 })
  nombre!: string;

  @Column({ length: 200, nullable: true })
  nombre_comercial?: string;

  /** Solo persona natural: primer nombre (para cac:Person en XML DIAN) */
  @Column({ length: 100, nullable: true })
  primer_nombre?: string;

  @Column({ length: 100, nullable: true })
  segundo_nombre?: string;

  @Column({ length: 100, nullable: true })
  primer_apellido?: string;

  @Column({ length: 100, nullable: true })
  segundo_apellido?: string;

  // Contacto

  @Column({ length: 150, nullable: true })
  email?: string;

  @Column({ length: 30, nullable: true })
  telefono?: string;

  @Column({ length: 300, nullable: true })
  direccion?: string;

  // Ubicacion (snapshot DIVIPOLA)

  /** Codigo DANE del municipio. Natural key -> cat_municipios.codigo_dane */
  @Column({ length: 10, nullable: true })
  ciudad_codigo?: string;

  @Column({ length: 150, nullable: true })
  ciudad_nombre?: string;

  /** Codigo DANE del departamento. Natural key -> cat_departamentos.codigo_dane */
  @Column({ length: 10, nullable: true })
  departamento_codigo?: string;

  @Column({ length: 150, nullable: true })
  departamento_nombre?: string;

  /** Codigo ISO del pais. Snapshot, igual que ciudad/departamento. Default Colombia (CO). */
  @Column({ length: 5, nullable: true, default: 'CO' })
  pais_codigo?: string;

  @Column({ length: 100, nullable: true, default: 'Colombia' })
  pais_nombre?: string;

  /** Natural key -> cat_responsabilidades_fiscales.codigo. Ej: 'R-99-PN', 'O-13'
   *  Se mantiene para retrocompatibilidad con el XML DIAN (responsabilidad principal).
   *  Para multiples responsabilidades usar la tabla tercero_responsabilidades. */
  @Column({ length: 20, default: 'R-99-PN' })
  nivel_tributario!: string;

  /** Natural key -> cat_actividades_economicas.codigo_ciiu. Ej: '4669' */
  @Column({ length: 10, nullable: true })
  actividad_economica_codigo?: string;

  // Roles
  @Column({ default: true })
  es_cliente!: boolean;

  @Column({ default: false })
  es_proveedor!: boolean;

  // Estado
  @Column({ default: true })
  activo!: boolean;

  /** Centro de costo asignado (opcional). Ver Cambios/47_centro_costo_terceros.txt */
  @Column({ nullable: true })
  centro_costo_id?: string;

  @ManyToOne(() => CentroCosto, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'centro_costo_id' })
  centro_costo?: CentroCosto;

  @Column({ type: 'text', nullable: true })
  notas?: string;

  // Retención en la fuente
  /** Si true, el cliente aplica retención en la fuente sobre las facturas. */
  @Column({ default: false })
  tiene_retencion!: boolean;

  /** Porcentaje de retención en la fuente. Ej: 3.5 para 3.5% */
  @Column({ type: 'decimal', precision: 6, scale: 2, default: 0 })
  tarifa_retencion!: number;

  /** Descripción del concepto de retención. Ej: "Retención servicios 4%" */
  @Column({ length: 200, nullable: true })
  concepto_retencion?: string;


  /** Usuario que creó el registro. Desnormalizado: sobrevive borrado/renombrado de usuario. */
  @Column({ nullable: true })
  created_by_user_id?: string;

  @Column({ length: 120, nullable: true })
  created_by_name?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  // Relaciones
  @OneToMany(() => TerceroContacto, (c) => c.tercero, { cascade: false })
  contactos?: TerceroContacto[];

  @OneToMany(() => TerceroResponsabilidad, (r) => r.tercero, { cascade: false })
  responsabilidades?: TerceroResponsabilidad[];

  /**
   * Normaliza nit/nit_dv/email en un único punto (hook de entidad), sin importar por
   * qué ruta se guarde el registro (creación, edición, importación masiva, seeds,
   * scripts). Antes esta lógica estaba duplicada de forma parcial en terceros.routes.ts
   * — ver hallazgo #15/#11. Se ejecuta siempre antes de INSERT/UPDATE.
   *
   * - nit: para los tipos de documento colombianos que son siempre numéricos (CC,
   *   NIT, RC, TI, NUIP) se dejan solo dígitos (se quitan puntos, espacios, guiones
   *   que el usuario pueda haber escrito) para que la restricción de unicidad
   *   (company_id, nit) sea efectiva en la práctica, no solo en el esquema.
   *   Para los tipos de documento extranjero (CE, PP, DE, TE, PT, SIN) NO se
   *   limpia nada — esos documentos legítimamente traen letras (pasaportes,
   *   cédulas de extranjería, NIT de otro país, etc.), así que se guardan tal
   *   como se escribieron. Antes esto se limpiaba siempre sin importar el tipo,
   *   lo que le borraba las letras a un documento extranjero real apenas se
   *   editaba el tercero (hallazgo al cargar la base de terceros de SIESA de
   *   Neurum AP, entrega 40 — ver Cambios/41_documento_extranjero_texto_libre.txt).
   * - nit_dv: si viene con algo distinto de un solo dígito, se limpia igual a solo dígitos.
   * - email: trim + minúsculas.
   * - nombre/nombre_comercial: trim (evita duplicados por espacios al inicio/fin).
   */
  @BeforeInsert()
  @BeforeUpdate()
  normalizarDatos(): void {
    if (this.nit != null) {
      this.nit = normalizarNit(this.nit, this.tipo_id);
    }
    if (this.nit_dv != null) {
      const dvDigitos = String(this.nit_dv).replace(/\D/g, '');
      this.nit_dv = dvDigitos || undefined;
    }
    if (this.email != null) {
      const emailTrim = String(this.email).trim().toLowerCase();
      this.email = emailTrim || undefined;
    }
    // Si viene algo en los nombres/apellidos desglosados (persona natural), el
    // nombre completo SIEMPRE se arma a partir de esas partes — igual que ya hacía
    // el formulario de Terceros del frontend (syncNombrePersonaNatural()), que
    // sobreescribe "nombre" cada vez que el usuario edita alguna de esas 4 partes.
    // Antes esa regla solo vivía en el frontend, así que una importación masiva o
    // un script podían guardar un "Nombre" escrito a mano que no coincidiera con
    // los nombres/apellidos reales de la persona (columna 'Nombre' de SIESA vs.
    // 'Apellido1'/'Nombre1', etc. — visto al revisar el export de la entrega 40).
    // Para una empresa (NIT), donde no aplican nombres/apellidos, "nombre" sigue
    // siendo la razón social escrita directamente, sin tocar.
    const partesNombre = [this.primer_nombre, this.segundo_nombre, this.primer_apellido, this.segundo_apellido]
      .filter((p): p is string => !!p && String(p).trim().length > 0)
      .map(p => String(p).trim());
    if (partesNombre.length > 0) {
      this.nombre = partesNombre.join(' ');
    } else if (this.nombre != null) {
      this.nombre = String(this.nombre).trim();
    }
    if (this.nombre_comercial != null) {
      const nc = String(this.nombre_comercial).trim();
      this.nombre_comercial = nc || undefined;
    }
  }
}
