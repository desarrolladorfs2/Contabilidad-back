const SQL  = require('sql.js');
const fs   = require('fs');
const path = require('path');

const DB_PATH   = path.resolve(__dirname, 'data', 'akribeia.db');
const NUEVO_NIT = '900746052';

async function main() {
  const sqljs = await SQL();
  const buf   = fs.readFileSync(DB_PATH);
  const db    = new sqljs.Database(buf);

  const antes = db.exec('SELECT id, nit, name FROM companies');
  console.log('Empresa actual:', antes[0]?.values);

  db.run(`UPDATE companies SET nit = ? WHERE 1=1`, [NUEVO_NIT]);

  const despues = db.exec('SELECT id, nit, name FROM companies');
  console.log('Empresa actualizada:', despues[0]?.values);

  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  db.close();
  console.log('✅  NIT actualizado a', NUEVO_NIT);
}

main().catch(e => { console.error(e); process.exit(1); });
