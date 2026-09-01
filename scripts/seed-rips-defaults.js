/**
 * seed-rips-defaults.js
 * Asigna valores RIPS por defecto a los servicios de salud según su categoría.
 * Ejecutar con el backend DETENIDO:
 *   node backend/scripts/seed-rips-defaults.js
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'akribeia.db');

async function main() {
  const SQL = await initSqlJs();
  const fileBuffer = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(fileBuffer);

  const updates = [
    {
      // Resolución 2275/2023: finalidad 15=Diagnóstico, causa 38=Enfermedad general
      cat: 'consultas',
      sql: `UPDATE salud_servicios SET
              modalidad_grupo_servicio   = '01',
              grupo_servicios            = '01',
              finalidad_tecnologia_salud = '15',
              causa_motivo_atencion      = '38',
              tipo_diagnostico_principal = '02'
            WHERE categoria = 'consultas'
              AND (modalidad_grupo_servicio IS NULL OR modalidad_grupo_servicio = '')`,
    },
    {
      // viaIngreso 01=Demanda espontánea; grupo 02=Apoyo diagnóstico
      cat: 'procedimientos',
      sql: `UPDATE salud_servicios SET
              modalidad_grupo_servicio   = '01',
              grupo_servicios            = '02',
              finalidad_tecnologia_salud = '15',
              causa_motivo_atencion      = '38',
              tipo_diagnostico_principal = '02',
              via_ingreso                = '01'
            WHERE categoria = 'procedimientos'
              AND (modalidad_grupo_servicio IS NULL OR modalidad_grupo_servicio = '')`,
    },
    {
      cat: 'medicamentos',
      sql: `UPDATE salud_servicios SET
              tipo_medicamento = '1',
              unidad_medida    = 'UND'
            WHERE categoria = 'medicamentos'
              AND (tipo_medicamento IS NULL OR tipo_medicamento = '')`,
    },
    {
      cat: 'otrosServicios',
      sql: `UPDATE salud_servicios SET
              tipo_otro_servicio = '5',
              unidad_medida      = 'UND'
            WHERE categoria = 'otrosServicios'
              AND (tipo_otro_servicio IS NULL OR tipo_otro_servicio = '')`,
    },
  ];

  for (const u of updates) {
    db.run(u.sql);
    console.log(`✓ ${u.cat} actualizados`);
  }

  // Vista previa
  const stmt = db.prepare(`
    SELECT codigo_cups, categoria,
           modalidad_grupo_servicio, grupo_servicios,
           finalidad_tecnologia_salud, tipo_diagnostico_principal,
           via_ingreso, tipo_medicamento, tipo_otro_servicio, unidad_medida
    FROM salud_servicios ORDER BY categoria, codigo_cups
  `);
  console.log('\nCUPS         | Categoría         | Mod | Grp | Fin | TipoDx | Via | TipoMed | TipoOS | Unidad');
  console.log('-'.repeat(100));
  while (stmt.step()) {
    const r = stmt.getAsObject();
    console.log(
      `${String(r.codigo_cups).padEnd(13)}| ${String(r.categoria).padEnd(18)}| ${r.modalidad_grupo_servicio||'-'} | ${r.grupo_servicios||'-'} | ${r.finalidad_tecnologia_salud||'-'} | ${r.tipo_diagnostico_principal||'-'} | ${r.via_ingreso||'-'} | ${r.tipo_medicamento||'-'} | ${r.tipo_otro_servicio||'-'} | ${r.unidad_medida||'-'}`
    );
  }
  stmt.free();

  // Guardar de vuelta al archivo
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
  db.close();
  console.log('\n✅ BD guardada. Puedes reiniciar el backend.');
}

main().catch(err => {
  if (err.code === 'EBUSY' || (err.message && err.message.includes('locked'))) {
    console.error('❌ La base de datos está bloqueada. Detén el backend primero.');
  } else {
    console.error('❌ Error:', err.message);
  }
  process.exit(1);
});
