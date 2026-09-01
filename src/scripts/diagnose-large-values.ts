/**
 * diagnose-large-values.ts
 *
 * Diagnóstico de solo lectura contra el SQLite local (no toca MariaDB ni la
 * red) para saber exactamente qué tan grandes son los valores de texto en
 * `salud_facturas` (o cualquier tabla que se pase como argumento), columna
 * por columna, y así decidir a qué valor subir `max_allowed_packet` en el
 * parameter group de RDS.
 *
 * Uso (desde la carpeta backend/):
 *   npx ts-node src/scripts/diagnose-large-values.ts salud_facturas
 *   npx ts-node src/scripts/diagnose-large-values.ts   (sin argumento: usa salud_facturas)
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as path from 'path';

const ENTITIES_GLOB = path.join(__dirname, '..', 'entities', '**', '*.{ts,js}');
const SQLITE_PATH = path.resolve(__dirname, '..', '..', 'data', 'akribeia.db');

const sqliteDS = new DataSource({
  type: 'better-sqlite3',
  database: SQLITE_PATH,
  entities: [ENTITIES_GLOB],
  synchronize: false,
  logging: false,
});

function ident(id: string): string {
  return '`' + id.replace(/`/g, '``') + '`';
}

async function main(): Promise<void> {
  const tabla = process.argv[2] || 'salud_facturas';
  console.log(`Origen (SQLite): ${SQLITE_PATH}`);
  console.log(`Tabla a analizar: ${tabla}\n`);

  await sqliteDS.initialize();
  console.log('✅ SQLite conectado.\n');

  const rows: Record<string, unknown>[] = await sqliteDS.query(`SELECT * FROM ${ident(tabla)}`);
  console.log(`${rows.length} filas encontradas.\n`);

  if (rows.length === 0) {
    console.log('(tabla vacía, nada que reportar)');
    await sqliteDS.destroy();
    return;
  }

  const cols = Object.keys(rows[0]);
  const maxPorColumna: Record<string, { maxBytes: number; idFila: unknown }> = {};

  for (const col of cols) {
    maxPorColumna[col] = { maxBytes: 0, idFila: null };
  }

  for (const row of rows) {
    for (const col of cols) {
      const val = row[col];
      if (typeof val === 'string') {
        const bytes = Buffer.byteLength(val, 'utf8');
        if (bytes > maxPorColumna[col].maxBytes) {
          maxPorColumna[col] = { maxBytes: bytes, idFila: row['id'] ?? '(sin columna id)' };
        }
      }
    }
  }

  const ordenado = Object.entries(maxPorColumna)
    .filter(([, v]) => v.maxBytes > 0)
    .sort((a, b) => b[1].maxBytes - a[1].maxBytes);

  console.log('════════ Tamaño máximo por columna (solo columnas de texto) ════════');
  for (const [col, v] of ordenado) {
    const mb = (v.maxBytes / 1024 / 1024).toFixed(2);
    console.log(`${col.padEnd(35)} ${mb.padStart(10)} MB   (fila id=${v.idFila})`);
  }
  console.log('══════════════════════════════════════════════════════════════════\n');

  // También: tamaño total de la fila más pesada (todas las columnas grandes sumadas)
  let filaMasPesadaBytes = 0;
  let filaMasPesadaId: unknown = null;
  for (const row of rows) {
    let total = 0;
    for (const col of cols) {
      const val = row[col];
      if (typeof val === 'string') total += Buffer.byteLength(val, 'utf8');
    }
    if (total > filaMasPesadaBytes) {
      filaMasPesadaBytes = total;
      filaMasPesadaId = row['id'] ?? '(sin columna id)';
    }
  }
  console.log(`Fila más pesada en total: id=${filaMasPesadaId}, ${(filaMasPesadaBytes / 1024 / 1024).toFixed(2)} MB (todas sus columnas de texto sumadas)`);

  const maxColumnaSola = ordenado[0]?.[1].maxBytes || 0;
  const sugerido = Math.max(67108864, Math.pow(2, Math.ceil(Math.log2(maxColumnaSola * 1.5 || 1))));
  console.log(`\nSugerencia para max_allowed_packet en el parameter group de RDS: al menos ${(sugerido / 1024 / 1024).toFixed(0)} MB`);

  await sqliteDS.destroy();
}

main().catch(e => {
  console.error('❌ Error:', e);
  process.exit(1);
});
