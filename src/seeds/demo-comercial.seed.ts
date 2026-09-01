/**
 * Seed de datos de DEMO para el módulo comercial.
 * Crea productos, listas de precio y cotizaciones de ejemplo
 * para la primera empresa registrada en el sistema.
 *
 * Idempotente — verifica antes de insertar.
 * Se ejecuta manualmente o desde database.ts (ver comentario al final).
 */
import { DataSource } from 'typeorm';
import { Company }        from '../entities/Company';
import { Producto }       from '../entities/Producto';
import { ListaPrecio }    from '../entities/ListaPrecio';
import { ProductoPrecio } from '../entities/ProductoPrecio';
import { Cotizacion }     from '../entities/Cotizacion';
import { CotizacionLinea } from '../entities/CotizacionLinea';
import { Tercero }        from '../entities/Tercero';
import { Secuencia }      from '../entities/Secuencia';

// ── Helper: calcular línea ────────────────────────────────────────────────────
function calcLinea(qty: number, precio: number, dcto: number, tributo: string, tarifa: number) {
  const descuento_valor = parseFloat((precio * qty * dcto / 100).toFixed(2));
  const subtotal        = parseFloat((precio * qty - descuento_valor).toFixed(2));
  const valor_iva       = tributo === '01' ? parseFloat((subtotal * tarifa / 100).toFixed(2)) : 0;
  const valor_inc       = tributo === '04' ? parseFloat((subtotal * tarifa / 100).toFixed(2)) : 0;
  const total           = parseFloat((subtotal + valor_iva + valor_inc).toFixed(2));
  return { descuento_pct: dcto, descuento_valor, subtotal, valor_iva, valor_inc, total };
}

export async function seedDemoComercial(ds: DataSource): Promise<void> {
  // ── 1. Obtener la primera empresa ─────────────────────────────────────────
  const company = await ds.getRepository(Company).findOne({ where: {}, order: { created_at: 'ASC' } });
  if (!company) {
    console.log('[Demo] No hay empresas registradas — omitiendo seed comercial');
    return;
  }
  const cid = company.id;

  // ── 2. Productos ──────────────────────────────────────────────────────────
  const prodRepo = ds.getRepository(Producto);
  const yaHayProductos = await prodRepo.count({ where: { company_id: cid } });
  if (yaHayProductos > 0) {
    console.log(`[Demo] Productos ya existen para empresa ${company.name} — omitiendo`);
  } else {
    const PRODUCTOS = [
      // Servicios
      { codigo: 'CONS-001', tipo: 'servicio', nombre: 'Consultoría de software',
        descripcion: 'Asesoría y consultoría en desarrollo de software a medida.',
        unidad_medida_codigo: 'HUR', precio_base: 120000,
        tipo_tributo_codigo: '01', tarifa_iva: 19, tarifa_inc: 0,
        codigo_unspsc: '81111500', cuenta_venta: '41009505' },

      { codigo: 'CONS-002', tipo: 'servicio', nombre: 'Soporte técnico mensual',
        descripcion: 'Plan de soporte y mantenimiento de sistemas. Incluye atención remota y presencial.',
        unidad_medida_codigo: 'MON', precio_base: 850000,
        tipo_tributo_codigo: '01', tarifa_iva: 19, tarifa_inc: 0,
        codigo_unspsc: '81112100', cuenta_venta: '41009505' },

      { codigo: 'CONS-003', tipo: 'servicio', nombre: 'Capacitación / Entrenamiento',
        descripcion: 'Sesiones de capacitación en herramientas o procesos. Precio por hora.',
        unidad_medida_codigo: 'HUR', precio_base: 80000,
        tipo_tributo_codigo: '01', tarifa_iva: 19, tarifa_inc: 0,
        codigo_unspsc: '86101505', cuenta_venta: '41009505' },

      { codigo: 'CONS-004', tipo: 'servicio', nombre: 'Implementación de sistema',
        descripcion: 'Servicio de implementación, configuración y puesta en marcha de software.',
        unidad_medida_codigo: 'EA', precio_base: 3500000,
        tipo_tributo_codigo: '01', tarifa_iva: 19, tarifa_inc: 0,
        codigo_unspsc: '81111600', cuenta_venta: '41009510' },

      { codigo: 'LIC-001', tipo: 'servicio', nombre: 'Licencia anual SaaS',
        descripcion: 'Licencia de uso anual de la plataforma. Incluye actualizaciones y soporte básico.',
        unidad_medida_codigo: 'ANN', precio_base: 4200000,
        tipo_tributo_codigo: '01', tarifa_iva: 19, tarifa_inc: 0,
        codigo_unspsc: '43232202', cuenta_venta: '41009520' },

      // Productos físicos
      { codigo: 'PROD-001', tipo: 'producto', nombre: 'Servidor HP ProLiant DL380',
        descripcion: 'Servidor rack 2U, Intel Xeon Silver, 32GB RAM, 2x960GB SSD.',
        unidad_medida_codigo: 'EA', precio_base: 18500000,
        tipo_tributo_codigo: '01', tarifa_iva: 19, tarifa_inc: 0,
        codigo_unspsc: '43211501', cuenta_venta: '41301505', cuenta_costo: '61301505' },

      { codigo: 'PROD-002', tipo: 'producto', nombre: 'Switch Cisco 24 puertos',
        descripcion: 'Switch administrable 24 puertos Gigabit + 4 SFP.',
        unidad_medida_codigo: 'EA', precio_base: 3200000,
        tipo_tributo_codigo: '01', tarifa_iva: 19, tarifa_inc: 0,
        codigo_unspsc: '43222609', cuenta_venta: '41301510', cuenta_costo: '61301510' },

      { codigo: 'PROD-003', tipo: 'producto', nombre: 'UPS 1500VA',
        descripcion: 'Sistema de alimentación ininterrumpida 1500VA / 900W.',
        unidad_medida_codigo: 'EA', precio_base: 780000,
        tipo_tributo_codigo: '01', tarifa_iva: 19, tarifa_inc: 0,
        codigo_unspsc: '26111701', cuenta_venta: '41301515', cuenta_costo: '61301515' },

      // Exentos
      { codigo: 'SERV-EXE', tipo: 'servicio', nombre: 'Exportación de datos (Exento)',
        descripcion: 'Servicio de exportación de datos al exterior. Operación exenta de IVA.',
        unidad_medida_codigo: 'EA', precio_base: 500000,
        tipo_tributo_codigo: 'ZZ', tarifa_iva: 0, tarifa_inc: 0,
        codigo_unspsc: '81112000', cuenta_venta: '41009530' },
    ];

    for (const p of PRODUCTOS) {
      await prodRepo.save(prodRepo.create({ ...p, company_id: cid, activo: true }));
    }
    console.log(`[Demo] ${PRODUCTOS.length} productos creados`);
  }

  // Cargar productos para referencias posteriores
  const productos = await prodRepo.find({ where: { company_id: cid } });
  const byCode = (c: string) => productos.find(p => p.codigo === c)!;

  // ── 3. Listas de precio ───────────────────────────────────────────────────
  const lpRepo  = ds.getRepository(ListaPrecio);
  const ppRepo  = ds.getRepository(ProductoPrecio);
  const yaHayListas = await lpRepo.count({ where: { company_id: cid } });

  let listaGeneral: ListaPrecio;
  let listaVip: ListaPrecio;
  let listaUsd: ListaPrecio;

  if (yaHayListas > 0) {
    console.log('[Demo] Listas de precio ya existen — omitiendo');
    listaGeneral = (await lpRepo.findOne({ where: { company_id: cid, es_defecto: true } }))!;
    listaVip     = (await lpRepo.findOne({ where: { company_id: cid, nombre: 'Lista VIP / Clientes Frecuentes' } }))!;
    listaUsd     = (await lpRepo.findOne({ where: { company_id: cid, moneda_codigo: 'USD' } }))!;
  } else {
    listaGeneral = await lpRepo.save(lpRepo.create({
      company_id: cid, nombre: 'Lista General',
      descripcion: 'Precios estándar para todos los clientes.',
      moneda_codigo: 'COP', es_defecto: true, activo: true,
    }));
    listaVip = await lpRepo.save(lpRepo.create({
      company_id: cid, nombre: 'Lista VIP / Clientes Frecuentes',
      descripcion: 'Precios con descuento para clientes con contrato vigente o volumen alto.',
      moneda_codigo: 'COP', es_defecto: false, activo: true,
    }));
    listaUsd = await lpRepo.save(lpRepo.create({
      company_id: cid, nombre: 'Lista Exportación USD',
      descripcion: 'Precios en dólares para clientes internacionales.',
      moneda_codigo: 'USD', es_defecto: false, activo: true,
    }));

    // Precios en lista general (= precio_base)
    const preciosGeneral = [
      { codigo: 'CONS-001', precio: 120000 },
      { codigo: 'CONS-002', precio: 850000 },
      { codigo: 'CONS-003', precio: 80000  },
      { codigo: 'CONS-004', precio: 3500000 },
      { codigo: 'LIC-001',  precio: 4200000 },
      { codigo: 'PROD-001', precio: 18500000 },
      { codigo: 'PROD-002', precio: 3200000  },
      { codigo: 'PROD-003', precio: 780000   },
    ];
    for (const { codigo, precio } of preciosGeneral) {
      const prod = byCode(codigo);
      if (prod) await ppRepo.save(ppRepo.create({ lista_precio_id: listaGeneral.id, producto_id: prod.id, precio, descuento_pct: 0 }));
    }

    // Precios VIP (10-15% menos)
    const preciosVip = [
      { codigo: 'CONS-001', precio: 105000,   dcto: 12.5 },
      { codigo: 'CONS-002', precio: 745000,   dcto: 12.4 },
      { codigo: 'CONS-003', precio: 70000,    dcto: 12.5 },
      { codigo: 'CONS-004', precio: 2975000,  dcto: 15   },
      { codigo: 'LIC-001',  precio: 3570000,  dcto: 15   },
      { codigo: 'PROD-001', precio: 16650000, dcto: 10   },
      { codigo: 'PROD-002', precio: 2720000,  dcto: 15   },
    ];
    for (const { codigo, precio, dcto } of preciosVip) {
      const prod = byCode(codigo);
      if (prod) await ppRepo.save(ppRepo.create({ lista_precio_id: listaVip.id, producto_id: prod.id, precio, descuento_pct: dcto }));
    }

    // Precios USD (aprox TRM 4100)
    const preciosUsd = [
      { codigo: 'CONS-001', precio: 29.27 },
      { codigo: 'CONS-002', precio: 207.32 },
      { codigo: 'LIC-001',  precio: 1024.39 },
      { codigo: 'PROD-001', precio: 4512.20 },
    ];
    for (const { codigo, precio } of preciosUsd) {
      const prod = byCode(codigo);
      if (prod) await ppRepo.save(ppRepo.create({ lista_precio_id: listaUsd.id, producto_id: prod.id, precio, descuento_pct: 0 }));
    }

    console.log('[Demo] 3 listas de precio creadas con precios de productos');
  }

  // ── 4. Tercero de prueba (si no hay ninguno) ───────────────────────────────
  const terceroRepo = ds.getRepository(Tercero);
  let tercero = await terceroRepo.findOne({ where: { company_id: cid } });
  if (!tercero) {
    tercero = await terceroRepo.save(terceroRepo.create({
      company_id: cid,
      nit: '900456789',
      tipo_id: 'NIT',
      nombre: 'Tecnología Avanzada SAS',
      nombre_comercial: 'TechAvanz',
      email: 'compras@techavanz.co',
      telefono: '6014567890',
      direccion: 'Cra 7 # 32-15 Of 402',
      ciudad_nombre: 'Bogotá',
      departamento_nombre: 'Cundinamarca',
      nivel_tributario: 'O-13',
      es_cliente: true,
      es_proveedor: false,
      activo: true,
    }));
    console.log('[Demo] Tercero de prueba creado');
  }

  // ── 5. Cotizaciones de prueba ─────────────────────────────────────────────
  const cotRepo  = ds.getRepository(Cotizacion);
  const linRepo  = ds.getRepository(CotizacionLinea);
  const seqRepo  = ds.getRepository(Secuencia);
  const yaHayCot = await cotRepo.count({ where: { company_id: cid } });

  if (yaHayCot > 0) {
    console.log('[Demo] Cotizaciones ya existen — omitiendo');
    return;
  }

  // Helper secuencia (inline, sin transacción para seed)
  async function nextNum(prefijo: string): Promise<string> {
    let seq = await seqRepo.findOne({ where: { company_id: cid, entidad: 'cotizacion' } });
    if (!seq) {
      seq = seqRepo.create({ company_id: cid, entidad: 'cotizacion', prefijo, ultimo_numero: 0, longitud_minima: 4, incluir_anio: true });
    }
    seq.ultimo_numero += 1;
    seq.anio_actual = 2026;
    await seqRepo.save(seq);
    return `${prefijo}-2026-${String(seq.ultimo_numero).padStart(4, '0')}`;
  }

  const cons001 = byCode('CONS-001');
  const cons002 = byCode('CONS-002');
  const cons003 = byCode('CONS-003');
  const cons004 = byCode('CONS-004');
  const lic001  = byCode('LIC-001');
  const prod001 = byCode('PROD-001');
  const prod002 = byCode('PROD-002');
  const prod003 = byCode('PROD-003');

  // --- Cotización 1: Borrador ---
  {
    const numero = await nextNum('COT');
    const l1 = calcLinea(10, 120000, 0, '01', 19);
    const l2 = calcLinea(1, 850000, 0, '01', 19);
    const subtotal = l1.subtotal + l2.subtotal;
    const iva      = l1.valor_iva + l2.valor_iva;
    const cot = await cotRepo.save(cotRepo.create({
      company_id: cid, numero, prefijo: 'COT',
      tercero_id: tercero.id,
      cliente_nombre: tercero.nombre, cliente_nit: tercero.nit, cliente_email: tercero.email,
      fecha_emision: '2026-07-01', fecha_vencimiento: '2026-07-31',
      estado: 'borrador',
      moneda_codigo: 'COP', tasa_cambio: 1,
      subtotal, descuento_total: 0, iva_total: iva, inc_total: 0,
      impuestos_total: iva, total: subtotal + iva,
      terminos_condiciones: 'Precio válido por 30 días. Pago 30 días después de entrega.',
      notas_internas: 'Cliente interesado en plan anual — negociar descuento si firma antes de julio.',
    }));
    await linRepo.save(linRepo.create({ cotizacion_id: cot.id, linea_numero: 1, producto_id: cons001?.id,
      descripcion: 'Consultoría de software — análisis de requerimientos', cantidad: 10,
      unidad_medida_codigo: 'HUR', precio_unitario: 120000, tipo_tributo_codigo: '01', tarifa_iva: 19, ...l1 }));
    await linRepo.save(linRepo.create({ cotizacion_id: cot.id, linea_numero: 2, producto_id: cons002?.id,
      descripcion: 'Soporte técnico mensual — primer mes', cantidad: 1,
      unidad_medida_codigo: 'MON', precio_unitario: 850000, tipo_tributo_codigo: '01', tarifa_iva: 19, ...l2 }));
  }

  // --- Cotización 2: Enviada ---
  {
    const numero = await nextNum('COT');
    const l1 = calcLinea(1, 3500000, 0, '01', 19);
    const l2 = calcLinea(5, 80000, 0, '01', 19);
    const subtotal = l1.subtotal + l2.subtotal;
    const iva      = l1.valor_iva + l2.valor_iva;
    const cot = await cotRepo.save(cotRepo.create({
      company_id: cid, numero, prefijo: 'COT',
      tercero_id: tercero.id,
      cliente_nombre: tercero.nombre, cliente_nit: tercero.nit, cliente_email: tercero.email,
      fecha_emision: '2026-06-15', fecha_vencimiento: '2026-07-15',
      estado: 'enviada',
      moneda_codigo: 'COP', tasa_cambio: 1,
      subtotal, descuento_total: 0, iva_total: iva, inc_total: 0,
      impuestos_total: iva, total: subtotal + iva,
      observaciones_cliente: 'Propuesta de implementación del sistema de gestión y capacitación inicial al equipo.',
      terminos_condiciones: 'Forma de pago: 50% anticipo, 50% contra entrega. Garantía 3 meses.',
    }));
    await linRepo.save(linRepo.create({ cotizacion_id: cot.id, linea_numero: 1, producto_id: cons004?.id,
      descripcion: 'Implementación sistema de gestión', cantidad: 1,
      unidad_medida_codigo: 'EA', precio_unitario: 3500000, tipo_tributo_codigo: '01', tarifa_iva: 19, ...l1 }));
    await linRepo.save(linRepo.create({ cotizacion_id: cot.id, linea_numero: 2, producto_id: cons003?.id,
      descripcion: 'Capacitación equipo (5 sesiones x 1 hora)', cantidad: 5,
      unidad_medida_codigo: 'HUR', precio_unitario: 80000, tipo_tributo_codigo: '01', tarifa_iva: 19, ...l2 }));
  }

  // --- Cotización 3: Aprobada ---
  {
    const numero = await nextNum('COT');
    const l1 = calcLinea(1, 4200000, 10, '01', 19);
    const l2 = calcLinea(12, 850000, 10, '01', 19);
    const subtotal = l1.subtotal + l2.subtotal;
    const dcto     = l1.descuento_valor + l2.descuento_valor;
    const iva      = l1.valor_iva + l2.valor_iva;
    const cot = await cotRepo.save(cotRepo.create({
      company_id: cid, numero, prefijo: 'COT',
      tercero_id: tercero.id,
      cliente_nombre: tercero.nombre, cliente_nit: tercero.nit, cliente_email: tercero.email,
      fecha_emision: '2026-05-01', fecha_vencimiento: '2026-06-01',
      estado: 'aprobada',
      moneda_codigo: 'COP', tasa_cambio: 1,
      subtotal, descuento_total: dcto, iva_total: iva, inc_total: 0,
      impuestos_total: iva, total: subtotal + iva,
      observaciones_cliente: 'Incluye 10% de descuento por contrato anual de soporte + licencia.',
      terminos_condiciones: 'Pago a 30 días. Renovación automática salvo cancelación con 30 días de antelación.',
    }));
    await linRepo.save(linRepo.create({ cotizacion_id: cot.id, linea_numero: 1, producto_id: lic001?.id,
      descripcion: 'Licencia anual SaaS — plan corporativo', cantidad: 1,
      unidad_medida_codigo: 'ANN', precio_unitario: 4200000, tipo_tributo_codigo: '01', tarifa_iva: 19, ...l1 }));
    await linRepo.save(linRepo.create({ cotizacion_id: cot.id, linea_numero: 2, producto_id: cons002?.id,
      descripcion: 'Soporte técnico mensual — 12 meses', cantidad: 12,
      unidad_medida_codigo: 'MON', precio_unitario: 850000, tipo_tributo_codigo: '01', tarifa_iva: 19, ...l2 }));
  }

  // --- Cotización 4: Rechazada ---
  {
    const numero = await nextNum('COT');
    const l1 = calcLinea(1, 18500000, 0, '01', 19);
    const l2 = calcLinea(2, 3200000, 0, '01', 19);
    const l3 = calcLinea(1, 780000, 0, '01', 19);
    const subtotal = l1.subtotal + l2.subtotal + l3.subtotal;
    const iva      = l1.valor_iva + l2.valor_iva + l3.valor_iva;
    const cot = await cotRepo.save(cotRepo.create({
      company_id: cid, numero, prefijo: 'COT',
      cliente_nombre: 'Distribuciones Nacionales Ltda', cliente_nit: '830500321',
      fecha_emision: '2026-04-10', fecha_vencimiento: '2026-05-10',
      estado: 'rechazada',
      moneda_codigo: 'COP', tasa_cambio: 1,
      subtotal, descuento_total: 0, iva_total: iva, inc_total: 0,
      impuestos_total: iva, total: subtotal + iva,
      notas_internas: 'Cliente rechazó por presupuesto. Recontactar en Q3.',
    }));
    await linRepo.save(linRepo.create({ cotizacion_id: cot.id, linea_numero: 1, producto_id: prod001?.id,
      descripcion: 'Servidor HP ProLiant DL380', cantidad: 1,
      unidad_medida_codigo: 'EA', precio_unitario: 18500000, tipo_tributo_codigo: '01', tarifa_iva: 19, ...l1 }));
    await linRepo.save(linRepo.create({ cotizacion_id: cot.id, linea_numero: 2, producto_id: prod002?.id,
      descripcion: 'Switch Cisco 24 puertos', cantidad: 2,
      unidad_medida_codigo: 'EA', precio_unitario: 3200000, tipo_tributo_codigo: '01', tarifa_iva: 19, ...l2 }));
    await linRepo.save(linRepo.create({ cotizacion_id: cot.id, linea_numero: 3, producto_id: prod003?.id,
      descripcion: 'UPS 1500VA', cantidad: 1,
      unidad_medida_codigo: 'EA', precio_unitario: 780000, tipo_tributo_codigo: '01', tarifa_iva: 19, ...l3 }));
  }

  // --- Cotización 5: Vencida ---
  {
    const numero = await nextNum('COT');
    const l1 = calcLinea(20, 120000, 5, '01', 19);
    const subtotal = l1.subtotal;
    const dcto     = l1.descuento_valor;
    const iva      = l1.valor_iva;
    const cot = await cotRepo.save(cotRepo.create({
      company_id: cid, numero, prefijo: 'COT',
      cliente_nombre: 'Consultores Asociados SA', cliente_nit: '900111222',
      fecha_emision: '2026-03-01', fecha_vencimiento: '2026-04-01',
      estado: 'vencida',
      moneda_codigo: 'COP', tasa_cambio: 1,
      subtotal, descuento_total: dcto, iva_total: iva, inc_total: 0,
      impuestos_total: iva, total: subtotal + iva,
      observaciones_cliente: '5% de descuento por volumen de horas.',
    }));
    await linRepo.save(linRepo.create({ cotizacion_id: cot.id, linea_numero: 1, producto_id: cons001?.id,
      descripcion: 'Banco de horas de consultoría — paquete 20 horas', cantidad: 20,
      unidad_medida_codigo: 'HUR', precio_unitario: 120000, tipo_tributo_codigo: '01', tarifa_iva: 19, ...l1 }));
  }

  console.log('[Demo] 5 cotizaciones de prueba creadas (borrador, enviada, aprobada, rechazada, vencida)');
}
