/**
 * diagnose-fk-2.ts
 *
 * Reproduce a mano la ALTER TABLE que falla y lee el detalle exacto que
 * InnoDB guarda en "SHOW ENGINE INNODB STATUS" (sección LATEST FOREIGN KEY
 * ERROR), que es mucho más específico que el errno 150 genérico.
 * No deja cambios: si la ALTER llega a funcionar, la revierte al final.
 *
 * Uso: npx ts-node src/scripts/diagnose-fk-2.ts
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

  console.log('Intentando la ALTER TABLE manualmente...');
  let fallo = false;
  try {
    await ds.query(
      'ALTER TABLE `received_invoice_lineas` ADD CONSTRAINT `FK_diag_test` ' +
      'FOREIGN KEY (`unidad_medida_codigo`) REFERENCES `cat_unidades_medida`(`codigo`) ' +
      'ON DELETE SET NULL ON UPDATE NO ACTION'
    );
    console.log('✅ ¡La ALTER TABLE funcionó! (revirtiendo el constraint de prueba)');
    await ds.query('ALTER TABLE `received_invoice_lineas` DROP FOREIGN KEY `FK_diag_test`');
  } catch (err) {
    fallo = true;
    console.log('❌ Falló igual, como esperado. Detalle:', err instanceof Error ? err.message : err);
  }

  if (fallo) {
    console.log('\n== SHOW ENGINE INNODB STATUS → sección LATEST FOREIGN KEY ERROR ==\n');
    const rows = await ds.query('SHOW ENGINE INNODB STATUS');
    const status: string = rows?.[0]?.Status || '';
    const marker = 'LATEST FOREIGN KEY ERROR';
    const idx = status.indexOf(marker);
    if (idx >= 0) {
      const seccion = status.slice(idx, idx + 2500);
      console.log(seccion);
    } else {
      console.log('(No se encontró la sección "LATEST FOREIGN KEY ERROR" — puede que este usuario de RDS no tenga permiso de PROCESS/SUPER para ver el status completo)');
      console.log('\n--- Primeras 1000 chars del status completo, por si sirve ---\n');
      console.log(status.slice(0, 1000) || '(vacío / sin permiso)');
    }
  }

  // Datos extra: ¿el UNIQUE index de codigo es realmente USABLE como target de FK?
  // (a veces MariaDB exige que sea el ÚNICO index que empieza por esa columna, sin
  // otro index más "ancho" que confunda al optimizador de FKs)
  console.log('\n== Todos los índices de cat_unidades_medida (detalle completo) ==');
  console.table(await ds.query('SHOW INDEX FROM cat_unidades_medida'));

  console.log('\n== Todos los índices de received_invoice_lineas (detalle completo) ==');
  console.table(await ds.query('SHOW INDEX FROM received_invoice_lineas'));

  console.log('\n== CREATE TABLE cat_unidades_medida ==');
  const ct1 = await ds.query('SHOW CREATE TABLE cat_unidades_medida');
  console.log(ct1?.[0]?.['Create Table'] || ct1);

  console.log('\n== CREATE TABLE received_invoice_lineas ==');
  const ct2 = await ds.query('SHOW CREATE TABLE received_invoice_lineas');
  console.log(ct2?.[0]?.['Create Table'] || ct2);

  await ds.destroy();
}

main().catch(e => { console.error('❌ Error:', e); process.exit(1); });
