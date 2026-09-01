/**
 * Reemplazo total de los terceros de Neurum AP a partir de la base de
 * terceros de SIESA que compartió el cliente
 * (Bd_Cargues/BD TERCEROS SIESA (1).xlsx, depurada por el cliente en
 * Bd_Cargues/BD TERCEROS SIESA.xlsx), ya limpia y convertida en
 * backend/src/seeds/data/terceros_neurum_ap_siesa.csv.
 *
 * A diferencia de import-cie10.ts / import-unspsc.ts (que son catálogos
 * globales e idempotentes), este script SÍ borra todo lo que ya exista en
 * terceros para la empresa, tal como pidió el cliente explícitamente
 * ("no importa la trazabilidad de lo viejo, seguimos en el ambiente de
 * pruebas") — mismo criterio que se usó para el reemplazo de centros de
 * costo en la entrega 31 (ver import-centros-costo-siesa.ts).
 *
 * El CSV de origen ya viene con el tipo de documento traducido del código
 * numérico de SIESA al código que usa esta app (CC, NIT, CE, TI, RC, PP,
 * DE, PT, TE) — ver Cambios/40_terceros_siesa_neurum_ap.txt para el
 * detalle completo de cómo se hizo esa traducción y qué registros quedaron
 * fuera (backend/src/seeds/data/... revisar aparte, no se cargan aquí).
 *
 * Uso: npx ts-node src/scripts/import-terceros-siesa.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { AppDataSource } from '../config/database';
import { Tercero } from '../entities/Tercero';

const COMPANY_ID = '4d601ecc-af71-467c-974b-7529971df0bb'; // Neurum AP
const CSV_PATH = path.join(__dirname, '..', 'seeds', 'data', 'terceros_neurum_ap_siesa.csv');

function backupSqliteIfApplicable(): void {
  const dbType = (process.env.DB_TYPE || 'better-sqlite3');
  if (dbType !== 'better-sqlite3') return;
  const dbPath = path.resolve(process.env.DB_DATABASE || './data/akribeia.db');
  if (!fs.existsSync(dbPath)) return;
  const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dst = `${dbPath}.backup-${ts}-pre-import-terceros-siesa`;
  fs.copyFileSync(dbPath, dst);
  console.log(`[import-terceros-siesa] Respaldo creado antes de importar: ${path.basename(dst)}`);
}

/** Parser CSV mínimo — igual que en import-cie10.ts / import-unspsc.ts. */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  const headers = splitCsvLine(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = cols[idx] ?? ''; });
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = ''; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`No se encontró el archivo ${CSV_PATH}.`);
  }
  backupSqliteIfApplicable();
  console.log('[import-terceros-siesa] Leyendo CSV...');
  const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf-8'));
  console.log(`[import-terceros-siesa] ${rows.length} terceros leídos del CSV.`);

  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(Tercero);

  const borrados = await repo.delete({ company_id: COMPANY_ID });
  console.log(`[import-terceros-siesa] Terceros existentes borrados: ${borrados.affected ?? 0}`);

  const BATCH = 500;
  let creados = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const lote: Partial<Tercero>[] = rows.slice(i, i + BATCH).map(r => ({
      company_id:          COMPANY_ID,
      nit:                 r['nit'],
      nit_dv:              r['nit_dv'] || undefined,
      tipo_id:             r['tipo_id'],
      nombre:              r['nombre'],
      primer_nombre:       r['primer_nombre'] || undefined,
      segundo_nombre:      r['segundo_nombre'] || undefined,
      primer_apellido:     r['primer_apellido'] || undefined,
      segundo_apellido:    r['segundo_apellido'] || undefined,
      telefono:            r['telefono'] || undefined,
      direccion:           r['direccion'] || undefined,
      ciudad_codigo:       r['ciudad_codigo'] || undefined,
      ciudad_nombre:       r['ciudad_nombre'] || undefined,
      departamento_codigo: r['departamento_codigo'] || undefined,
      departamento_nombre: r['departamento_nombre'] || undefined,
      pais_codigo:         r['pais_codigo'] || undefined,
      pais_nombre:         r['pais_nombre'] || undefined,
      es_cliente:          r['es_cliente'] === 'true',
      es_proveedor:        r['es_proveedor'] === 'true',
      activo:              r['activo'] === 'true',
      notas:               r['notas'] || undefined,
    }));
    await repo.insert(lote as any);
    creados += lote.length;
    if ((i / BATCH) % 20 === 0) console.log(`[import-terceros-siesa] Progreso: ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }

  console.log(`[import-terceros-siesa] Completado: ${creados} tercero(s) creado(s).`);
  const total = await repo.count({ where: { company_id: COMPANY_ID } });
  console.log(`[import-terceros-siesa] Total de terceros en Neurum AP: ${total}`);
  await AppDataSource.destroy();
}

main().catch(e => { console.error(e); process.exit(1); });
