/**
 * Seed: novedades globales iniciales del hub principal.
 * Migra el arreglo que antes vivía hardcodeado en hub.component.ts (NEWS) a
 * la tabla `novedades`, como anuncios globales (company_id null → visibles
 * para todas las empresas). Idempotente: solo inserta si la tabla está vacía.
 */
import { DataSource } from 'typeorm';
import { Novedad } from '../entities/Novedad';

const NOVEDADES_INICIALES = [
  { categoria: 'Próximamente',  color: '#6366f1', orden: 0, mensaje: 'Modulo de Contabilidad con PUC colombiano y asientos automaticos desde facturas.' },
  { categoria: 'Actualización', color: '#10b981', orden: 1, mensaje: 'Resolucion DIAN 000165/2023 - validaciones de cufe actualizadas en facturacion en salud.' },
  { categoria: 'Mejora',        color: '#06b6d4', orden: 2, mensaje: 'Facturacion en salud ahora soporta RIPS version 2.2 con nuevos campos de diagnostico.' },
  { categoria: 'Próximamente',  color: '#f59e0b', orden: 3, mensaje: 'Modulo de Tesoreria: cajas, bancos y conciliacion bancaria automatica.' },
];

export async function seedNovedades(ds: DataSource): Promise<void> {
  try {
    const repo = ds.getRepository(Novedad);
    const total = await repo.count();
    if (total > 0) return; // Ya hay novedades (seed anterior o creadas por un usuario) — no tocar

    for (const n of NOVEDADES_INICIALES) {
      await repo.save(repo.create({ ...n, company_id: null, activa: true }));
    }
    console.log(`[Seed] ${NOVEDADES_INICIALES.length} novedades globales iniciales creadas`);
  } catch (e) {
    console.error('[Seed] Error en novedades.seed:', e);
  }
}
