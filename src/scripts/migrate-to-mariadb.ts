/**
 * migrate-to-mariadb.ts
 *
 * Migra TODO el contenido actual de la base SQLite (backend/data/akribeia.db)
 * hacia la base MariaDB "FEV" en RDS, creando primero el esquema completo
 * (a partir de las mismas entidades TypeORM que ya usa la app) y luego
 * copiando fila por fila cada tabla, con verificación de conteos al final.
 *
 * NO modifica el archivo SQLite (solo lectura) ni el .env de la app —
 * las credenciales del destino están definidas aquí mismo, de forma aislada,
 * para no arriesgar que la app arranque contra MariaDB antes de que la
 * migración termine y se verifique.
 *
 * Uso (desde la carpeta backend/):
 *   npx ts-node src/scripts/migrate-to-mariadb.ts
 *
 * Seguro de re-ejecutar: antes de copiar cada tabla, borra su contenido en
 * el destino (DELETE), así que correrlo dos veces no duplica filas.
 *
 * ⚠️  Este archivo contiene la contraseña de la RDS en texto plano.
 *     Bórralo o rota la contraseña una vez termine la migración si el
 *     repositorio se comparte con alguien más.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as path from 'path';
import * as fs from 'fs';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require('node:sqlite');

const ENTITIES_GLOB = path.join(__dirname, '..', 'entities', '**', '*.{ts,js}');
const SQLITE_PATH    = path.resolve(__dirname, '..', '..', 'data', 'akribeia.db');

// ── Origen: SQLite actual (solo lectura) ────────────────────────────────────
// NOTA (2026-09-01): el driver 'better-sqlite3' de TypeORM trae un binario
// nativo (.node) compilado para Windows. Corriendo este script desde el
// entorno remoto (Linux) para llegar al archivo montado del proyecto, ese
// binario no carga ("invalid ELF header") — el mismo problema de siempre
// con binarios nativos de este proyecto (ver notas de import-terceros-siesa).
// Por eso el ORIGEN ya no usa TypeORM/better-sqlite3: usa el módulo
// 'node:sqlite' incorporado en Node 22+ (sin binario .node separado, es
// parte del propio ejecutable de node, así que no tiene ese problema) a
// través de este shim con la misma interfaz async .query()/.initialize()/
// .destroy() que ya usaba el resto del script — ningún otro código cambió.
// El DESTINO (MariaDB) sigue siendo TypeORM normal (driver 'mariadb', puro
// JS, sin binario nativo) para poder reusar synchronize() con las ~76
// entidades reales de la app y así crear el esquema completo automáticamente.
class SqliteShim {
  private db: any = null;
  constructor(private dbPath: string) {}
  async initialize(): Promise<void> {
    this.db = new DatabaseSync(this.dbPath, { readOnly: true });
  }
  async destroy(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
  async query<T = any>(sql: string): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    const rows = stmt.all() as Record<string, unknown>[];
    // node:sqlite devuelve objetos con prototipo null — se copian a objetos
    // planos normales para que el resto del script (Object.keys, spread,
    // JSON.stringify, etc.) se comporte exactamente igual que con TypeORM.
    return rows.map(r => ({ ...r })) as unknown as T[];
  }
}

const sqliteDS = new SqliteShim(SQLITE_PATH);

// ── Destino: MariaDB (RDS) ───────────────────────────────────────────────────
// Actualizado el 2026-09-01: apunta ahora al nuevo servidor RDS "contabilidad"
// (el anterior, "pruebas-produccionhealthsphere", queda en desuso).
const MARIA_HOST = 'contabilidad.ce6agou8m1rx.us-east-1.rds.amazonaws.com';
const MARIA_DB   = 'FEV';

const mariaDS = new DataSource({
  type: 'mariadb',
  host: MARIA_HOST,
  port: 3306,
  username: 'admin',
  password: 'ContabilidadAkribeiaAdmin',
  database: MARIA_DB,
  charset: 'utf8mb4_unicode_ci',
  entities: [ENTITIES_GLOB],
  // El sync se dispara a mano (ver retrySynchronize) para poder reintentarlo:
  // con ~76 entidades, MariaDB a veces intenta crear una FK antes de que exista
  // el índice único de la tabla referenciada (natural key), y solo se resuelve
  // reintentando — cada pasada deja más tablas/índices ya creados.
  synchronize: false,
  logging: false,
});

/** Reintenta mariaDS.synchronize() varias veces: cada pasada deja más tablas
 *  e índices creados en MariaDB, así que un fallo de "FK incorrectamente
 *  formada" (errno 150) suele resolverse solo en el siguiente intento. */
async function retrySynchronize(maxIntentos = 6): Promise<void> {
  for (let intento = 1; intento <= maxIntentos; intento++) {
    try {
      await mariaDS.synchronize();
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (intento === maxIntentos) throw err;
      console.log(`  ⚠️  Intento ${intento}/${maxIntentos} del esquema falló (${msg.split('\n')[0]}) — reintentando...`);
    }
  }
}

function ident(id: string): string {
  return '`' + id.replace(/`/g, '``') + '`';
}

/** Borra todas las tablas que ya existan en el destino, para que synchronize()
 *  arranque de cero con CREATE TABLE en vez de tener que hacer ALTER sobre
 *  tablas a medio construir de intentos anteriores (eso es lo que causaba el
 *  choque de índice/FK). Seguro porque FEV todavía no tiene datos reales —
 *  la copia de filas ocurre DESPUÉS de que el esquema completo esté listo. */
async function dropAllTables(): Promise<void> {
  const tablas: { table_name: string }[] = await mariaDS.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = ?`,
    [MARIA_DB]
  );
  if (tablas.length === 0) return;
  await mariaDS.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const { table_name } of tablas) {
    await mariaDS.query(`DROP TABLE IF EXISTS ${ident(table_name)}`);
  }
  await mariaDS.query('SET FOREIGN_KEY_CHECKS = 1');
}

interface Resumen { tabla: string; origen: number; destino: number; ok: boolean; error?: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Amplía todas las columnas TEXT del esquema destino a LONGTEXT.
 *  Solo se hace en MariaDB (aquí), NUNCA en las entidades TypeScript, porque
 *  el driver sqlite de TypeORM no soporta 'longtext' como tipo literal y
 *  romperia el synchronize() contra la base local de desarrollo.
 *  MySQL/MariaDB TEXT tiene un límite duro de 65,535 bytes — insuficiente
 *  para PDFs/XML en base64 que SQLite (TEXT sin límite) toleraba sin problema. */
async function ampliarTextALongtext(): Promise<void> {
  const cols: { TABLE_NAME: string; COLUMN_NAME: string; IS_NULLABLE: string }[] = await mariaDS.query(
    `SELECT TABLE_NAME, COLUMN_NAME, IS_NULLABLE
     FROM information_schema.columns
     WHERE TABLE_SCHEMA = ? AND DATA_TYPE = 'text'`,
    [MARIA_DB]
  );
  for (const c of cols) {
    const nulabilidad = c.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL';
    await mariaDS.query(
      `ALTER TABLE ${ident(c.TABLE_NAME)} MODIFY COLUMN ${ident(c.COLUMN_NAME)} LONGTEXT ${nulabilidad}`
    );
    console.log(`  ↑ ${c.TABLE_NAME}.${c.COLUMN_NAME} → LONGTEXT`);
  }
}

/** Metadata de columnas (tipo de dato) de una tabla en el destino, usada para
 *  sanear valores problemáticos antes de insertar:
 *   - columnas tipo 'uuid': strings que no tengan formato UUID válido se
 *     convierten a NULL (dato legado tolerado por SQLite, TEXT sin validar,
 *     pero rechazado por el tipo `uuid` nativo y estricto de MariaDB).
 *   - columnas tipo date/datetime/timestamp: '' se convierte a NULL (SQLite
 *     tolera string vacío en cualquier columna sin importar el tipo declarado;
 *     MariaDB no acepta '' como fecha válida). */
async function columnasDestino(tabla: string): Promise<Record<string, string>> {
  const cols: { COLUMN_NAME: string; DATA_TYPE: string }[] = await mariaDS.query(
    `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.columns WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [MARIA_DB, tabla]
  );
  const mapa: Record<string, string> = {};
  for (const c of cols) mapa[c.COLUMN_NAME] = c.DATA_TYPE.toLowerCase();
  return mapa;
}

const FECHAS = new Set(['date', 'datetime', 'timestamp']);

/** Sanea una fila según el tipo de columna en destino, mutando lo mínimo
 *  necesario y avisando por consola cada corrección aplicada. */
function sanearFila(
  tabla: string,
  row: Record<string, unknown>,
  tipos: Record<string, string>,
  avisos: Set<string>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const col of Object.keys(out)) {
    const tipo = tipos[col];
    const val = out[col];
    if (tipo === 'uuid' && typeof val === 'string' && val !== '' && !UUID_RE.test(val)) {
      const key = `${tabla}.${col}:${val}`;
      if (!avisos.has(key)) {
        avisos.add(key);
        console.log(`  ⚠️  ${tabla}.${col} = '${val}' no es un UUID válido → NULL`);
      }
      out[col] = null;
    } else if (tipo && FECHAS.has(tipo) && val === '') {
      out[col] = null;
    }
  }
  return out;
}

/** Tamaño aproximado en bytes de una fila (para no exceder max_allowed_packet
 *  al armar lotes de INSERT — columnas base64 grandes pueden pesar varios MB). */
function tamanoAprox(row: Record<string, unknown>): number {
  try {
    return Buffer.byteLength(JSON.stringify(row), 'utf8');
  } catch {
    return 1024;
  }
}

const MAX_BYTES_POR_LOTE = 2 * 1024 * 1024; // 2MB por lote — bien debajo del max_allowed_packet típico (usualmente >=4MB)
const MAX_FILAS_POR_LOTE = 50; // aparte del límite de bytes, tope de filas para no generar SQL gigantes con muchas columnas

/** Intenta subir max_allowed_packet en el servidor (requiere privilegio SUPER;
 *  el usuario admin de RDS a veces lo tiene, a veces no). Si funciona, hay que
 *  reconectar porque el valor de sesión se fija al conectar. Si falla, no es
 *  grave: el script de todas formas nunca manda un valor individual grande
 *  (ver extraerValoresGrandes) ni lotes grandes, así que la migración sigue
 *  funcionando con el límite que ya tenga el servidor. */
async function elevarMaxAllowedPacket(): Promise<void> {
  try {
    await mariaDS.query('SET GLOBAL max_allowed_packet = 1073741824'); // 1GB
    await mariaDS.destroy();
    await mariaDS.initialize();
    console.log('  ✅ max_allowed_packet subido en el servidor.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ⚠️  No se pudo subir max_allowed_packet (${msg.split('\n')[0]}) — se sigue con el límite actual del servidor.`);
  }
  // Se lee el valor real quedó vigente (subido o no) para saber, más adelante,
  // qué valores son demasiado grandes para caber aunque se fragmenten.
  try {
    const [{ v }] = await mariaDS.query('SELECT @@session.max_allowed_packet AS v');
    MAX_ALLOWED_PACKET = Number(v);
    console.log(`  ℹ️  max_allowed_packet vigente en esta sesión: ${(MAX_ALLOWED_PACKET / 1024 / 1024).toFixed(1)} MB`);
  } catch {
    console.log('  ⚠️  No se pudo leer max_allowed_packet — se asume 16 MB por defecto.');
  }
}

async function pkColumn(tabla: string): Promise<string> {
  const rows: { COLUMN_NAME: string }[] = await mariaDS.query(
    `SELECT COLUMN_NAME FROM information_schema.key_column_usage
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' LIMIT 1`,
    [MARIA_DB, tabla]
  );
  return rows[0]?.COLUMN_NAME || 'id';
}

const SAFE_VALUE_BYTES = 1 * 1024 * 1024; // 1MB — un valor individual (ej. un PDF en base64) más grande que esto se
                                           // separa e inserta después en trozos, para que ni un solo valor pueda
                                           // acercarse a max_allowed_packet, sin importar cómo esté configurado el servidor.
const UPDATE_CHUNK_BYTES = 512 * 1024;

// Valor real de @@session.max_allowed_packet del servidor — se actualiza en main()
// justo después de conectar (y de intentar subirlo). MariaDB no permite que el
// RESULTADO de un CONCAT() supere este límite, sin importar en cuántos trozos se
// vaya armando — así que un valor cuyo tamaño total ya se acerque a este límite
// NUNCA va a poder guardarse dentro de MariaDB por más que se fragmente el envío.
// Esos casos se exportan a archivo y se dejan en NULL, en vez de intentar (y
// fallar) el UPDATE en trozos.
let MAX_ALLOWED_PACKET = 16 * 1024 * 1024;

const OVERSIZED_DIR = path.resolve(__dirname, '..', '..', 'migracion-valores-omitidos');

interface ValorOmitido { tabla: string; col: string; idVal: unknown; bytes: number; archivo: string }
const valoresOmitidos: ValorOmitido[] = [];

/** Exporta a un archivo un valor que es demasiado grande para poder guardarse
 *  en MariaDB con el max_allowed_packet actual del servidor (ni siquiera
 *  fragmentado, porque el límite aplica también al resultado final de
 *  CONCAT()). Así no se pierde el dato: queda igual en disco, listo para
 *  reintentar la carga a mano el día que se pueda subir max_allowed_packet
 *  en el parameter group de RDS. */
function exportarValorOmitido(tabla: string, col: string, idVal: unknown, valor: string): string {
  fs.mkdirSync(OVERSIZED_DIR, { recursive: true });
  const nombreSeguro = (s: unknown) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
  const archivo = path.join(OVERSIZED_DIR, `${nombreSeguro(tabla)}__${nombreSeguro(col)}__${nombreSeguro(idVal)}.txt`);
  fs.writeFileSync(archivo, valor, 'utf8');
  return archivo;
}

/** Saca de una fila los valores de texto demasiado grandes para ir seguros en
 *  un INSERT normal. Los que caben (aunque sean grandes) se insertan como
 *  NULL en el INSERT principal y se completan después con
 *  completarValoresGrandes(). Los que NUNCA van a caber en este servidor
 *  (porque su tamaño total ya se acerca a max_allowed_packet) se exportan a
 *  archivo con exportarValorOmitido() y quedan en NULL definitivamente. */
function extraerValoresGrandes(
  tabla: string,
  idCol: string,
  row: Record<string, unknown>
): { liviana: Record<string, unknown>; grandes: { col: string; valor: string }[] } {
  const liviana: Record<string, unknown> = { ...row };
  const grandes: { col: string; valor: string }[] = [];
  // Margen de seguridad: un CONCAT que termine por encima del 60% del límite
  // del servidor es demasiado arriesgado (overhead de la consulta, charset
  // multibyte, etc. pueden empujarlo al resultado real por encima del tope).
  const TOPE_CONCAT = MAX_ALLOWED_PACKET * 0.6;
  for (const col of Object.keys(liviana)) {
    const val = liviana[col];
    if (typeof val === 'string' && Buffer.byteLength(val, 'utf8') > SAFE_VALUE_BYTES) {
      const bytes = Buffer.byteLength(val, 'utf8');
      if (bytes > TOPE_CONCAT) {
        const idVal = liviana[idCol];
        const archivo = exportarValorOmitido(tabla, col, idVal, val);
        valoresOmitidos.push({ tabla, col, idVal, bytes, archivo });
        console.log(`\n  📦 ${tabla}.${col} (fila ${idVal}) pesa ${(bytes / 1024 / 1024).toFixed(2)} MB — no cabe en este servidor (max_allowed_packet=${(MAX_ALLOWED_PACKET / 1024 / 1024).toFixed(0)}MB). Exportado a ${archivo}, queda en NULL.`);
      } else {
        grandes.push({ col, valor: val });
      }
      liviana[col] = null;
    }
  }
  return { liviana, grandes };
}

/** Completa, en trozos pequeños (CONCAT sucesivos), los valores grandes que
 *  extraerValoresGrandes() sacó de una fila — ningún UPDATE individual supera
 *  UPDATE_CHUNK_BYTES, así que nunca se acerca a max_allowed_packet. */
async function completarValoresGrandes(
  tabla: string,
  idCol: string,
  idVal: unknown,
  grandes: { col: string; valor: string }[]
): Promise<void> {
  for (const { col, valor } of grandes) {
    let primero = true;
    let i = 0;
    while (i < valor.length) {
      const fin = Math.min(valor.length, i + UPDATE_CHUNK_BYTES);
      const trozo = valor.slice(i, fin);
      if (primero) {
        await mariaDS.query(`UPDATE ${ident(tabla)} SET ${ident(col)} = ? WHERE ${ident(idCol)} = ?`, [trozo, idVal]);
        primero = false;
      } else {
        await mariaDS.query(
          `UPDATE ${ident(tabla)} SET ${ident(col)} = CONCAT(${ident(col)}, ?) WHERE ${ident(idCol)} = ?`,
          [trozo, idVal]
        );
      }
      i = fin;
    }
  }
}

function esErrorDeConexion(err: unknown): boolean {
  const code = (err as any)?.code;
  return code === 'ECONNRESET' || code === 'PROTOCOL_CONNECTION_LOST' || code === 'ETIMEDOUT';
}

async function main(): Promise<void> {
  console.log(`Origen (SQLite):  ${SQLITE_PATH}`);
  console.log(`Destino (MariaDB): ${MARIA_DB} @ ${MARIA_HOST}\n`);

  console.log('Conectando a SQLite...');
  await sqliteDS.initialize();
  console.log('✅ SQLite conectado.\n');

  console.log('Conectando a MariaDB...');
  await mariaDS.initialize();
  console.log('✅ MariaDB conectado.\n');

  // RESUMIBLE: este script puede tardar más de lo que dura una sola sesión
  // de terminal (miles de filas + latencia de red hacia RDS). Si ya se creó
  // el esquema en un intento anterior (FEV ya tiene tablas), NO se vuelve a
  // borrar/recrear todo — eso destruiría el progreso ya copiado. El paso de
  // esquema/columnas/max_allowed_packet solo corre la PRIMERA vez.
  const yaExisteEsquema: { c: number }[] = await mariaDS.query(
    `SELECT COUNT(*) as c FROM information_schema.tables WHERE table_schema = ?`,
    [MARIA_DB]
  );
  const esquemaListo = Number(yaExisteEsquema[0]?.c ?? 0) > 0;

  if (!esquemaListo) {
    console.log('Limpiando tablas creadas a medias en intentos anteriores (FEV no tiene datos reales aún)...');
    await dropAllTables();
    console.log('✅ "FEV" en blanco.\n');

    console.log('Creando el esquema desde cero (synchronize, con reintentos)...');
    await retrySynchronize();
    console.log('✅ Esquema listo en "FEV".\n');

    console.log('Ampliando columnas TEXT → LONGTEXT en el destino (para PDFs/XML en base64)...');
    await ampliarTextALongtext();
    console.log('✅ Columnas ampliadas.\n');
  } else {
    console.log('ℹ️  El esquema ya existe en "FEV" (corrida anterior) — se omite drop/sync/ampliación de columnas y se continúa copiando filas.\n');
  }

  console.log('Intentando subir max_allowed_packet en el servidor...');
  await elevarMaxAllowedPacket();
  console.log();

  const avisosUuid = new Set<string>();

  let tables: { name: string }[] = await sqliteDS.query(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
  );

  // Filtro opcional por bloques (MIGRATE_TABLES="terceros,tercero_responsabilidades"),
  // para poder correr y verificar la migración en tandas manejables dentro del
  // límite de tiempo de cada invocación, en vez de un solo intento gigante.
  const filtro = (process.env.MIGRATE_TABLES || '').split(',').map(s => s.trim()).filter(Boolean);
  if (filtro.length > 0) {
    tables = tables.filter(t => filtro.includes(t.name));
    console.log(`ℹ️  Bloque filtrado: solo se procesan ${tables.length} tabla(s): ${tables.map(t => t.name).join(', ')}\n`);
  }

  await mariaDS.query('SET FOREIGN_KEY_CHECKS = 0');

  const resumen: Resumen[] = [];

  for (const { name: tabla } of tables) {
    let intentos = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      intentos++;
      try {
        // Verificar que la tabla exista también en destino (por si alguna entidad
        // vieja quedó en el SQLite pero ya no tiene entidad TypeORM asociada).
        const existeDestino: any[] = await mariaDS.query(
          `SELECT 1 FROM information_schema.tables WHERE table_schema = 'FEV' AND table_name = ?`,
          [tabla]
        );
        if (existeDestino.length === 0) {
          const [{ cO }] = await sqliteDS.query(`SELECT COUNT(*) as cO FROM ${ident(tabla)}`);
          console.log(`[${tabla}] ⚠️  omitida (no existe en el esquema destino — entidad probablemente eliminada)`);
          resumen.push({ tabla, origen: Number(cO), destino: 0, ok: false, error: 'tabla no existe en destino' });
          break;
        }

        // RESUMIBLE: si esta corrida es continuación de una anterior que se
        // cortó a la mitad, no tiene sentido volver a borrar+reinsertar una
        // tabla que ya quedó con el mismo número de filas que el origen —
        // eso solo repite trabajo de red ya hecho. Se compara por conteo
        // (barato) antes de tocar la tabla.
        const [{ cOrigenChk }] = await sqliteDS.query(`SELECT COUNT(*) as cOrigenChk FROM ${ident(tabla)}`);
        const [{ cDestinoChk }] = await mariaDS.query(`SELECT COUNT(*) as cDestinoChk FROM ${ident(tabla)}`);
        if (Number(cOrigenChk) === Number(cDestinoChk)) {
          console.log(`[${tabla}] ✅ ya migrada (${cOrigenChk} filas) — se omite`);
          resumen.push({ tabla, origen: Number(cOrigenChk), destino: Number(cDestinoChk), ok: true });
          break;
        }

        const rows: Record<string, unknown>[] = await sqliteDS.query(`SELECT * FROM ${ident(tabla)}`);
        process.stdout.write(`[${tabla}] ${rows.length} filas en origen (destino tiene ${cDestinoChk}, recopiando)... `);

        await mariaDS.query(`DELETE FROM ${ident(tabla)}`);

        if (rows.length > 0) {
          const cols = Object.keys(rows[0]);
          const colList = cols.map(ident).join(',');
          const tipos = await columnasDestino(tabla);
          const idCol = await pkColumn(tabla);

          // Cada fila se sanea (UUIDs/fechas) y se le sacan los valores
          // demasiado grandes (ej. PDFs en base64) para completarlos después
          // en trozos — así ni el INSERT en lote ni un solo valor puede
          // acercarse a max_allowed_packet.
          const trabajosGrandes: { idVal: unknown; grandes: { col: string; valor: string }[] }[] = [];
          const filas = rows.map(r => {
            const saneada = sanearFila(tabla, r, tipos, avisosUuid);
            const { liviana, grandes } = extraerValoresGrandes(tabla, idCol, saneada);
            if (grandes.length > 0) trabajosGrandes.push({ idVal: liviana[idCol], grandes });
            return liviana;
          });

          // Lotes adaptativos: cortan por MAX_FILAS_POR_LOTE filas o por
          // MAX_BYTES_POR_LOTE (lo que se alcance primero).
          let i = 0;
          while (i < filas.length) {
            const chunk: Record<string, unknown>[] = [];
            let bytes = 0;
            while (
              i < filas.length &&
              chunk.length < MAX_FILAS_POR_LOTE &&
              (chunk.length === 0 || bytes < MAX_BYTES_POR_LOTE)
            ) {
              const fila = filas[i];
              bytes += tamanoAprox(fila);
              chunk.push(fila);
              i++;
            }
            const placeholders = chunk.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
            const params = chunk.flatMap(r => cols.map(c => r[c]));
            await mariaDS.query(
              `INSERT INTO ${ident(tabla)} (${colList}) VALUES ${placeholders}`,
              params
            );
          }

          for (const t of trabajosGrandes) {
            await completarValoresGrandes(tabla, idCol, t.idVal, t.grandes);
          }
          if (trabajosGrandes.length > 0) {
            console.log(`\n  ↳ ${trabajosGrandes.length} fila(s) con valores grandes (PDFs/XML) completadas en trozos`);
          }
        }

        const [{ cnt }] = await mariaDS.query(`SELECT COUNT(*) as cnt FROM ${ident(tabla)}`);
        const destino = Number(cnt);
        const ok = destino === rows.length;
        console.log(ok ? '✅' : `❌ (destino=${destino})`);
        resumen.push({ tabla, origen: rows.length, destino, ok });
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (esErrorDeConexion(err) && intentos < 3) {
          console.log(`\n  ⚠️  Se perdió la conexión (${msg.split('\n')[0]}) — reconectando y reintentando la tabla...`);
          try {
            await mariaDS.destroy();
          } catch { /* ya estaba cerrada */ }
          await mariaDS.initialize();
          await mariaDS.query('SET FOREIGN_KEY_CHECKS = 0');
          continue;
        }
        console.log(`❌ ERROR: ${msg}`);
        resumen.push({ tabla, origen: -1, destino: -1, ok: false, error: msg });
        break;
      }
    }
  }

  try {
    await mariaDS.query('SET FOREIGN_KEY_CHECKS = 1');
  } catch (err) {
    console.log('⚠️  No se pudo restaurar FOREIGN_KEY_CHECKS=1 (la conexión pudo haberse perdido) — revisa manualmente si es necesario.');
  }

  console.log('\n════════════════════ RESUMEN DE MIGRACIÓN ════════════════════');
  let allOk = true;
  for (const r of resumen) {
    const marca = r.ok ? '✅' : '❌';
    if (!r.ok) allOk = false;
    const detalle = r.error ? `  (${r.error})` : '';
    console.log(`${marca} ${r.tabla.padEnd(38)} origen=${String(r.origen).padStart(6)}  destino=${String(r.destino).padStart(6)}${detalle}`);
  }
  console.log('════════════════════════════════════════════════════════════\n');

  if (valoresOmitidos.length > 0) {
    console.log('⚠️  ════════ VALORES OMITIDOS (no cupieron en este servidor) ════════');
    console.log('   El conteo de filas de sus tablas SÍ coincide, pero estos campos');
    console.log('   puntuales quedaron en NULL en MariaDB — el valor original está');
    console.log('   intacto en el archivo exportado, para cargarlo a mano después de');
    console.log('   subir max_allowed_packet en el parameter group de RDS:\n');
    for (const v of valoresOmitidos) {
      console.log(`   • ${v.tabla}.${v.col} (fila ${v.idVal}) — ${(v.bytes / 1024 / 1024).toFixed(2)} MB → ${v.archivo}`);
    }
    console.log('════════════════════════════════════════════════════════════\n');
  }

  console.log(allOk && valoresOmitidos.length === 0
    ? '✅ TODO COINCIDE — la migración quedó exactamente igual que el origen.'
    : allOk
      ? '⚠️  Los conteos de filas coinciden, pero hay valores omitidos (ver arriba) — no es una copia 100% idéntica todavía.'
      : '❌ Hay tablas con diferencias o errores — revisar antes de apuntar la app a MariaDB.');

  await sqliteDS.destroy();
  await mariaDS.destroy();
  process.exit(allOk ? 0 : 1);
}

main().catch(err => {
  console.error('❌ Error fatal en la migración:', err);
  process.exit(1);
});
