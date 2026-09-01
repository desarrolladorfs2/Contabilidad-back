/**
 * restaurar-rips-omitidos.ts
 *
 * Mueve los RIPS que quedaron exportados a .txt (por ser demasiado grandes
 * para MariaDB) a la carpeta de almacenamiento en disco definitiva
 * (uploads/rips/, ver rips-storage.service.ts) y actualiza la fila
 * correspondiente en MariaDB para que quede apuntando a ese archivo
 * (rips_json_path), en vez de quedar en NULL.
 *
 * Uso (desde la carpeta backend/):
 *   npx ts-node src/scripts/restaurar-rips-omitidos.ts
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as path from 'path';
import * as fs from 'fs';
import { saveRipsJson } from '../services/rips-storage.service';

const ENTITIES_GLOB = path.join(__dirname, '..', 'entities', '**', '*.{ts,js}');
const SQLITE_PATH = path.resolve(__dirname, '..', '..', 'data', 'akribeia.db');
const OVERSIZED_DIR = path.resolve(__dirname, '..', '..', 'migracion-valores-omitidos');

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

const MARIA_HOST = 'pruebas-produccionhealthsphere.ce6agou8m1rx.us-east-1.rds.amazonaws.com';
const mariaDS = new DataSource({
  type: 'mariadb',
  host: MARIA_HOST,
  port: 3306,
  username: 'admin',
  password: 'Neurum*2025',
  database: 'FEV',
  charset: 'utf8mb4_unicode_ci',
  synchronize: false,
  logging: false,
});

async function main(): Promise<void> {
  await sqliteDS.initialize();
  await mariaDS.initialize();
  console.log('✅ Conectado a SQLite y a MariaDB (FEV)\n');

  for (const id of IDS) {
    const [row] = await sqliteDS.query(
      `SELECT id, company_id, rips_filename FROM salud_facturas WHERE id = ?`,
      [id]
    );
    if (!row) {
      console.log(`⚠️  ${id}: no se encontró en SQLite, se omite.`);
      continue;
    }

    const archivoExportado = path.join(OVERSIZED_DIR, `salud_facturas__rips_json__${id}.txt`);
    if (!fs.existsSync(archivoExportado)) {
      console.log(`⚠️  ${id}: no existe el archivo exportado (${archivoExportado}), se omite.`);
      continue;
    }

    const contenido = fs.readFileSync(archivoExportado, 'utf8');
    const nuevaRuta = saveRipsJson(row.company_id, row.id, contenido);

    await mariaDS.query(
      `UPDATE salud_facturas SET rips_json_path = ? WHERE id = ?`,
      [nuevaRuta, id]
    );

    console.log(`✅ ${id} (${row.rips_filename || 'sin nombre'}) → ${nuevaRuta}`);
  }

  console.log('\nListo. Estas facturas ya pueden descargar su RIPS normalmente desde la app.');

  await sqliteDS.destroy();
  await mariaDS.destroy();
}

main().catch(e => { console.error('❌ Error:', e); process.exit(1); });
