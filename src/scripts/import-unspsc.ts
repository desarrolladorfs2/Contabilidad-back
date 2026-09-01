/**
 * Carga (o actualiza) el catálogo de códigos UNSPSC en la tabla
 * cat_codigos_unspsc, a partir del archivo que compartió el cliente
 * (Bd_Cargues/Codigos_UNSPSC.xlsm), ya limpio y convertido a CSV en
 * backend/src/seeds/data/unspsc.csv (sin espacios dobles ni al inicio/
 * final en los nombres — el archivo original sí los tenía).
 *
 * Idempotente: se puede correr varias veces sin duplicar — si el código
 * ya existe, actualiza sus nombres; si no existe, lo crea.
 *
 * Solo se corre contra la base SQLite de desarrollo. Cuando se decida
 * migrar el catálogo a AWS/producción, se corre este mismo script allá
 * (con las variables de entorno de esa base), por instrucción explícita
 * del usuario de no tocar producción hasta que lo autorice.
 *
 * Uso: npx ts-node src/scripts/import-unspsc.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { AppDataSource } from '../config/database';
import { CodigoUnspsc } from '../entities/catalogo/CodigoUnspsc';

const CSV_PATH = path.join(__dirname, '..', 'seeds', 'data', 'unspsc.csv');

/**
 * Respaldo manual del archivo SQLite antes de tocarlo — este script llama a
 * AppDataSource.initialize() directo (no pasa por initDatabase() en
 * config/database.ts), así que no hereda el backup automático que sí corre
 * cuando se arranca el backend normal. Se replica aquí para no perder esa
 * protección justo en el script que va a crear/llenar una tabla nueva.
 */
function backupSqliteIfApplicable(): void {
  const dbType = (process.env.DB_TYPE || 'better-sqlite3');
  if (dbType !== 'better-sqlite3') return;
  const dbPath = path.resolve(process.env.DB_DATABASE || './data/akribeia.db');
  if (!fs.existsSync(dbPath)) return;
  const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dst = `${dbPath}.backup-${ts}-pre-import-unspsc`;
  fs.copyFileSync(dbPath, dst);
  console.log(`[import-unspsc] Respaldo creado antes de importar: ${path.basename(dst)}`);
}

/** Parser CSV mínimo — suficiente para este archivo (comillas dobles para escapar comas). */
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
    throw new Error(`No se encontró el archivo ${CSV_PATH}. Corre este script desde el backend con el archivo unspsc.csv presente.`);
  }
  backupSqliteIfApplicable();
  console.log('[import-unspsc] Leyendo CSV...');
  const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf-8'));
  console.log(`[import-unspsc] ${rows.length} códigos leídos del CSV.`);

  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(CodigoUnspsc);

  const existentes = await repo.find({ select: ['id', 'codigo'] });
  const porCodigo = new Map(existentes.map(e => [e.codigo, e.id]));

  const BATCH = 500;
  let creados = 0, actualizados = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const lote = rows.slice(i, i + BATCH);
    const aInsertar: Partial<CodigoUnspsc>[] = [];
    const aActualizar: Partial<CodigoUnspsc>[] = [];

    for (const r of lote) {
      const data: Partial<CodigoUnspsc> = {
        codigo:           r['codigo'],
        nombre:           r['nombre'],
        segmento_codigo:  r['segmento_codigo'],
        segmento_nombre:  r['segmento_nombre'],
        familia_codigo:   r['familia_codigo'],
        familia_nombre:   r['familia_nombre'],
        clase_codigo:     r['clase_codigo'],
        clase_nombre:     r['clase_nombre'],
        activo:           true,
      };
      const existingId = porCodigo.get(r['codigo']);
      if (existingId) aActualizar.push({ ...data, id: existingId });
      else aInsertar.push(data);
    }

    if (aInsertar.length) {
      await repo.insert(aInsertar as CodigoUnspsc[]);
      creados += aInsertar.length;
    }
    for (const upd of aActualizar) {
      const { id, ...rest } = upd;
      await repo.update({ id }, rest);
    }
    actualizados += aActualizar.length;

    if ((i / BATCH) % 20 === 0) {
      console.log(`[import-unspsc] Progreso: ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
    }
  }

  console.log(`[import-unspsc] Completado: ${creados} código(s) nuevo(s) creado(s), ${actualizados} actualizado(s).`);
  const total = await repo.count();
  console.log(`[import-unspsc] Total de códigos en cat_codigos_unspsc: ${total}`);
  await AppDataSource.destroy();
}

main().catch(e => { console.error(e); process.exit(1); });
