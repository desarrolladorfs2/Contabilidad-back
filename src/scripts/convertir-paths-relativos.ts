/**
 * convertir-paths-relativos.ts
 *
 * Convierte las rutas de archivos ya guardadas en la base (logo, certificado
 * DIAN, RIPS) de ABSOLUTAS a RELATIVAS a la carpeta de uploads — el cambio
 * que hace que sobrevivan a un despliegue en otro servidor/carpeta. Antes de
 * este cambio, esas rutas se calculaban y guardaban completas en el momento
 * de subir el archivo (ej. "C:\Users\...\backend\uploads\logos\x.png"), y
 * esa ruta exacta normalmente no existe en el servidor donde se despliegue
 * la app después — por eso el logo (y potencialmente el certificado) no
 * cargaba tras un despliegue.
 *
 * Corre contra SQLite (la base activa hoy) y contra MariaDB (FEV, ya
 * migrada) — así ambas quedan consistentes sin importar cuál esté activa
 * cuando se haga el corte definitivo.
 *
 * Es seguro de re-ejecutar: si una ruta ya es relativa, se deja igual.
 *
 * Uso (desde la carpeta backend/):
 *   npx ts-node src/scripts/convertir-paths-relativos.ts
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as path from 'path';

const SQLITE_PATH = path.resolve(__dirname, '..', '..', 'data', 'akribeia.db');

const sqliteDS = new DataSource({
  type: 'better-sqlite3',
  database: SQLITE_PATH,
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

/** true si la ruta parece absoluta (Windows "C:\..." o "C:/..." o Unix "/..."). */
function esAbsoluta(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/');
}

/** Extrae "carpeta/archivo.ext" de una ruta absoluta vieja, asumiendo que la
 *  carpeta inmediata (logos/certificates/rips) es la última carpeta antes
 *  del nombre de archivo — que es exactamente como este código las genera. */
function aRelativa(pAbsoluta: string): string {
  const normalizado = pAbsoluta.replace(/\\/g, '/');
  const partes = normalizado.split('/').filter(Boolean);
  return partes.slice(-2).join('/'); // "logos/xxx.png", "certificates/xxx.pfx", "rips/xxx.json"
}

/** true si la columna ya existe en esa tabla — para SQLite via PRAGMA y para
 *  MariaDB via information_schema. Evita que el script se caiga si alguna
 *  columna todavía no existe en una de las dos bases (ej. porque el esquema
 *  de esa base no se ha sincronizado con la última versión de las entidades). */
async function columnaExiste(ds: DataSource, dialecto: 'SQLite' | 'MariaDB', tabla: string, columna: string): Promise<boolean> {
  if (dialecto === 'SQLite') {
    const info: { name: string }[] = await ds.query(`PRAGMA table_info(${tabla})`);
    return info.some(c => c.name === columna);
  }
  const info: unknown[] = await ds.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'FEV' AND table_name = ? AND column_name = ?`,
    [tabla, columna]
  );
  return info.length > 0;
}

async function convertirTabla(
  ds: DataSource,
  dialecto: 'SQLite' | 'MariaDB',
  tabla: string,
  columnas: string[],
  etiqueta: string
): Promise<void> {
  // Solo se consideran las columnas que de verdad existen en esta base — las
  // que falten se avisan y se omiten, en vez de tumbar el script entero.
  const columnasExistentes: string[] = [];
  for (const col of columnas) {
    if (await columnaExiste(ds, dialecto, tabla, col)) {
      columnasExistentes.push(col);
    } else {
      console.log(`  [${etiqueta}] ${tabla}.${col}: la columna no existe todavía en esta base — se omite (no es un error, solo falta sincronizar el esquema aquí).`);
    }
  }
  if (columnasExistentes.length === 0) return;

  const cols = columnasExistentes.join(', ');
  const rows: Record<string, string | null>[] = await ds.query(`SELECT id, ${cols} FROM ${tabla}`);
  let cambios = 0;
  for (const row of rows) {
    for (const col of columnasExistentes) {
      const val = row[col];
      if (val && esAbsoluta(val)) {
        const nueva = aRelativa(val);
        await ds.query(`UPDATE ${tabla} SET ${col} = ? WHERE id = ?`, [nueva, row.id]);
        console.log(`  [${etiqueta}] ${tabla}.${col} (id ${row.id}): "${val}" → "${nueva}"`);
        cambios++;
      }
    }
  }
  if (cambios === 0) console.log(`  [${etiqueta}] ${tabla}: nada que convertir (ya son relativas o vacías).`);
}

async function main(): Promise<void> {
  console.log('Conectando a SQLite...');
  await sqliteDS.initialize();
  console.log('✅ SQLite conectado.\n');

  console.log('Conectando a MariaDB (FEV)...');
  await mariaDS.initialize();
  console.log('✅ MariaDB conectado.\n');

  for (const [ds, etiqueta] of [[sqliteDS, 'SQLite'], [mariaDS, 'MariaDB']] as const) {
    console.log(`── ${etiqueta} ──`);
    await convertirTabla(ds, etiqueta, 'company_settings', ['cert_path', 'logo_path', 'logo_pdf_path', 'logo_app_path', 'logo_watermark_path'], etiqueta);
    await convertirTabla(ds, etiqueta, 'salud_facturas', ['rips_json_path'], etiqueta);
    console.log();
  }

  console.log('Listo. Las rutas ya quedan portátiles entre entornos.');

  await sqliteDS.destroy();
  await mariaDS.destroy();
}

main().catch(e => { console.error('❌ Error:', e); process.exit(1); });
