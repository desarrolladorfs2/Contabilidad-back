/**
 * Seed de relaciones Plan <-> Módulo (tabla plan_modulo).
 * Define qué módulos están incluidos en cada plan comercial.
 * Idempotente: no duplica registros existentes.
 */
import { DataSource } from 'typeorm';
import { Plan } from '../entities/Plan';
import { Modulo } from '../entities/Modulo';
import { PlanModulo } from '../entities/PlanModulo';

// Codigos de modulos por plan
// prueba: acceso completo (todos los modulos)
// basico: comercial + compras
// estandar: comercial + compras + contabilidad + tesoreria
// premium: todos
// enterprise: todos

const MODULOS_TODOS = [
  'comercial', 'comercial-productos', 'comercial-precios', 'comercial-cotizaciones',
  'facturas', 'notas-credito', 'notas-debito', 'cartera',
  'compras', 'recibidas', 'terceros',
  'salud', 'salud-facturas', 'salud-nc', 'salud-nd', 'salud-eps', 'salud-contratos', 'salud-servicios',
  'contabilidad', 'cont-puc', 'cont-asientos', 'cont-centros', 'cont-sedes', 'cont-presupuestos', 'cont-cierres', 'cont-exogena', 'cont-config',
  'tesoreria', 'tes-cuentas', 'tes-movimientos', 'tes-conciliacion',
  'impuestos', 'imp-iva', 'imp-retenciones', 'imp-ica',
  'reportes', 'rep-comercial', 'rep-ejecutivo', 'rep-ventas', 'rep-contabilidad', 'rep-impuestos',
  'configuracion', 'conf-empresa', 'conf-usuarios',
];

const MODULOS_BASICO = [
  'comercial', 'comercial-productos', 'comercial-precios', 'comercial-cotizaciones',
  'facturas', 'notas-credito', 'notas-debito', 'cartera',
  'compras', 'recibidas', 'terceros',
  'configuracion', 'conf-empresa', 'conf-usuarios',
  'reportes', 'rep-comercial', 'rep-ventas',
];

const MODULOS_ESTANDAR = [
  ...MODULOS_BASICO,
  'contabilidad', 'cont-puc', 'cont-asientos', 'cont-centros', 'cont-sedes', 'cont-presupuestos', 'cont-cierres', 'cont-exogena', 'cont-config',
  'tesoreria', 'tes-cuentas', 'tes-movimientos', 'tes-conciliacion',
  'impuestos', 'imp-iva', 'imp-retenciones', 'imp-ica',
  'reportes', 'rep-ejecutivo', 'rep-contabilidad', 'rep-impuestos',
];

const PLAN_MODULOS: Record<string, string[]> = {
  'Prueba':      MODULOS_TODOS,
  'Básico':      MODULOS_BASICO,
  'Estándar':    MODULOS_ESTANDAR,
  'Premium':     MODULOS_TODOS,
  'Enterprise':  MODULOS_TODOS,
};

export async function seedPlanModulo(ds: DataSource): Promise<void> {
  const planRepo     = ds.getRepository(Plan);
  const moduloRepo   = ds.getRepository(Modulo);
  const pivotRepo    = ds.getRepository(PlanModulo);

  // Cache de planes, modulos y pares ya existentes para evitar N+1 -- contra
  // una base remota, un findOne() por cada par (plan, modulo) es un viaje de
  // red por par.
  const planes    = await planRepo.find();
  const modulos   = await moduloRepo.find();
  const existentes = await pivotRepo.find({ select: ['plan_id', 'modulo_id'] });
  const moduloMap  = new Map(modulos.map(m => [m.codigo, m]));
  const clavesExistentes = new Set(existentes.map(e => `${e.plan_id}::${e.modulo_id}`));

  const nuevos: PlanModulo[] = [];

  for (const [planNombre, codigosModulo] of Object.entries(PLAN_MODULOS)) {
    const plan = planes.find(p => p.nombre === planNombre);
    if (!plan) {
      console.warn(`[Seed plan-modulo] Plan no encontrado: ${planNombre}`);
      continue;
    }

    for (const codigo of codigosModulo) {
      const modulo = moduloMap.get(codigo);
      if (!modulo) {
        // El modulo puede no existir si el seed de modulos aun no corrió — silenciar
        continue;
      }

      const key = `${plan.id}::${modulo.id}`;
      if (clavesExistentes.has(key)) continue;

      nuevos.push(pivotRepo.create({
        plan_id:   plan.id,
        modulo_id: modulo.id,
        activo:    true,
      }));
      clavesExistentes.add(key);
    }
  }

  if (nuevos.length > 0) {
    await pivotRepo.save(nuevos);
    console.log(`[Seed] ${nuevos.length} relaciones plan-modulo insertadas`);
  }
}
