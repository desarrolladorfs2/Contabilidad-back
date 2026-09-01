/**
 * consecutivo.util.ts
 *
 * Reserva de forma atómica el siguiente valor de un contador de
 * company_settings (next_invoice_number, next_credit_note_number, etc.).
 *
 * Antes esto se hacía con `UPDATE ... RETURNING` en una sola sentencia. Eso
 * funciona en SQLite (3.35+), pero MariaDB/MySQL NO soportan RETURNING en
 * UPDATE (solo lo agregaron para INSERT) — por eso, al migrar a AWS RDS
 * MariaDB, cada intento de generar una factura (normal o de salud), nota
 * crédito o nota débito fallaba con "You have an error in your SQL syntax
 * ... near 'RETURNING next_invoice_number'".
 *
 * Esta función reemplaza ese patrón por UPDATE + SELECT dentro de la MISMA
 * transacción/conexión: el bloqueo de fila que MariaDB toma durante el
 * UPDATE se mantiene hasta el COMMIT, así que una segunda solicitud
 * concurrente que intente actualizar la misma fila queda bloqueada hasta que
 * la primera confirme — cerrando la misma ventana de carrera que buscaba
 * cerrar RETURNING, mediante SQL estándar compatible con ambos motores.
 */
import { DataSource } from 'typeorm';

// Lista blanca de columnas válidas — evita interpolar cualquier cadena
// arbitraria en el SQL (los nombres de columna no se pueden parametrizar).
const COLUMNAS_PERMITIDAS = new Set([
  'next_invoice_number',
  'next_credit_note_number',
  'next_debit_note_number',
  'next_health_invoice_number',
  'next_health_credit_note_number',
  'next_health_debit_note_number',
  'next_ds_number',
  'next_nota_ajuste_ds_number',
]);

export async function reservarConsecutivo(
  ds: DataSource,
  companyId: string,
  columna: string,
): Promise<number> {
  if (!COLUMNAS_PERMITIDAS.has(columna)) {
    throw new Error(`reservarConsecutivo: columna no permitida: ${columna}`);
  }

  const queryRunner = ds.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();
  try {
    await queryRunner.query(
      `UPDATE company_settings SET ${columna} = ${columna} + 1 WHERE company_id = ?`,
      [companyId],
    );
    const rows = await queryRunner.query(
      `SELECT ${columna} AS valor FROM company_settings WHERE company_id = ?`,
      [companyId],
    ) as { valor: number }[];
    await queryRunner.commitTransaction();
    return (rows[0]?.valor ?? 2) - 1;
  } catch (e) {
    await queryRunner.rollbackTransaction();
    throw e;
  } finally {
    await queryRunner.release();
  }
}
