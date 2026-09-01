/**
 * Backfill: actualiza terceros de prueba con datos de retención en la fuente.
 * Idempotente: solo modifica si `tiene_retencion` aún no está configurado.
 * También crea terceros demo con retención si no existen.
 */
import { DataSource } from 'typeorm';
import { Tercero } from '../entities/Tercero';

// Casos de prueba: diferentes modalidades de retención
const DEMO_TERCEROS_RETENCION = [
  {
    nit: '800100200',
    tipo_id: 'NIT',
    nombre: 'Consulting Group SAS',
    nombre_comercial: 'ConsultGroup',
    email: 'pagos@consultgroup.co',
    nivel_tributario: 'O-13',
    es_cliente: true,
    tiene_retencion: true,
    tarifa_retencion: 11,
    concepto_retencion: 'Retención honorarios 11%',
  },
  {
    nit: '900234567',
    tipo_id: 'NIT',
    nombre: 'Servicios Industriales del Norte SAS',
    nombre_comercial: 'SerNorte',
    email: 'cuentas@sernorte.co',
    nivel_tributario: 'R-99-PN',
    es_cliente: true,
    tiene_retencion: true,
    tarifa_retencion: 3.5,
    concepto_retencion: 'Retención servicios 3.5%',
  },
  {
    nit: '1035873202',
    tipo_id: 'CC',
    nombre: 'Carlos Andrés Restrepo',
    email: 'carlos.restrepo@gmail.com',
    nivel_tributario: 'R-99-PN',
    es_cliente: true,
    tiene_retencion: false,
    tarifa_retencion: 0,
    concepto_retencion: undefined,
  },
];

export async function seedRetencionBackfill(ds: DataSource): Promise<void> {
  try {
    const repo = ds.getRepository(Tercero);

    // Buscar la primera empresa disponible
    const anyTercero = await repo.findOne({ where: {} });
    if (!anyTercero) return; // No hay empresas, nada que hacer
    const cid = anyTercero.company_id;

    // Actualizar el tercero demo existente principal si no tiene retención configurada
    const mainDemo = await repo.findOne({ where: { company_id: cid, nit: '900456789' } });
    if (mainDemo && !mainDemo.tiene_retencion) {
      mainDemo.tiene_retencion  = true;
      mainDemo.tarifa_retencion = 3.5;
      mainDemo.concepto_retencion = 'Retención servicios 3.5%';
      await repo.save(mainDemo);
      console.log('[Backfill] Retención actualizada en tercero demo principal (900456789)');
    }

    // Crear/actualizar terceros de prueba con retención
    for (const data of DEMO_TERCEROS_RETENCION) {
      const existing = await repo.findOne({ where: { company_id: cid, nit: data.nit } });
      if (!existing) {
        await repo.save(repo.create({
          company_id: cid,
          ...data,
          es_proveedor: false,
          activo: true,
        }));
        console.log(`[Backfill] Tercero demo con retención creado: ${data.nombre} (${data.nit})`);
      }
    }
  } catch (e) {
    // No bloquear el arranque si falla
    console.error('[Backfill] Error en retencion-backfill.seed:', e);
  }
}
