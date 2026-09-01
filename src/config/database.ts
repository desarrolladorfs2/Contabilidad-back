import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { seedModulos } from '../seeds/modulos.seed';
import { seedCatalogo } from '../seeds/catalogo.seed';
import { seedPlanes } from '../seeds/planes.seed';
import { seedPlanModulo } from '../seeds/plan-modulo.seed';
import { seedCatalogoComercial } from '../seeds/catalogo-comercial.seed';
import { seedDemoComercial } from '../seeds/demo-comercial.seed';
import { backfillInvoiceLineas } from '../seeds/backfill-invoice-lineas.seed';
import { backfillLineaAsientoCuentaId } from '../seeds/backfill-linea-asiento-cuenta-id.seed';
import { seedResponsabilidadesBackfill } from '../seeds/responsabilidades-backfill.seed';
import { seedCatalogoSalud } from '../seeds/catalogo-salud.seed';
import { seedRetencionBackfill } from '../seeds/retencion-backfill.seed';
import { seedNovedades } from '../seeds/novedades.seed';

dotenv.config();

function buildDataSourceOptions(): DataSourceOptions {
  const dbType = (process.env.DB_TYPE || 'better-sqlite3') as 'better-sqlite3' | 'mariadb' | 'mysql';

  const base = {
    entities:    [path.join(__dirname, '..', 'entities', '**', '*.{ts,js}')],
    migrations:  [path.join(__dirname, '..', 'migrations', '*.{ts,js}')],
    synchronize: process.env.DB_SYNC === 'true',
    logging:     process.env.NODE_ENV === 'development',
  };

  if (dbType === 'better-sqlite3') {
    const dbPath = path.resolve(process.env.DB_DATABASE || './data/akribeia.db');
    const dbDir  = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    return {
      ...base,
      type:     'better-sqlite3',
      database: dbPath,
      prepareDatabase: (db: any) => {
        db.pragma('journal_mode = DELETE');
        db.pragma('foreign_keys = ON');
        db.pragma('busy_timeout = 5000');
      },
    } as DataSourceOptions;
  }

  return {
    ...base,
    type:     dbType as 'mariadb' | 'mysql',
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '3306', 10),
    username: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'akribeia_crm',
    charset:  'utf8mb4_unicode_ci',
  } as DataSourceOptions;
}

export const AppDataSource = new DataSource(buildDataSourceOptions());

const DB_PATH = path.resolve(process.env.DB_DATABASE || './data/akribeia.db');

/**
 * No-op mantenido por compatibilidad con imports existentes.
 * Con better-sqlite3, TypeORM escribe directo al disco en cada commit
 * — no hay nada que "forzar guardar".
 */
export async function forceSqljsSave(): Promise<void> {
  // No-op: better-sqlite3 persiste automáticamente.
}

/** Backup del archivo SQLite al arrancar — protege el estado anterior. */
function backupDatabase(): void {
  const dbType = (process.env.DB_TYPE || 'better-sqlite3');
  if (dbType === 'mariadb' || dbType === 'mysql') return;
  if (!fs.existsSync(DB_PATH)) return;

  const stat = fs.statSync(DB_PATH);
  if (stat.size < 50_000) return;

  const dir = path.dirname(DB_PATH);
  const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dst = path.join(dir, `akribeia.db.backup-${ts}`);
  fs.copyFileSync(DB_PATH, dst);
  console.log(`[DB] Backup creado: ${path.basename(dst)} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);

  // Conservar solo los últimos 5 backups
  const backups = fs.readdirSync(dir)
    .filter(f => f.startsWith('akribeia.db.backup-'))
    .sort();
  if (backups.length > 5) {
    backups.slice(0, backups.length - 5).forEach(f => {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
    });
  }
}

/**
 * Verifica que el archivo sea un SQLite válido comprobando los bytes mágicos.
 */
function isSqliteFileValid(filePath: string): boolean {
  try {
    const buf = fs.readFileSync(filePath, { flag: 'r' });
    if (buf.length < 100) return false;
    return buf.slice(0, 15).toString('ascii') === 'SQLite format 3';
  } catch {
    return false;
  }
}

/** Si la BD en disco está vacía/corrupta y hay un backup válido, lo restaura. */
function autoRestoreIfEmpty(): void {
  const dbType = (process.env.DB_TYPE || 'better-sqlite3');
  if (dbType === 'mariadb' || dbType === 'mysql') return;
  if (!fs.existsSync(DB_PATH)) return;

  const fileOk   = isSqliteFileValid(DB_PATH);
  const fileSize = fs.statSync(DB_PATH).size;
  if (fileOk && fileSize >= 50_000) return;

  const reason = !fileOk ? 'firma SQLite inválida' : 'tamaño < 50 KB';
  console.warn(`[DB] ⚠️  BD detectada como corrupta (${reason}) — buscando backup...`);

  const dir     = path.dirname(DB_PATH);
  const backups = fs.readdirSync(dir)
    .filter(f => f.startsWith('akribeia.db.backup-'))
    .map(f => {
      const p = path.join(dir, f);
      return { name: f, size: fs.statSync(p).size, valid: isSqliteFileValid(p) };
    })
    .filter(b => b.size > 50_000 && b.valid)
    .sort((a, b) => b.name.localeCompare(a.name));

  if (backups.length > 0) {
    fs.copyFileSync(path.join(dir, backups[0].name), DB_PATH);
    console.log(`[DB] ✅ BD restaurada desde backup: ${backups[0].name}`);
  } else {
    console.error('[DB] ❌ No se encontró backup válido. La BD puede estar corrupta.');
  }
}

export async function initDatabase(): Promise<void> {
  if (!AppDataSource.isInitialized) {
    // 1. Detectar corrupción y restaurar backup si es necesario
    autoRestoreIfEmpty();
    // 2. Hacer backup del estado actual antes de arrancar
    backupDatabase();

    await AppDataSource.initialize();
    console.log(`[DB] Conectado: ${process.env.DB_TYPE || 'better-sqlite3'}`);

    await seedModulos(AppDataSource);
    await seedCatalogo(AppDataSource);
    await seedPlanes(AppDataSource);
    await seedPlanModulo(AppDataSource);
    await seedCatalogoComercial(AppDataSource);
    await seedDemoComercial(AppDataSource);
    await backfillInvoiceLineas(AppDataSource);
    await backfillLineaAsientoCuentaId(AppDataSource);
    await seedResponsabilidadesBackfill(AppDataSource);
    await seedCatalogoSalud(AppDataSource);
    await seedRetencionBackfill(AppDataSource);
    await seedNovedades(AppDataSource);

    const gracefulShutdown = async (signal: string) => {
      console.log(`[DB] Señal ${signal} — cerrando conexión...`);
      try {
        if (AppDataSource.isInitialized) {
          await AppDataSource.destroy();
          console.log('[DB] Conexión cerrada correctamente.');
        }
      } catch (e) {
        console.error('[DB] Error al cerrar conexión:', e);
      }
      process.exit(0);
    };

    process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGHUP',  () => gracefulShutdown('SIGHUP'));

    if (process.platform === 'win32') {
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.on('SIGINT', () => gracefulShutdown('SIGINT'));
    }
  }
}
