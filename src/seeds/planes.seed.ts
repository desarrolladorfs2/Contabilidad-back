/**
 * Seed de planes de suscripción iniciales.
 * Idempotente — no duplica ni elimina planes existentes.
 */
import { DataSource } from 'typeorm';
import { Plan } from '../entities/Plan';

const PLANES_INICIALES: Partial<Plan>[] = [
  {
    nombre:              'Prueba',
    descripcion:         'Período de evaluación gratuito. Incluye acceso completo por 30 días.',
    max_usuarios:        3,
    max_almacenamiento_mb: 200,
    moneda:              'COP',
    es_prueba:           true,
    duracion_prueba_dias: 30,
    activo:              true,
    orden:               0,
  },
  {
    nombre:              'Básico',
    descripcion:         'Para pequeñas empresas. Facturación electrónica y módulos esenciales.',
    max_usuarios:        5,
    max_almacenamiento_mb: 500,
    precio_mensual:      150000,
    precio_anual:        1500000,
    moneda:              'COP',
    es_prueba:           false,
    activo:              true,
    orden:               1,
  },
  {
    nombre:              'Estándar',
    descripcion:         'Para empresas en crecimiento. Incluye contabilidad y tesorería.',
    max_usuarios:        15,
    max_almacenamiento_mb: 2048,
    precio_mensual:      350000,
    precio_anual:        3500000,
    moneda:              'COP',
    es_prueba:           false,
    activo:              true,
    orden:               2,
  },
  {
    nombre:              'Premium',
    descripcion:         'Todos los módulos habilitados. Salud, impuestos y reportes avanzados.',
    max_usuarios:        50,
    max_almacenamiento_mb: 10240,
    precio_mensual:      650000,
    precio_anual:        6500000,
    moneda:              'COP',
    es_prueba:           false,
    activo:              true,
    orden:               3,
  },
  {
    nombre:              'Enterprise',
    descripcion:         'Usuarios y almacenamiento ilimitados. SLA dedicado y soporte prioritario.',
    max_usuarios:        -1,
    max_almacenamiento_mb: -1,
    moneda:              'COP',
    es_prueba:           false,
    activo:              true,
    orden:               4,
    notas_internas:      'Precio negociado directamente con el cliente.',
  },
];

export async function seedPlanes(ds: DataSource): Promise<void> {
  const repo = ds.getRepository(Plan);
  let insertados = 0;

  for (const plan of PLANES_INICIALES) {
    const existe = await repo.findOne({ where: { nombre: plan.nombre } });
    if (!existe) {
      await repo.save(repo.create(plan));
      insertados++;
    }
  }

  if (insertados > 0) {
    console.log(`[Seed] ${insertados} planes insertados`);
  }
}
