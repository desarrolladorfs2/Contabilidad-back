/**
 * identificar-facturas-omitidas.ts
 *
 * Muestra los datos identificatorios (numero, status, eps, fecha) de las
 * facturas de salud cuyo rips_json quedó omitido en la migración a MariaDB,
 * para saber si ya fueron transmitidas a la DIAN o siguen en borrador.
 * Solo lee el SQLite local — no toca red ni MariaDB.
 *
 * Uso: npx ts-node src/scripts/identificar-facturas-omitidas.ts
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as path from 'path';

const ENTITIES_GLOB = path.join(__dirname, '..', 'entities', '**', '*.{ts,js}');
const SQLITE_PATH = path.resolve(__dirname, '..', '..', 'data', 'akribeia.db');

const IDS = [
  '09b4cfcc-cb79-4d7a-b8fd-b4cd0cd3d9bc',
  'b785f1ac-deb4-4ef6-b661-8be1736a333d',
  '40ee22c9-48aa-4ecb-84ed-82497a6ce606',
];

const sqliteDS = new DataSource({
  type: 'better-sqlite3',
  database: SQLITE_PATH,
  entities: [ENTITIES_GLOB],
  synchronize: false,
  logging: false,
});

async function main(): Promise<void> {
  await sqliteDS.initialize();
  const placeholders = IDS.map(() => '?').join(',');
  const rows = await sqliteDS.query(
    `SELECT id, invoice_number, status, tipo, issue_date, eps_id, created_by_name
     FROM salud_facturas WHERE id IN (${placeholders})`,
    IDS
  );
  console.table(rows);
  await sqliteDS.destroy();
}

main().catch(e => { console.error('❌ Error:', e); process.exit(1); });
