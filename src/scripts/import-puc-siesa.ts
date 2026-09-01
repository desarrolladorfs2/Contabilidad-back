/**
 * Reemplaza el plan de cuentas (cuentas_puc) de cada empresa por el catálogo
 * que compartió el cliente (Bd_Cargues/BD PLAN DE CUENTAS SIESA.xlsx), ya
 * limpio y convertido a CSV en backend/src/seeds/data/puc_siesa.csv.
 *
 * El archivo original traía:
 * - "Categoría Financiera" que no distinguía Gasto de Costo (ambos = 5) -> se
 *   recalculó el tipo a partir del primer dígito del código (regla estándar
 *   del PUC colombiano: 1 activo, 2 pasivo, 3 patrimonio, 4 ingreso, 5 gasto,
 *   6 costo).
 * - "Naturaleza" en blanco o literalmente "0" para 947 cuentas (todo el grupo
 *   de Costos y algunas sueltas) -> se recalculó también por la clase del
 *   código (1/5/6 = débito, 2/3/4 = crédito), no se usó el dato del archivo.
 * - Nombres con espacios dobles o al inicio/final -> ya vienen limpios en el
 *   CSV (mismo tratamiento que se le dio a Codigos_UNSPSC.xlsm).
 * - "acepta_movimientos" no viene en el archivo -> se marcó true solo para
 *   las cuentas de nivel 5 (8 dígitos, las auxiliares), que son las únicas
 *   que reciben movimientos en la práctica contable estándar.
 *
 * POR INSTRUCCIÓN EXPLÍCITA DEL USUARIO ("Remplazalos con las de siesa, vamos
 * a trabajar es con esas" / "para este caso no importa que perdamos la
 * trazabilidad, simplemente quitalos, no importa"): este script hace un
 * reemplazo TOTAL — borra TODAS las cuentas_puc existentes de cada empresa
 * (incluso las que ya tengan movimientos contables registrados) y carga las
 * 2.106 de SIESA en su lugar. Como una cuenta con movimientos no se puede
 * borrar mientras algo la referencie (lineas_asiento.cuenta_id es RESTRICT a
 * nivel de base de datos), primero se desvincula esa referencia (se deja en
 * NULL la cuenta de esas líneas de asiento, el asiento en sí NO se borra,
 * solo pierde el dato de a qué cuenta pertenecía esa línea — es la pérdida de
 * trazabilidad que el usuario aceptó explícitamente). Se ejecuta un respaldo
 * del sqlite antes de tocar nada (igual que hace el backend al arrancar).
 *
 * Solo corre contra la base SQLite de desarrollo. Cuando se autorice pasar
 * esto a AWS/producción, se corre este mismo script allá.
 *
 * Uso: npx ts-node src/scripts/import-puc-siesa.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { AppDataSource } from '../config/database';
import { Company } from '../entities/Company';
import { CuentaPUC, TipoCuenta, NaturalezaCuenta, NivelCuenta } from '../entities/contabilidad/CuentaPUC';

const CSV_PATH = path.join(__dirname, '..', 'seeds', 'data', 'puc_siesa.csv');

function backupSqliteIfApplicable(): void {
  const dbType = (process.env.DB_TYPE || 'better-sqlite3');
  if (dbType !== 'better-sqlite3') return;
  const dbPath = path.resolve(process.env.DB_DATABASE || './data/akribeia.db');
  if (!fs.existsSync(dbPath)) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dst = `${dbPath}.backup-${ts}-pre-import-puc-siesa`;
  fs.copyFileSync(dbPath, dst);
  console.log(`[import-puc-siesa] Respaldo creado antes de importar: ${path.basename(dst)}`);
}

interface FilaPuc {
  codigo: string;
  nombre: string;
  tipo: TipoCuenta;
  nivel: NivelCuenta;
  naturaleza: NaturalezaCuenta;
  codigo_padre: string;
  acepta_movimientos: boolean;
}

function parseCsv(text: string): FilaPuc[] {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  const headers = splitCsvLine(lines[0]);
  const rows: FilaPuc[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = cols[idx] ?? ''; });
    rows.push({
      codigo: row['codigo'],
      nombre: row['nombre'],
      tipo: row['tipo'] as TipoCuenta,
      nivel: Number(row['nivel']) as NivelCuenta,
      naturaleza: row['naturaleza'] as NaturalezaCuenta,
      codigo_padre: row['codigo_padre'] || '',
      acepta_movimientos: row['acepta_movimientos'] === '1',
    });
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

  const filas = parseCsv(fs.readFileSync(CSV_PATH, 'utf-8'));
  console.log(`[import-puc-siesa] ${filas.length} cuentas leídas del CSV.`);

  await AppDataSource.initialize();
  const companyRepo = AppDataSource.getRepository(Company);
  const pucRepo = AppDataSource.getRepository(CuentaPUC);

  const empresas = await companyRepo.find();
  console.log(`[import-puc-siesa] ${empresas.length} empresa(s) encontrada(s).`);

  for (const empresa of empresas) {
    const existentes = await pucRepo.find({ where: { company_id: empresa.id } });
    console.log(`[import-puc-siesa] [${empresa.name}] ${existentes.length} cuenta(s) actual(es) encontrada(s).`);

    if (existentes.length > 0) {
      const ids = existentes.map(c => c.id);
      const placeholders = ids.map(() => '?').join(',');
      // Desvincula cualquier línea de asiento que apunte a estas cuentas (deja
      // cuenta_id en NULL) para poder borrarlas sin tropezar con la protección
      // RESTRICT de la base de datos. El asiento y la línea NO se borran, solo
      // pierden el dato de a qué cuenta pertenecían — pérdida de trazabilidad
      // aceptada explícitamente por el usuario para este reemplazo.
      const desvinculadas = await AppDataSource.query(
        `UPDATE lineas_asiento SET cuenta_id = NULL WHERE cuenta_id IN (${placeholders})`,
        ids,
      );
      if (desvinculadas?.changes) {
        console.log(`[import-puc-siesa] [${empresa.name}] ${desvinculadas.changes} línea(s) de asiento desvinculada(s) de su cuenta anterior (quedan sin cuenta asociada).`);
      }
      // configuracion_contable y presupuestos_centro_costo ya son SET NULL a
      // nivel de base de datos, así que el DELETE de abajo las limpia solo.
      await pucRepo.delete(ids);
      console.log(`[import-puc-siesa] [${empresa.name}] ${existentes.length} cuenta(s) anterior(es) eliminada(s).`);
    }

    // Primera pasada: insertar todas las cuentas sin padre_id (aún no conocemos
    // los ids generados por la base). Se usa insert() en lotes para velocidad.
    const BATCH = 500;
    const idPorCodigo = new Map<string, string>();
    let creadas = 0;
    for (let i = 0; i < filas.length; i += BATCH) {
      const lote = filas.slice(i, i + BATCH);
      const resultado = await pucRepo.insert(lote.map(f => ({
        company_id: empresa.id,
        codigo: f.codigo,
        nombre: f.nombre,
        tipo: f.tipo,
        nivel: f.nivel,
        naturaleza: f.naturaleza,
        acepta_movimientos: f.acepta_movimientos,
        requiere_tercero: false,
        requiere_centro_costo: false,
        activa: true,
      })) as any[]);
      resultado.identifiers.forEach((idObj, idx) => {
        idPorCodigo.set(lote[idx].codigo, idObj.id as string);
      });
      creadas += lote.length;
    }
    console.log(`[import-puc-siesa] [${empresa.name}] ${creadas} cuenta(s) nueva(s) creada(s).`);

    // Segunda pasada: resolver padre_id por código, igual que hace /puc/seed.
    const actualizaciones: Promise<unknown>[] = [];
    for (const f of filas) {
      if (!f.codigo_padre) continue;
      const propiaId = idPorCodigo.get(f.codigo);
      const padreId = idPorCodigo.get(f.codigo_padre);
      if (propiaId && padreId) {
        actualizaciones.push(pucRepo.update({ id: propiaId }, { padre_id: padreId }));
      }
    }
    await Promise.all(actualizaciones);

    const totalFinal = await pucRepo.count({ where: { company_id: empresa.id } });
    console.log(`[import-puc-siesa] [${empresa.name}] Jerarquía resuelta. Total de cuentas en cuentas_puc para esta empresa: ${totalFinal}.`);
  }

  await AppDataSource.destroy();
  console.log('[import-puc-siesa] Completado.');
}

main().catch(e => { console.error(e); process.exit(1); });
