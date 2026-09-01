/**
 * Crea las 9 sedes nuevas (Medellín x5, Cali, Pereira, Popayán, Armenia) y
 * reemplaza TOTALMENTE los centros de costo de la empresa Neurum AP por los
 * 68 que compartió el cliente en Bd_Cargues/centros_costo_propuesta_final_v2.xlsx
 * (columna "nombre_propuesto" ya acordada en la entrega 30), convertidos a
 * backend/src/seeds/data/centros_costo_neurum_ap.csv.
 *
 * A diferencia de import-puc-siesa.ts / import-unspsc.ts (que aplican a TODAS
 * las empresas), este script es específico de UNA sola empresa, porque las
 * sedes y los centros de costo son datos propios de Neurum AP, no un
 * catálogo compartido — el ID de la empresa está fijo en COMPANY_ID.
 *
 * POR INSTRUCCIÓN EXPLÍCITA DEL USUARIO ("no importa la trazabilidad de lo
 * viejo, ya que seguimos en el ambiente de pruebas"): este script borra TODOS
 * los centros_costo existentes de Neurum AP (incluso los que ya tengan
 * facturas o líneas de asiento apuntándolos) y carga los 68 nuevos en su
 * lugar. Todas las relaciones hacia centros_costo en este proyecto son
 * onDelete SET NULL o CASCADE (a diferencia de CuentaPUC.padre, que sí tenía
 * RESTRICT) — no hace falta desvincular nada a mano, la base de datos lo
 * hace sola al borrar. Las sedes NO se tocan: si una sede con el mismo
 * nombre ya existe para la empresa, se reutiliza en vez de duplicarla.
 *
 * Se ejecuta un respaldo del sqlite antes de tocar nada (igual que hace el
 * backend al arrancar).
 *
 * Solo corre contra la base SQLite de desarrollo. Cuando se autorice pasar
 * esto a AWS/producción, se corre este mismo script allá (ajustando
 * COMPANY_ID y los IDs de MUNICIPIOS si son distintos en esa base).
 *
 * Uso: npx ts-node src/scripts/import-centros-costo-siesa.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { AppDataSource } from '../config/database';
import { CentroCosto } from '../entities/contabilidad/CentroCosto';
import { Sede } from '../entities/contabilidad/Sede';

const CSV_PATH = path.join(__dirname, '..', 'seeds', 'data', 'centros_costo_neurum_ap.csv');
const COMPANY_ID = '4d601ecc-af71-467c-974b-7529971df0bb'; // Neurum AP

// IDs de cat_municipios (DIVIPOLA) usados por las 9 sedes. Si este script se
// corre contra otra base (por ejemplo AWS), verificar que estos IDs existan
// allá o resolverlos por nombre en vez de por ID fijo.
const MUNICIPIOS: Record<string, string> = {
  'medellín': 'e8b933cb-1285-433f-929e-429347c72842',
  'cali': '9905dd1b-ed1e-48d4-936d-502ef7c6c7bb',
  'pereira': 'c9a4263d-a356-492e-a3fe-ea20b670350d',
  'popayán': '4affb665-570f-465b-b643-092bdc756c65',
  'armenia': '7ed3f5d3-2d95-488b-86dd-29562a395c7a',
};

interface FilaCentro {
  codigo: string;
  padre: string;
  nombre: string;
  sedes: string[];
}

function backupSqliteIfApplicable(): void {
  const dbType = (process.env.DB_TYPE || 'better-sqlite3');
  if (dbType !== 'better-sqlite3') return;
  const dbPath = path.resolve(process.env.DB_DATABASE || './data/akribeia.db');
  if (!fs.existsSync(dbPath)) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dst = `${dbPath}.backup-${ts}-pre-import-centros-costo-siesa`;
  fs.copyFileSync(dbPath, dst);
  console.log(`[import-centros-costo-siesa] Respaldo creado antes de importar: ${path.basename(dst)}`);
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

function parseCsv(text: string): FilaCentro[] {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  const headers = splitCsvLine(lines[0]);
  const rows: FilaCentro[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = cols[idx] ?? ''; });
    rows.push({
      codigo: row['codigo'],
      padre: row['padre'] || '',
      nombre: row['nombre'],
      sedes: row['sedes'] ? row['sedes'].split(',').map(s => s.trim()).filter(Boolean) : [],
    });
  }
  return rows;
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`No se encontró el archivo ${CSV_PATH}.`);
  }
  backupSqliteIfApplicable();

  const filas = parseCsv(fs.readFileSync(CSV_PATH, 'utf-8'));
  console.log(`[import-centros-costo-siesa] ${filas.length} centros de costo leídos del CSV.`);

  const sedesUnicas = Array.from(new Set(filas.flatMap(f => f.sedes)));
  for (const s of sedesUnicas) {
    const ciudad = s.split(' - ')[0].trim().toLowerCase();
    if (!MUNICIPIOS[ciudad]) {
      throw new Error(`No se pudo determinar el municipio de la sede "${s}" (ciudad detectada: "${ciudad}")`);
    }
  }

  await AppDataSource.initialize();
  const ccRepo = AppDataSource.getRepository(CentroCosto);
  const sedeRepo = AppDataSource.getRepository(Sede);

  // --- 1. Crear las sedes nuevas (reutilizar si ya existe una con el mismo nombre) ---
  const sedesExistentes = await sedeRepo.find({ where: { company_id: COMPANY_ID } });
  const sedeIdPorNombre = new Map<string, string>();
  let maxSd = 0;
  for (const s of sedesExistentes) {
    sedeIdPorNombre.set(s.nombre, s.id);
    const m = /^SD-(\d+)$/.exec(s.codigo);
    if (m) maxSd = Math.max(maxSd, parseInt(m[1], 10));
  }
  let sedesCreadas = 0;
  for (const nombreSede of sedesUnicas.sort()) {
    if (sedeIdPorNombre.has(nombreSede)) {
      console.log(`[import-centros-costo-siesa]   sede ya existía, se reutiliza: ${nombreSede}`);
      continue;
    }
    maxSd += 1;
    const ciudad = nombreSede.split(' - ')[0].trim().toLowerCase();
    const nueva = await sedeRepo.save(Object.assign(new Sede(), {
      company_id: COMPANY_ID,
      codigo: `SD-${String(maxSd).padStart(3, '0')}`,
      nombre: nombreSede,
      municipio_id: MUNICIPIOS[ciudad],
      activo: true,
    }));
    sedeIdPorNombre.set(nombreSede, nueva.id);
    sedesCreadas++;
    console.log(`[import-centros-costo-siesa]   sede creada: ${nueva.codigo}  ${nombreSede}`);
  }
  console.log(`[import-centros-costo-siesa] ${sedesCreadas} sede(s) nueva(s) creada(s), ${sedesUnicas.length - sedesCreadas} reutilizada(s).`);

  // --- 2. Borrar TODOS los centros de costo actuales de Neurum AP ---
  // Todas las relaciones hacia CentroCosto en este proyecto son SET NULL o
  // CASCADE (nunca RESTRICT), así que un simple delete() basta: la base de
  // datos limpia sola las tablas puente (centro_costo_sedes,
  // contrato_salud_centros_costo) y deja en NULL el centro_costo_id de
  // facturas/lineas_asiento/facturas_compra/etc. — pérdida de trazabilidad
  // aceptada explícitamente por el usuario para este reemplazo.
  const viejos = await ccRepo.find({ where: { company_id: COMPANY_ID } });
  if (viejos.length > 0) {
    await ccRepo.remove(viejos);
  }
  console.log(`[import-centros-costo-siesa] ${viejos.length} centro(s) de costo anterior(es) eliminado(s).`);

  // --- 3. Insertar los centros de costo nuevos (primera pasada, sin padre_id) ---
  const idPorCodigo = new Map<string, string>();
  for (const f of filas) {
    const creado = await ccRepo.save(Object.assign(new CentroCosto(), {
      company_id: COMPANY_ID,
      codigo: f.codigo,
      nombre: f.nombre,
      activo: true,
    }));
    idPorCodigo.set(f.codigo, creado.id);
  }
  console.log(`[import-centros-costo-siesa] ${filas.length} centro(s) de costo nuevo(s) creado(s).`);

  // --- 4. Segunda pasada: resolver padre_id por código ---
  let resueltos = 0;
  for (const f of filas) {
    if (!f.padre) continue;
    const propioId = idPorCodigo.get(f.codigo);
    const padreId = idPorCodigo.get(f.padre);
    if (propioId && padreId) {
      await ccRepo.update({ id: propioId }, { padre_id: padreId });
      resueltos++;
    }
  }
  console.log(`[import-centros-costo-siesa] ${resueltos} relación(es) padre-hijo resuelta(s).`);

  // --- 5. Relacionar cada centro de costo con sus sedes ---
  let totalRelaciones = 0;
  for (const f of filas) {
    if (f.sedes.length === 0) continue;
    const ccId = idPorCodigo.get(f.codigo)!;
    const sedeIds = f.sedes.map(s => sedeIdPorNombre.get(s)!);
    await AppDataSource.createQueryBuilder()
      .relation(CentroCosto, 'sedes')
      .of(ccId)
      .add(sedeIds);
    totalRelaciones += sedeIds.length;
  }
  console.log(`[import-centros-costo-siesa] ${totalRelaciones} relación(es) centro de costo-sede creada(s).`);

  const totalFinal = await ccRepo.count({ where: { company_id: COMPANY_ID } });
  console.log(`[import-centros-costo-siesa] Completado. Total de centros de costo para Neurum AP: ${totalFinal}.`);

  await AppDataSource.destroy();
}

main().catch(e => { console.error(e); process.exit(1); });
