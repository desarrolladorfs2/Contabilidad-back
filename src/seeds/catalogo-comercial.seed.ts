/**
 * Seed de catálogos del módulo comercial.
 * Datos de referencia: medios de pago (DIAN), unidades de medida (UN/CEFACT),
 * monedas (ISO 4217), tipos de persona (DIAN), tipos de tributo (DIAN).
 *
 * Idempotente — no duplica ni borra registros existentes.
 * Se ejecuta al iniciar el backend junto con seedCatalogo y seedPlanes.
 */
import { DataSource, DeepPartial } from 'typeorm';
import { MedioPago } from '../entities/catalogo/MedioPago';
import { UnidadMedida } from '../entities/catalogo/UnidadMedida';
import { Moneda } from '../entities/catalogo/Moneda';
import { TipoPersona } from '../entities/catalogo/TipoPersona';
import { TipoTributo } from '../entities/catalogo/TipoTributo';

// ── Medios de pago — estándar DIAN Colombia ───────────────────────────────────
// Fuente: Anexo técnico DIAN — tabla de medios de pago UBL
const MEDIOS_PAGO = [
  { codigo: '1',  nombre: 'Instrumento no definido',     descripcion: 'Medio de pago no especificado',                       orden: 0 },
  { codigo: '10', nombre: 'Efectivo',                    descripcion: 'Pago en efectivo',                                     orden: 1 },
  { codigo: '20', nombre: 'Cheque',                      descripcion: 'Cheque bancario',                                      orden: 2 },
  { codigo: '42', nombre: 'Débito bancario',             descripcion: 'Débito automático desde cuenta bancaria',              orden: 3 },
  { codigo: '47', nombre: 'Transferencia crédito',       descripcion: 'Transferencia bancaria (PSE, ACH, interbancaria)',     orden: 4 },
  { codigo: '48', nombre: 'Tarjeta débito',              descripcion: 'Pago con tarjeta débito',                              orden: 5 },
  { codigo: '49', nombre: 'Tarjeta crédito',             descripcion: 'Pago con tarjeta crédito',                             orden: 6 },
  { codigo: 'ZZZ', nombre: 'Otro medio de pago',         descripcion: 'Medios no clasificados en los códigos anteriores',    orden: 7 },
];

// ── Unidades de medida — estándar UN/CEFACT ───────────────────────────────────
// Fuente: United Nations Centre for Trade Facilitation and Electronic Business
// Solo se incluyen las más comunes en Colombia. El código va literalmente en XML DIAN.
const UNIDADES_MEDIDA = [
  { codigo: 'EA',  nombre: 'Unidad',           simbolo: 'und',   orden: 1  },
  { codigo: 'HUR', nombre: 'Hora',             simbolo: 'h',     orden: 2  },
  { codigo: 'DAY', nombre: 'Día',              simbolo: 'día',   orden: 3  },
  { codigo: 'MON', nombre: 'Mes',              simbolo: 'mes',   orden: 4  },
  { codigo: 'ANN', nombre: 'Año',              simbolo: 'año',   orden: 5  },
  { codigo: 'KGM', nombre: 'Kilogramo',        simbolo: 'kg',    orden: 6  },
  { codigo: 'GRM', nombre: 'Gramo',            simbolo: 'g',     orden: 7  },
  { codigo: 'TNE', nombre: 'Tonelada métrica', simbolo: 't',     orden: 8  },
  { codigo: 'MTR', nombre: 'Metro',            simbolo: 'm',     orden: 9  },
  { codigo: 'CMT', nombre: 'Centímetro',       simbolo: 'cm',    orden: 10 },
  { codigo: 'MMT', nombre: 'Milímetro',        simbolo: 'mm',    orden: 11 },
  { codigo: 'KMT', nombre: 'Kilómetro',        simbolo: 'km',    orden: 12 },
  { codigo: 'MTK', nombre: 'Metro cuadrado',   simbolo: 'm²',    orden: 13 },
  { codigo: 'MTQ', nombre: 'Metro cúbico',     simbolo: 'm³',    orden: 14 },
  { codigo: 'LTR', nombre: 'Litro',            simbolo: 'l',     orden: 15 },
  { codigo: 'MLT', nombre: 'Mililitro',        simbolo: 'ml',    orden: 16 },
  { codigo: 'GLI', nombre: 'Galón',            simbolo: 'gal',   orden: 17 },
  { codigo: 'XBX', nombre: 'Caja',             simbolo: 'caja',  orden: 18 },
  { codigo: 'XPK', nombre: 'Paquete',          simbolo: 'paq',   orden: 19 },
  { codigo: 'XPP', nombre: 'Pieza',            simbolo: 'pza',   orden: 20 },
  { codigo: 'SET', nombre: 'Conjunto / Kit',   simbolo: 'kit',   orden: 21 },
  { codigo: 'PR',  nombre: 'Par',              simbolo: 'par',   orden: 22 },
  { codigo: 'DZN', nombre: 'Docena',           simbolo: 'doc',   orden: 23 },
];

// ── Monedas — ISO 4217 ────────────────────────────────────────────────────────
const MONEDAS = [
  { codigo_iso: 'COP', nombre: 'Peso colombiano',      simbolo: '$',   es_defecto: true  },
  { codigo_iso: 'USD', nombre: 'Dólar estadounidense', simbolo: 'US$', es_defecto: false },
  { codigo_iso: 'EUR', nombre: 'Euro',                 simbolo: '€',   es_defecto: false },
  { codigo_iso: 'GBP', nombre: 'Libra esterlina',      simbolo: '£',   es_defecto: false },
  { codigo_iso: 'MXN', nombre: 'Peso mexicano',        simbolo: 'MX$', es_defecto: false },
  { codigo_iso: 'BRL', nombre: 'Real brasileño',       simbolo: 'R$',  es_defecto: false },
  { codigo_iso: 'CLP', nombre: 'Peso chileno',         simbolo: 'CL$', es_defecto: false },
  { codigo_iso: 'PEN', nombre: 'Sol peruano',          simbolo: 'S/',  es_defecto: false },
];

// ── Tipos de persona — DIAN Colombia ─────────────────────────────────────────
const TIPOS_PERSONA = [
  {
    codigo: 'natural',
    nombre: 'Persona Natural',
    descripcion: 'Individuo que ejerce actividades económicas a título personal. Usa CC, CE, PP u otro doc personal.',
  },
  {
    codigo: 'juridica',
    nombre: 'Persona Jurídica',
    descripcion: 'Sociedad, empresa o entidad con existencia legal propia. Usa NIT con dígito de verificación.',
  },
];

// ── Tipos de tributo — códigos DIAN Colombia ──────────────────────────────────
// Fuente: Anexo técnico DIAN — tabla de tributos UBL
const TIPOS_TRIBUTO = [
  {
    codigo: '01',
    nombre: 'IVA',
    descripcion: 'Impuesto sobre las ventas. Tarifas: 0%, 5%, 19%.',
    aplica_ventas: true,
    orden: 1,
  },
  {
    codigo: '04',
    nombre: 'INC',
    descripcion: 'Impuesto Nacional al Consumo. Aplica a restaurantes, bares, telefonía móvil, vehículos. Tarifas: 4%, 8%, 16%.',
    aplica_ventas: true,
    orden: 2,
  },
  {
    codigo: '03',
    nombre: 'ICA',
    descripcion: 'Impuesto de industria, comercio y avisos. Municipal. Se declara directamente ante el municipio.',
    aplica_ventas: false,
    orden: 3,
  },
  {
    codigo: 'ZZ',
    nombre: 'No aplica / Exento',
    descripcion: 'Operación no gravada o exenta de impuesto. Ej: exportaciones, bienes de la canasta familiar.',
    aplica_ventas: true,
    orden: 4,
  },
];

// ── Helper genérico ───────────────────────────────────────────────────────────

async function seedTable<T extends object>(
  ds: DataSource,
  EntityClass: new () => T,
  data: Record<string, unknown>[],
  uniqueField: string,
): Promise<void> {
  const repo = ds.getRepository(EntityClass);
  let insertados = 0;
  for (const item of data) {
    const where = { [uniqueField]: item[uniqueField] } as Record<string, unknown>;
    const existe = await repo.findOne({ where } as Parameters<typeof repo.findOne>[0]);
    if (!existe) {
      await repo.save(repo.create(item as DeepPartial<T>));
      insertados++;
    }
  }
  const tabla = ds.getMetadata(EntityClass).tableName;
  if (insertados > 0) {
    console.log(`[Seed] ${tabla}: ${insertados} registros insertados`);
  }
}

// ── Función principal ─────────────────────────────────────────────────────────

export async function seedCatalogoComercial(ds: DataSource): Promise<void> {
  await seedTable(ds, MedioPago,    MEDIOS_PAGO,    'codigo');
  await seedTable(ds, UnidadMedida, UNIDADES_MEDIDA, 'codigo');
  await seedTable(ds, Moneda,       MONEDAS,        'codigo_iso');
  await seedTable(ds, TipoPersona,  TIPOS_PERSONA,  'codigo');
  await seedTable(ds, TipoTributo,  TIPOS_TRIBUTO,  'codigo');
}
