/**
 * diagnose-fk.ts
 *
 * Diagnóstico de solo lectura contra MariaDB (FEV) para entender por qué
 * falla la FK entre `received_invoice_lineas.unidad_medida_codigo` y
 * `cat_unidades_medida.codigo` (errno 150). No modifica nada.
 *
 * Uso: npx ts-node src/scripts/diagnose-fk.ts
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';

const ds = new DataSource({
  type: 'mariadb',
  host: 'pruebas-produccionhealthsphere.ce6agou8m1rx.us-east-1.rds.amazonaws.com',
  port: 3306,
  username: 'admin',
  password: 'Neurum*2025',
  database: 'FEV',
  charset: 'utf8mb4_unicode_ci',
});

async function main(): Promise<void> {
  await ds.initialize();
  console.log('✅ Conectado a FEV\n');

  console.log('== Server / DB default collation ==');
  console.table(await ds.query(`
    SELECT @@character_set_server AS server_charset, @@collation_server AS server_collation,
           @@character_set_database AS db_charset, @@collation_database AS db_collation
  `));

  console.log('\n== Existen las dos tablas? (engine + collation de tabla) ==');
  console.table(await ds.query(`
    SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
    FROM information_schema.tables
    WHERE TABLE_SCHEMA = 'FEV'
      AND TABLE_NAME IN ('cat_unidades_medida', 'received_invoice_lineas')
  `));

  console.log('\n== Columnas involucradas (charset/collation/tipo) ==');
  console.table(await ds.query(`
    SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, CHARACTER_SET_NAME, COLLATION_NAME, IS_NULLABLE, COLUMN_KEY
    FROM information_schema.columns
    WHERE TABLE_SCHEMA = 'FEV'
      AND (
        (TABLE_NAME = 'cat_unidades_medida' AND COLUMN_NAME = 'codigo')
        OR (TABLE_NAME = 'received_invoice_lineas' AND COLUMN_NAME = 'unidad_medida_codigo')
      )
  `));

  console.log('\n== Índices en cat_unidades_medida (¿tiene UNIQUE en "codigo"?) ==');
  try {
    console.table(await ds.query(`SHOW INDEX FROM cat_unidades_medida`));
  } catch (e) {
    console.log('  (no se pudo leer — puede que la tabla no exista todavía)', e instanceof Error ? e.message : e);
  }

  console.log('\n== ¿Existe ya alguna FK a medias en received_invoice_lineas? ==');
  try {
    console.table(await ds.query(`
      SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
      FROM information_schema.key_column_usage
      WHERE TABLE_SCHEMA = 'FEV' AND TABLE_NAME = 'received_invoice_lineas'
    `));
  } catch (e) {
    console.log('  (no se pudo leer)', e instanceof Error ? e.message : e);
  }

  await ds.destroy();
}

main().catch(e => { console.error('❌ Error:', e); process.exit(1); });
