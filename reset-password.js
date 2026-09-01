/**
 * reset-password.js
 * Resetea la contraseña de UNO o VARIOS usuarios en la BD sql.js.
 * Uso: node reset-password.js
 * Ejecutar desde SP_Dian_V2/backend/ con el backend PARADO.
 */

const bcrypt = require('bcryptjs');
const path   = require('path');
const fs     = require('fs');

// ── Usuarios a actualizar ─────────────────────────────────────────────────────
const USUARIOS = [
  { email: 'gesis2@neurum.com.co',      password: 'Neurum2026' },
  { email: 'facturador1@neurum.com.co', password: 'Neurum2026' },
];
const DB_PATH = path.resolve(__dirname, 'data', 'akribeia.db');
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  let SQL;
  try {
    SQL = require('sql.js');
  } catch {
    console.error('❌  sql.js no encontrado. Ejecuta: npm install sql.js  (en backend/)');
    process.exit(1);
  }

  if (!fs.existsSync(DB_PATH)) {
    console.error('❌  No se encontró la BD en:', DB_PATH);
    process.exit(1);
  }

  const sqljs = await SQL();
  const buf   = fs.readFileSync(DB_PATH);
  const db    = new sqljs.Database(buf);

  // Detectar nombre de tabla (puede ser 'users' o 'user')
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','user')");
  const tableName = tables[0]?.values[0]?.[0] ?? 'users';
  console.log(`\n[DB] Tabla de usuarios detectada: '${tableName}'`);

  // Mostrar todos los usuarios
  const all = db.exec(`SELECT id, name, email, role FROM ${tableName}`);
  if (!all.length || !all[0].values.length) {
    console.log('⚠️  No hay usuarios en la BD. Usa POST /api/auth/setup para crear el primero.');
    db.close();
    return;
  }

  console.log('\nUsuarios actuales:');
  all[0].values.forEach(([id, name, email, role]) =>
    console.log(`  id=${id}  email=${email}  nombre=${name}  rol=${role}`)
  );
  console.log('');

  let cambios = 0;
  for (const { email, password } of USUARIOS) {
    const found = db.exec(`SELECT id FROM ${tableName} WHERE LOWER(email) = '${email.toLowerCase()}'`);
    if (!found.length || !found[0].values.length) {
      console.log(`⚠️  Usuario '${email}' no encontrado — omitido.`);
      continue;
    }
    const userId = found[0].values[0][0];
    const hash   = await bcrypt.hash(password, 12);
    db.run(`UPDATE ${tableName} SET password_hash = ?, debe_cambiar_password = 0 WHERE id = ?`, [hash, userId]);
    console.log(`✅  ${email} → contraseña actualizada a '${password}'`);
    cambios++;
  }

  if (cambios === 0) {
    console.log('\n⚠️  No se realizaron cambios.');
    db.close();
    return;
  }

  // Escritura ATÓMICA: .tmp → rename (evita corrupción si el proceso muere a mitad)
  const data    = db.export();
  const tmpPath = DB_PATH + '.tmp';
  fs.writeFileSync(tmpPath, Buffer.from(data));
  fs.renameSync(tmpPath, DB_PATH);
  db.close();

  console.log(`\n✅  BD guardada correctamente (${cambios} usuario(s) actualizado(s)).`);
  console.log('   Reinicia el backend y prueba el login.');
}

main().catch(e => { console.error(e); process.exit(1); });
