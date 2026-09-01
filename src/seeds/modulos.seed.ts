/**
 * Seed de modulos y submodulos del sistema.
 * Se ejecuta al iniciar el backend (idempotente: no borra ni duplica).
 * Los usuarios existentes reciben todos los modulos activos por defecto.
 */
import { DataSource } from 'typeorm';
import { Modulo } from '../entities/Modulo';
import { UsuarioModulo } from '../entities/UsuarioModulo';
import { User } from '../entities/User';

interface ModuloDef {
  codigo: string;
  nombre: string;
  descripcion: string;
  icono: string;
  orden: number;
  submodulos?: Omit<ModuloDef, 'submodulos'>[];
}

export const MODULOS_DEF: ModuloDef[] = [
  {
    codigo: 'comercial',
    nombre: 'Comercial',
    descripcion: 'Facturacion electronica, notas y cartera de clientes',
    icono: 'ti-building-store',
    orden: 1,
    submodulos: [
      { codigo: 'comercial-productos',    nombre: 'Productos',        descripcion: 'Catalogo de productos y servicios',    icono: 'ti-package',          orden: 1 },
      { codigo: 'comercial-precios',      nombre: 'Listas de precio', descripcion: 'Listas de precios por segmento',       icono: 'ti-tags',             orden: 2 },
      { codigo: 'comercial-cotizaciones', nombre: 'Cotizaciones',     descripcion: 'Cotizaciones y propuestas comerciales', icono: 'ti-file-description', orden: 3 },
      { codigo: 'facturas',               nombre: 'Facturas',         descripcion: 'Facturas electronicas DIAN',           icono: 'ti-file-invoice',     orden: 4 },
      { codigo: 'notas-credito',          nombre: 'Notas Credito',    descripcion: 'Notas credito de facturas',            icono: 'ti-file-minus',       orden: 5 },
      { codigo: 'notas-debito',           nombre: 'Notas Debito',     descripcion: 'Notas debito de facturas',             icono: 'ti-file-plus',        orden: 6 },
      { codigo: 'cartera',                nombre: 'Cartera',          descripcion: 'Gestion de cartera y cobros',          icono: 'ti-coin',             orden: 7 },
    ],
  },
  {
    codigo: 'compras',
    nombre: 'Compras',
    descripcion: 'Facturas recibidas y gestion de terceros',
    icono: 'ti-shopping-cart',
    orden: 2,
    submodulos: [
      { codigo: 'recibidas',  nombre: 'Facturas Recibidas', descripcion: 'Facturas de proveedores recibidas',                              icono: 'ti-file-download', orden: 1 },
      { codigo: 'compras-ds', nombre: 'Documentos Soporte', descripcion: 'Documento soporte DS y notas de ajuste para no obligados DIAN', icono: 'ti-file-check',    orden: 2 },
      { codigo: 'compras-dr', nombre: 'Documentos Recibidos', descripcion: 'Bandeja de facturas electronicas recibidas y eventos RADIAN (acuse, recibo, aceptacion)', icono: 'ti-inbox-in', orden: 3 },
      { codigo: 'terceros',   nombre: 'Terceros',           descripcion: 'Clientes y proveedores',                                         icono: 'ti-users',         orden: 4 },
    ],
  },
  {
    codigo: 'salud',
    nombre: 'Salud',
    descripcion: 'Facturacion electronica sector salud (RIPS, PGP, Evento)',
    icono: 'ti-heart-rate-monitor',
    orden: 3,
    submodulos: [
      { codigo: 'salud-facturas',  nombre: 'Facturas Salud',      descripcion: 'Facturas PGP y Evento DIAN',     icono: 'ti-file-invoice',      orden: 1 },
      { codigo: 'salud-facturas-clientes', nombre: 'Facturas Clientes', descripcion: 'Facturacion al paciente con tirilla POS, para personal fuera del equipo contable', icono: 'ti-receipt', orden: 2 },
      { codigo: 'salud-nc',        nombre: 'Notas Credito Salud', descripcion: 'Notas credito del modulo salud', icono: 'ti-file-minus',        orden: 3 },
      { codigo: 'salud-nd',        nombre: 'Notas Debito Salud',  descripcion: 'Notas debito del modulo salud',  icono: 'ti-file-plus',         orden: 4 },
      { codigo: 'salud-eps',       nombre: 'EPS',                  descripcion: 'Gestion de EPS',                icono: 'ti-building-hospital', orden: 5 },
      { codigo: 'salud-contratos', nombre: 'Contratos',            descripcion: 'Contratos con EPS',             icono: 'ti-clipboard-list',    orden: 6 },
      { codigo: 'salud-servicios', nombre: 'Servicios',            descripcion: 'Catalogo de servicios de salud', icono: 'ti-stethoscope',      orden: 7 },
      { codigo: 'salud-cargue',    nombre: 'Cargue de Registros',  descripcion: 'Cargue masivo de facturas evento desde Excel', icono: 'ti-table-import', orden: 8 },
    ],
  },
  {
    codigo: 'contabilidad',
    nombre: 'Contabilidad',
    descripcion: 'Plan de cuentas, asientos, centros de costo y cierre de periodo',
    icono: 'ti-book',
    orden: 4,
    submodulos: [
      { codigo: 'cont-puc',          nombre: 'Plan de Cuentas',   descripcion: 'Plan unico de cuentas PUC',        icono: 'ti-list-tree',        orden: 1 },
      { codigo: 'cont-asientos',     nombre: 'Asientos',          descripcion: 'Asientos contables',               icono: 'ti-writing',          orden: 2 },
      { codigo: 'cont-centros',      nombre: 'Centros de Costo',  descripcion: 'Gestion de centros de costo',      icono: 'ti-building',         orden: 3 },
      { codigo: 'cont-sedes',        nombre: 'Sedes',             descripcion: 'Sedes de la empresa',              icono: 'ti-map-pin',          orden: 4 },
      { codigo: 'cont-presupuestos', nombre: 'Presupuestos CC',   descripcion: 'Presupuestos por centro de costo', icono: 'ti-chart-bar',        orden: 5 },
      { codigo: 'cont-cierres',      nombre: 'Cierre de Periodo', descripcion: 'Cierre contable de periodos',      icono: 'ti-lock',             orden: 6 },
      { codigo: 'cont-exogena',      nombre: 'Exogena DIAN',      descripcion: 'Informacion exogena DIAN',         icono: 'ti-report-analytics', orden: 7 },
      { codigo: 'cont-config',       nombre: 'Configuracion Contable', descripcion: 'Cuentas PUC por defecto para cada tipo de evento contable', icono: 'ti-settings', orden: 8 },
    ],
  },
  {
    codigo: 'tesoreria',
    nombre: 'Tesoreria',
    descripcion: 'Cajas, bancos, movimientos y conciliacion',
    icono: 'ti-building-bank',
    orden: 5,
    submodulos: [
      { codigo: 'tes-cuentas',      nombre: 'Cajas y Bancos', descripcion: 'Cuentas de tesoreria',  icono: 'ti-cash',         orden: 1 },
      { codigo: 'tes-movimientos',  nombre: 'Movimientos',    descripcion: 'Ingresos y egresos',    icono: 'ti-transfer',     orden: 2 },
      { codigo: 'tes-conciliacion', nombre: 'Conciliacion',   descripcion: 'Conciliacion bancaria', icono: 'ti-checkup-list', orden: 3 },
    ],
  },
  {
    codigo: 'impuestos',
    nombre: 'Impuestos',
    descripcion: 'IVA, retenciones e ICA',
    icono: 'ti-receipt-tax',
    orden: 6,
    submodulos: [
      { codigo: 'imp-iva',         nombre: 'IVA',         descripcion: 'Liquidacion de IVA',              icono: 'ti-percentage',           orden: 1 },
      { codigo: 'imp-retenciones', nombre: 'Retenciones', descripcion: 'Retenciones en la fuente',        icono: 'ti-arrows-transfer-down', orden: 2 },
      { codigo: 'imp-ica',         nombre: 'ICA',         descripcion: 'Impuesto de industria y comercio', icono: 'ti-building-community',  orden: 3 },
    ],
  },
  {
    codigo: 'reportes',
    nombre: 'Reportes',
    descripcion: 'Reportes gerenciales, comerciales, contables y de impuestos',
    icono: 'ti-chart-line',
    orden: 7,
    submodulos: [
      { codigo: 'rep-comercial',    nombre: 'Reporte Comercial',  descripcion: 'Dashboard comercial y ventas',    icono: 'ti-chart-bar',              orden: 1 },
      { codigo: 'rep-ejecutivo',    nombre: 'Reporte Ejecutivo',  descripcion: 'KPIs ejecutivos',                 icono: 'ti-presentation-analytics', orden: 2 },
      { codigo: 'rep-ventas',       nombre: 'Reporte de Ventas',  descripcion: 'Analisis de ventas',              icono: 'ti-trending-up',            orden: 3 },
      { codigo: 'rep-contabilidad', nombre: 'Reporte Contable',   descripcion: 'Balance y estado de resultados',  icono: 'ti-report',                 orden: 4 },
      { codigo: 'rep-impuestos',    nombre: 'Reporte Impuestos',  descripcion: 'Resumen tributario',              icono: 'ti-file-analytics',         orden: 5 },
      { codigo: 'rep-estadisticas', nombre: 'Estadisticas',       descripcion: 'Estadisticas de actividad por usuario y modulo', icono: 'ti-users-group', orden: 6 },
    ],
  },
  {
    codigo: 'configuracion',
    nombre: 'Configuracion',
    descripcion: 'Configuracion de empresa, DIAN y usuarios del sistema',
    icono: 'ti-settings',
    orden: 8,
    submodulos: [
      { codigo: 'conf-empresa',  nombre: 'Empresa & DIAN',      descripcion: 'Datos de empresa y configuracion DIAN',  icono: 'ti-building-cog', orden: 1 },
      { codigo: 'conf-usuarios', nombre: 'Gestion de Usuarios', descripcion: 'Crear y administrar usuarios y permisos', icono: 'ti-users-group',  orden: 2 },
    ],
  },
];

export async function seedModulos(ds: DataSource): Promise<void> {
  const moduloRepo    = ds.getRepository(Modulo);
  const usuModuloRepo = ds.getRepository(UsuarioModulo);
  const userRepo      = ds.getRepository(User);

  let insertados = 0;

  for (const def of MODULOS_DEF) {
    let padre = await moduloRepo.findOne({ where: { codigo: def.codigo } });
    if (!padre) {
      padre = await moduloRepo.save(moduloRepo.create({
        codigo:       def.codigo,
        nombre:       def.nombre,
        descripcion:  def.descripcion,
        icono:        def.icono,
        orden:        def.orden,
        es_submodulo: false,
        activo:       true,
      }));
      insertados++;
    }

    for (const sub of def.submodulos ?? []) {
      const existeSub = await moduloRepo.findOne({ where: { codigo: sub.codigo } });
      if (!existeSub) {
        await moduloRepo.save(moduloRepo.create({
          codigo:          sub.codigo,
          nombre:          sub.nombre,
          descripcion:     sub.descripcion,
          icono:           sub.icono,
          orden:           sub.orden,
          es_submodulo:    true,
          modulo_padre_id: padre.id,
          activo:          true,
        }));
        insertados++;
      }
    }
  }

  if (insertados > 0) {
    console.log(`[Seed] ${insertados} modulos insertados`);
  }

  // Desactivar (sin borrar) modulos huerfanos: codigos que quedaron en la BD
  // de una version anterior de MODULOS_DEF pero que ya no existen aqui (por
  // ejemplo, un submodulo que se renombro o se consolido bajo otro codigo).
  // No se eliminan para no perder el historial de asignaciones (UsuarioModulo),
  // solo se marcan activo=false para que dejen de aparecer como opcion en
  // Gestion de Usuarios y en la plantilla de cargue masivo.
  const codigosVigentes = new Set<string>(
    MODULOS_DEF.flatMap(m => [m.codigo, ...(m.submodulos ?? []).map(s => s.codigo)])
  );
  const modulosActivos = await moduloRepo.find({ where: { activo: true } });
  let desactivados = 0;
  for (const modulo of modulosActivos) {
    if (!codigosVigentes.has(modulo.codigo)) {
      await moduloRepo.update(modulo.id, { activo: false });
      desactivados++;
      console.log(`[Seed] Modulo huerfano desactivado: ${modulo.codigo} (${modulo.nombre})`);
    }
  }
  if (desactivados > 0) {
    console.log(`[Seed] ${desactivados} modulo(s) huerfano(s) desactivado(s)`);
  }

  // Solo asignar módulos automáticamente a superadmins y admins.
  // Los usuarios regulares reciben módulos únicamente a través del panel de administración.
  // NO tocar usuarios que ya tienen asignaciones — el DELETE+INSERT del admin borraría
  // sus filas y el seed las volvería a crear todas en el próximo reinicio.
  const todosModulos = await moduloRepo.find({ where: { activo: true } });
  const admins = await userRepo.find({ where: [{ role: 'superadmin' }, { role: 'admin' }] });

  let asignados = 0;
  for (const user of admins) {
    for (const modulo of todosModulos) {
      const existe = await usuModuloRepo.findOne({
        where: { user_id: user.id, modulo_id: modulo.id },
      });
      if (!existe) {
        await usuModuloRepo.save(usuModuloRepo.create({
          user_id:      user.id,
          modulo_id:    modulo.id,
          activo:       true,
          asignado_por: 'seed',
        }));
        asignados++;
      }
    }
  }

  if (asignados > 0) {
    console.log(`[Seed] ${asignados} asignaciones de modulos creadas para admins`);
  }
}
