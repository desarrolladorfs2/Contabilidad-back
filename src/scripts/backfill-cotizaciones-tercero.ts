/**
 * Hallazgo #13: backfill de cotizaciones históricas con tercero_id NULL.
 *
 * Para cada cotización sin tercero_id:
 *   1. Intenta encontrar un Tercero existente con el mismo NIT (normalizado)
 *      en la misma empresa — si existe, solo enlaza (no crea duplicado).
 *   2. Si no existe ningún Tercero con ese NIT, crea uno nuevo a partir del
 *      snapshot ya guardado en la cotización (cliente_nombre/cliente_nit),
 *      marcado es_cliente=true, y enlaza la cotización a él.
 *
 * Solo se ejecuta contra la BD de desarrollo (sqlite) — nunca contra AWS/
 * producción, por instrucción explícita del usuario.
 */
import { AppDataSource } from '../config/database';
import { Tercero } from '../entities/Tercero';

async function main() {
  await AppDataSource.initialize();
  const terceroRepo = AppDataSource.getRepository(Tercero);

  // Se usa SQL crudo para el filtro IS NULL — es más confiable entre drivers
  // que pasarle `undefined` al `where` de TypeORM.
  const rows = await AppDataSource.query(
    `SELECT id, company_id, cliente_nombre, cliente_nit FROM cotizaciones WHERE tercero_id IS NULL`,
  ) as { id: string; company_id: string; cliente_nombre: string | null; cliente_nit: string | null }[];

  console.log(`[backfill] ${rows.length} cotizacion(es) con tercero_id NULL`);

  let enlazadas = 0, creadas = 0, omitidas = 0;

  for (const r of rows) {
    if (!r.cliente_nit || !r.cliente_nombre) {
      console.warn(`[backfill] Cotización ${r.id} no tiene snapshot de cliente (nombre/nit) — se omite, requiere revisión manual`);
      omitidas++;
      continue;
    }
    const nitNormalizado = String(r.cliente_nit).replace(/\D/g, '') || String(r.cliente_nit).trim();

    let tercero = await terceroRepo.findOne({ where: { company_id: r.company_id, nit: nitNormalizado } });
    if (!tercero) {
      tercero = terceroRepo.create({
        company_id: r.company_id,
        nit: nitNormalizado,
        nombre: r.cliente_nombre,
        tipo_id: 'NIT',
        es_cliente: true,
        es_proveedor: false,
        activo: true,
        notas: 'Creado automáticamente por el backfill de cotizaciones históricas (hallazgo #13) a partir del snapshot guardado en la cotización.',
      });
      await terceroRepo.save(tercero);
      creadas++;
      console.log(`[backfill] Creado Tercero nuevo "${tercero.nombre}" (NIT ${tercero.nit}) para cotización ${r.id}`);
    } else {
      console.log(`[backfill] Enlazando cotización ${r.id} al Tercero existente "${tercero.nombre}" (NIT ${tercero.nit})`);
    }

    await AppDataSource.query(`UPDATE cotizaciones SET tercero_id = ? WHERE id = ?`, [tercero.id, r.id]);
    enlazadas++;
  }

  console.log(`[backfill] Completado: ${enlazadas} cotizacion(es) enlazadas (${creadas} tercero(s) nuevo(s) creados, ${omitidas} omitida(s)).`);
  await AppDataSource.destroy();
}

main().catch(e => { console.error(e); process.exit(1); });
