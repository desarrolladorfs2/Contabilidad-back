/**
 * Hallazgo #19: los asientos creados antes del fix del hallazgo #16 solo
 * guardaron `cuenta_codigo` (texto libre, sin FK) en sus líneas — nunca
 * `cuenta_id` (la relación real hacia `cuentas_puc`). Esto deja sin efecto
 * la protección `onDelete: 'RESTRICT'` de esa relación para esas líneas
 * viejas: hoy se podría borrar del PUC una cuenta con movimientos históricos
 * porque, en la práctica, nada le apunta por FK.
 *
 * Este backfill recorre las líneas de asiento existentes que tienen
 * `cuenta_codigo` pero no `cuenta_id`, busca la cuenta PUC correspondiente
 * por (company_id, codigo) — vía el asiento padre, para resolver la empresa
 * dueña — y completa la relación. No reescribe ni recalcula ningún valor
 * monetario, solo completa un FK que hoy falta.
 *
 * Idempotente — solo toca líneas con cuenta_id IS NULL. Si una línea no
 * encuentra una cuenta PUC con ese código en su empresa (código legado o
 * cuenta ya eliminada), se deja tal como está (no se inventa ninguna cuenta).
 * Se ejecuta automáticamente desde database.ts al arrancar el backend.
 */
import { DataSource } from 'typeorm';
import { LineaAsiento } from '../entities/contabilidad/LineaAsiento';
import { CuentaPUC } from '../entities/contabilidad/CuentaPUC';

export async function backfillLineaAsientoCuentaId(ds: DataSource): Promise<void> {
  const lineaRepo = ds.getRepository(LineaAsiento);
  const pucRepo   = ds.getRepository(CuentaPUC);

  const lineas = await lineaRepo
    .createQueryBuilder('l')
    .innerJoinAndSelect('l.asiento', 'a')
    .where('l.cuenta_id IS NULL')
    .andWhere("l.cuenta_codigo IS NOT NULL AND l.cuenta_codigo != ''")
    .getMany();

  if (lineas.length === 0) {
    console.log('[Backfill] linea_asiento.cuenta_id: ya estaba actualizado, nada que migrar');
    return;
  }

  // Cache de cuentas PUC por empresa para no repetir consultas.
  const cacheCuentasPorEmpresa = new Map<string, Map<string, string>>();
  async function resolverCuentaId(companyId: string, codigo: string): Promise<string | undefined> {
    let mapa = cacheCuentasPorEmpresa.get(companyId);
    if (!mapa) {
      const cuentas = await pucRepo.find({ where: { company_id: companyId } });
      mapa = new Map(cuentas.map(c => [c.codigo, c.id]));
      cacheCuentasPorEmpresa.set(companyId, mapa);
    }
    return mapa.get(codigo);
  }

  let actualizadas = 0;
  let sinCoincidencia = 0;
  for (const linea of lineas) {
    const companyId = linea.asiento?.company_id;
    if (!companyId || !linea.cuenta_codigo) continue;
    const cuentaId = await resolverCuentaId(companyId, linea.cuenta_codigo);
    if (cuentaId) {
      await lineaRepo.update({ id: linea.id }, { cuenta_id: cuentaId });
      actualizadas++;
    } else {
      sinCoincidencia++;
    }
  }

  console.log(`[Backfill] linea_asiento.cuenta_id: ${actualizadas} líneas actualizadas, ${sinCoincidencia} sin coincidencia en el PUC (código legado o cuenta eliminada — se dejaron sin tocar)`);
}
