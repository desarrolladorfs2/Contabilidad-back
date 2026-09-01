/**
 * Servicio de generación automática de asientos contables.
 *
 * Se invoca desde los routes de facturas y salud justo después de recibir
 * la aprobación DIAN (status_code === '00'), siguiendo el mismo mapeo contable
 * que usan los endpoints batch /generar-desde-*.
 *
 * Contratos:
 *  - Idempotente : si ya existe un asiento para la referencia, retorna null sin crear duplicado.
 *  - No bloqueante: el caller envuelve la llamada en try/catch para no revertir la aprobación DIAN.
 *  - Estado       : el asiento se crea en 'borrador' — el contador sigue aprobando manualmente.
 */

import { AppDataSource } from '../config/database';
import { AsientoContable } from '../entities/contabilidad/AsientoContable';
import { LineaAsiento }    from '../entities/contabilidad/LineaAsiento';
import { CierrePeriodo }   from '../entities/contabilidad/CierrePeriodo';
import { ConfiguracionContable, EventoContable } from '../entities/contabilidad/ConfiguracionContable';
import { Factura }          from '../entities/Invoice';
import { FacturaLinea }    from '../entities/InvoiceLinea';
import { FacturaSalud }    from '../entities/salud/FacturaSalud';
import { DocumentoSoporte } from '../entities/compras/DocumentoSoporte';
import { FacturaCompra } from '../entities/FacturaCompra';
import { Sede } from '../entities/contabilidad/Sede';
import { CuentaTesoreria } from '../entities/tesoreria/CuentaTesoreria';

/**
 * Hallazgo #29: antes los generadores automáticos usaban códigos PUC
 * hardcodeados sin importar lo que la empresa hubiera configurado en
 * `configuracion_contable` (que existe y ya está montada en /api — ver
 * hallazgo #28/#63, pero nunca se consultaba). Ahora, para cada evento
 * contable, se busca primero la cuenta configurada por la empresa y solo si
 * no existe se usa el código estándar histórico como valor por defecto —
 * así una empresa con PUC personalizado puede redirigir la generación
 * automática a sus propias cuentas sin tocar código.
 */
type LadoCuenta = { codigo: string; nombre: string };

async function resolverCuentaEvento(
  company_id: string,
  evento: EventoContable,
  lado: 'debito' | 'credito',
  fallback: LadoCuenta,
): Promise<LadoCuenta> {
  const cfg = await AppDataSource.getRepository(ConfiguracionContable).findOne({
    where: { company_id, evento },
    relations: [lado === 'debito' ? 'cuenta_debito' : 'cuenta_credito'],
  });
  const cuenta = lado === 'debito' ? cfg?.cuenta_debito : cfg?.cuenta_credito;
  if (cuenta?.codigo) return { codigo: cuenta.codigo, nombre: cuenta.nombre || fallback.nombre };
  return fallback;
}

/**
 * Resuelve la cuenta PUC asociada a una Cuenta de Tesorería (caja/banco), para
 * acreditarla en vez de la cuenta de proveedores cuando el pago es de contado.
 * FBK-011. Retorna null si la cuenta no existe o no tiene cuenta_contable
 * configurada (el llamador decide el fallback).
 */
async function resolverCuentaTesoreria(cuentaTesoreriaId?: string): Promise<LadoCuenta | null> {
  if (!cuentaTesoreriaId) return null;
  const ct = await AppDataSource.getRepository(CuentaTesoreria).findOne({ where: { id: cuentaTesoreriaId } });
  if (!ct || !ct.cuenta_contable) return null;
  return { codigo: ct.cuenta_contable, nombre: ct.nombre };
}

/** Trae la Sede completa (para poblar la relacion M2M LineaAsiento.sedes) a partir de un sede_id opcional. */
async function resolverSedeUnica(sedeId?: string): Promise<Sede[]> {
  if (!sedeId) return [];
  const sede = await AppDataSource.getRepository(Sede).findOne({ where: { id: sedeId } });
  return sede ? [sede] : [];
}

/**
 * Resuelve un lote de sede_id a su relacion Sede[] (para LineaAsiento.sedes),
 * cacheando por id para no repetir la misma consulta cuando varias lineas
 * del mismo asiento comparten sede (el caso mas comun: todo el documento
 * usa la misma sede salvo algun item con override propio).
 */
function crearResolverSedesCache(): (sedeId?: string) => Promise<Sede[]> {
  const cache = new Map<string, Promise<Sede[]>>();
  return (sedeId?: string) => {
    if (!sedeId) return Promise.resolve([]);
    let p = cache.get(sedeId);
    if (!p) {
      p = resolverSedeUnica(sedeId);
      cache.set(sedeId, p);
    }
    return p;
  };
}

// ─── helpers privados ────────────────────────────────────────────────────────

async function siguienteNumero(company_id: string): Promise<number> {
  const last = await AppDataSource.getRepository(AsientoContable)
    .createQueryBuilder('a')
    .select('MAX(a.numero)', 'max')
    .where('a.company_id = :cid', { cid: company_id })
    .getRawOne<{ max: number | null }>();
  return (last?.max ?? 0) + 1;
}

async function isPeriodoCerrado(company_id: string, fecha: string): Promise<boolean> {
  const periodo = fecha.slice(0, 7);
  const cierre  = await AppDataSource.getRepository(CierrePeriodo)
    .findOne({ where: { company_id, periodo } });
  // Bug encontrado de paso (preexistente a este batch): a diferencia de la
  // versión equivalente en asientos.routes.ts, esta no consideraba que un
  // cierre pudiera estar reabierto (hallazgo #31 — el DELETE de cierres ya
  // no borra el registro, lo marca `reabierto_por_id`) — así que un período
  // reabierto seguía tratándose como cerrado para siempre en los 4
  // generadores automáticos (factura/salud/documento-soporte/compras).
  return !!cierre && !cierre.reabierto_por_id;
}

// ─── generarAsientoDesdeFactura ──────────────────────────────────────────────

/**
 * Genera el asiento contable de una factura electrónica aprobada por la DIAN.
 *
 * Mapping (igual al endpoint batch /generar-desde-facturas):
 *   Débito  1305  CLIENTES              ← total factura
 *   Crédito 4135  INGRESOS POR VENTAS   ← por línea si hay factura_lineas; si no, subtotal agregado
 *   Crédito 2367  IVA POR PAGAR         ← si iva > 0
 *   Crédito 2367  INC POR PAGAR         ← si inc > 0
 *   (par 4135/4175 si hay descuentos comerciales)
 *
 * @returns AsientoContable creado, o null si ya existía o el periodo está cerrado.
 */
export async function generarAsientoDesdeFactura(
  factura: Factura,
  company_id: string,
): Promise<AsientoContable | null> {

  const repo = AppDataSource.getRepository(AsientoContable);

  // Idempotencia: no crear si ya existe un asiento para esta factura
  const existe = await repo.findOne({
    where: { company_id, referencia_tipo: 'factura', referencia_id: factura.id },
  });
  if (existe) return null;

  // No crear si el periodo contable está cerrado
  if (factura.fecha_emision && await isPeriodoCerrado(company_id, factura.fecha_emision)) {
    console.warn(`[ASIENTO] Periodo ${factura.fecha_emision.slice(0, 7)} cerrado — omitiendo asiento para ${factura.numero_factura}`);
    return null;
  }

  // Cargar líneas con producto (para cuenta_venta).
  // Fallback a totales agregados si factura_lineas está vacía (facturas sin doble-escritura).
  const itemsLineas = await AppDataSource.getRepository(FacturaLinea)
    .createQueryBuilder('l')
    .leftJoinAndSelect('l.producto', 'p')
    .where('l.factura_id = :id', { id: factura.id })
    .orderBy('l.linea_numero', 'ASC')
    .getMany();

  const numero       = await siguienteNumero(company_id);
  const total        = +factura.total;
  const iva          = +factura.iva_total  || 0;
  const inc          = +factura.inc_total  || 0;
  const tipoDoc      = (factura.cliente_tipo_id || 'NIT').toUpperCase();
  const terceroLabel = `${tipoDoc} - ${factura.cliente_nit || ''}`;

  // Hallazgo #29: cuentas configurables por empresa vía `configuracion_contable`,
  // con el código estándar histórico como fallback si no hay configuración.
  const cuentaClientes = await resolverCuentaEvento(company_id, 'venta', 'debito', { codigo: '1305', nombre: 'CLIENTES' });
  const cuentaIngresos = await resolverCuentaEvento(company_id, 'venta', 'credito', { codigo: '4135', nombre: 'INGRESOS POR VENTAS' });
  const cuentaIva      = await resolverCuentaEvento(company_id, 'venta_iva', 'credito', { codigo: '2367', nombre: 'IVA POR PAGAR' });

  // Cada línea del asiento carga su propio centro_costo_id/sede_id (temporal,
  // se resuelve a la relación `sedes` más abajo) — por defecto el de la
  // cabecera de la factura, salvo las líneas de ingreso derivadas de un ítem
  // con centro de costo/sede propio (hallazgo: CC/sede por ítem), que usan
  // el del ítem.
  type LineaAsientoTmp = Partial<LineaAsiento> & { _sede_id?: string };
  const lineas: LineaAsientoTmp[] = [
    {
      cuenta_codigo: cuentaClientes.codigo,
      cuenta_nombre: cuentaClientes.nombre,
      concepto:      factura.cliente_nombre || '',
      tercero_nit:   terceroLabel,
      debito:        total,
      credito:       0,
      orden:         0,
      centro_costo_id: factura.centro_costo_id || undefined,
      _sede_id:        factura.sede_id,
    },
  ];

  let orden = 1;

  if (itemsLineas.length > 0) {
    // Una línea de ingreso por ítem de la factura — la cuenta del producto
    // (si el usuario la asignó) sigue teniendo prioridad sobre la
    // configuración del evento, igual que antes. El centro de costo/sede de
    // cada línea es el propio del ítem si se fijó uno distinto; si el ítem
    // hereda (valores vacíos), se usa el de la cabecera de la factura.
    for (const il of itemsLineas) {
      const cuentaCodigo = il.producto?.cuenta_venta || cuentaIngresos.codigo;
      const cuentaNombre = il.producto?.cuenta_venta
        ? `ING - ${(il.producto.nombre || il.descripcion).slice(0, 40)}`
        : cuentaIngresos.nombre;
      lineas.push({
        cuenta_codigo: cuentaCodigo,
        cuenta_nombre: cuentaNombre,
        concepto:      `${il.descripcion.slice(0, 80)} - ${factura.numero_factura}`,
        tercero_nit:   terceroLabel,
        debito:        0,
        credito:       +il.subtotal,
        orden:         orden++,
        centro_costo_id: il.centro_costo_id || factura.centro_costo_id || undefined,
        _sede_id:        il.sede_id || factura.sede_id,
      });
    }
  } else {
    // Sin líneas detalladas: ingreso agregado
    lineas.push({
      cuenta_codigo: cuentaIngresos.codigo,
      cuenta_nombre: cuentaIngresos.nombre,
      concepto:      `Factura ${factura.numero_factura}`,
      tercero_nit:   terceroLabel,
      debito:        0,
      credito:       +factura.subtotal,
      orden:         orden++,
      centro_costo_id: factura.centro_costo_id || undefined,
      _sede_id:        factura.sede_id,
    });
  }

  if (iva > 0) {
    lineas.push({
      cuenta_codigo: cuentaIva.codigo,
      cuenta_nombre: cuentaIva.nombre,
      concepto:      'IVA',
      tercero_nit:   terceroLabel,
      debito:        0,
      credito:       iva,
      orden:         orden++,
      centro_costo_id: factura.centro_costo_id || undefined,
      _sede_id:        factura.sede_id,
    });
  }

  if (inc > 0) {
    lineas.push({
      cuenta_codigo: '2367',
      cuenta_nombre: 'INC POR PAGAR',
      concepto:      'INC',
      tercero_nit:   terceroLabel,
      debito:        0,
      credito:       inc,
      orden:         orden++,
      centro_costo_id: factura.centro_costo_id || undefined,
      _sede_id:        factura.sede_id,
    });
  }

  // Descuentos comerciales: par simétrico ingreso bruto crédito / descuento débito
  const totalDescuento = itemsLineas.reduce((s, il) => s + (+il.descuento_valor || 0), 0);
  if (totalDescuento > 0) {
    const cuentaDescuento = await resolverCuentaEvento(company_id, 'descuento_venta', 'debito', { codigo: '4175', nombre: 'DESCUENTOS COMERCIALES CONDICIONADOS' });
    lineas.push({
      cuenta_codigo: cuentaIngresos.codigo,
      cuenta_nombre: cuentaIngresos.nombre,
      concepto:      `Ingreso bruto por descuento - ${factura.numero_factura}`,
      tercero_nit:   terceroLabel,
      debito:        0,
      credito:       totalDescuento,
      orden:         orden++,
      centro_costo_id: factura.centro_costo_id || undefined,
      _sede_id:        factura.sede_id,
    });
    lineas.push({
      cuenta_codigo: cuentaDescuento.codigo,
      cuenta_nombre: cuentaDescuento.nombre,
      concepto:      `Descuento comercial - ${factura.numero_factura}`,
      tercero_nit:   terceroLabel,
      debito:        totalDescuento,
      credito:       0,
      orden:         orden++,
      centro_costo_id: factura.centro_costo_id || undefined,
      _sede_id:        factura.sede_id,
    });
  }

  // Resuelve cada _sede_id (con caché por id, evitando N consultas repetidas
  // cuando varias líneas comparten la misma sede) a la relación `sedes` M2M
  // que espera LineaAsiento, y descarta el campo temporal.
  const resolverSedes = crearResolverSedesCache();
  const lineasConCcSede = await Promise.all(lineas.map(async ({ _sede_id, ...l }) => ({
    ...l,
    sedes: await resolverSedes(_sede_id),
  })));

  const asiento = Object.assign(new AsientoContable(), {
    company_id,
    numero,
    fecha:           factura.fecha_emision,
    descripcion:     `Factura electronica ${factura.numero_factura} - ${factura.cliente_nombre}`,
    origen:          'factura'  as const,
    referencia_tipo: 'factura',
    referencia_id:   factura.id,
    total_debito:    total,
    total_credito:   total,
    estado:          'borrador' as const,
    lineas:          lineasConCcSede as LineaAsiento[],
  });

  await repo.save(asiento);
  console.log(`[ASIENTO] Generado #${numero} para factura ${factura.numero_factura}`);
  return asiento;
}

// ─── generarAsientoDesdeFacturaSalud ─────────────────────────────────────────

/**
 * Genera el asiento contable de una factura de salud aprobada por la DIAN.
 *
 * Mapping (igual al endpoint batch /generar-desde-salud):
 *   Débito  1305  CLIENTES - EPS              ← total factura
 *   Crédito <cuenta_ingreso_servicio del contrato | config. empresa | 4110>
 *                                              ← total factura, o (total - pago_usuario_monto)
 *                                                si el contrato tiene cuenta PUC configurada
 *                                                para el copago/cuota moderadora (ver abajo)
 *   Crédito <cuenta_copago | cuenta_cuota_moderadora del contrato> ← pago_usuario_monto
 *                                                (solo si factura.pago_usuario_monto > 0 Y el
 *                                                contrato tiene esa cuenta configurada — si el
 *                                                contrato la deja vacía, NO hay fallback: el
 *                                                comportamiento es igual al de antes, todo va a
 *                                                la cuenta de ingreso)
 *
 * @returns AsientoContable creado, o null si ya existía o el periodo está cerrado.
 */
export async function generarAsientoDesdeFacturaSalud(
  factura: FacturaSalud,
  company_id: string,
): Promise<AsientoContable | null> {

  const repo = AppDataSource.getRepository(AsientoContable);

  // Idempotencia: no crear si ya existe un asiento para esta factura salud
  const existe = await repo.findOne({
    where: { company_id, referencia_tipo: 'salud', referencia_id: factura.id },
  });
  if (existe) return null;

  // No crear si el periodo contable está cerrado
  if (factura.issue_date && await isPeriodoCerrado(company_id, factura.issue_date)) {
    console.warn(`[ASIENTO] Periodo ${factura.issue_date.slice(0, 7)} cerrado — omitiendo asiento para ${factura.invoice_number}`);
    return null;
  }

  const eps        = factura.eps;
  const epsNombre  = eps?.nombre || 'EPS';
  const epsNit     = eps?.nit    || '';
  const epsTercero = epsNit ? `NIT - ${epsNit}` : '';
  const factNum    = factura.invoice_number || factura.id.slice(0, 8);
  const total      = +factura.total;
  const numero     = await siguienteNumero(company_id);

  // Hallazgo #29: cuentas configurables por empresa, con el código estándar
  // histórico como fallback si la empresa no configuró nada.
  const cuentaClientesEps = await resolverCuentaEvento(company_id, 'venta_salud', 'debito', { codigo: '1305', nombre: 'CLIENTES - EPS' });
  // SAL-058: si el CONTRATO trae su propia cuenta de ingreso (cuenta_ingreso_servicio),
  // esa tiene prioridad sobre la configuración de empresa/el fallback estándar —
  // aplica igual a Evento (muchas facturas, todas a esa cuenta) que a PGP (un
  // solo valor por período, también a esa cuenta).
  const cuentaIngresoSalud = factura.contrato?.cuenta_ingreso_servicio
    ? { codigo: factura.contrato.cuenta_ingreso_servicio, nombre: 'INGRESOS SERVICIOS DE SALUD' }
    : await resolverCuentaEvento(company_id, 'venta_salud', 'credito', { codigo: '4110', nombre: 'INGRESOS SERVICIOS DE SALUD' });

  // Pago por usuario (copago / cuota moderadora) — se separa a la cuenta PUC
  // configurada en el contrato SOLO si esa cuenta está definida. Sin cuenta
  // configurada, no hay fallback: el monto sigue yendo íntegro a la cuenta de
  // ingreso, igual que antes de que existiera esta configuración por contrato.
  const pagoUsuarioMonto = +(factura.pago_usuario_monto || 0);
  const cuentaPagoUsuario = factura.tipo_cobro_usuario === 'copago'
    ? factura.contrato?.cuenta_copago
    : factura.tipo_cobro_usuario === 'cuota_moderadora'
      ? factura.contrato?.cuenta_cuota_moderadora
      : undefined;
  const separarPagoUsuario = pagoUsuarioMonto > 0 && !!cuentaPagoUsuario;
  const nombrePagoUsuario  = factura.tipo_cobro_usuario === 'copago' ? 'COPAGO' : 'CUOTA MODERADORA';
  const ingresoServicio    = separarPagoUsuario ? total - pagoUsuarioMonto : total;

  // SAL-058: el copago/cuota moderadora lo recibe la IPS directamente del
  // paciente (normalmente en caja/efectivo en el momento de la atención), NO
  // la EPS — así que si se separa el ingreso, también hay que separar el
  // DÉBITO: la cartera "Clientes - EPS" debe quedar solo por lo que realmente
  // debe la EPS (total - pago por usuario), y el pago por usuario debita una
  // cuenta de caja/efectivo aparte (configurable por empresa, evento
  // "cobro_pago_usuario_salud"), en vez de inflar la cartera con la EPS con
  // plata que la EPS nunca va a pagar.
  const cuentaCajaPagoUsuario = separarPagoUsuario
    ? await resolverCuentaEvento(company_id, 'cobro_pago_usuario_salud', 'debito', { codigo: '110505', nombre: 'CAJA GENERAL' })
    : null;
  const clientesEpsMonto = separarPagoUsuario ? total - pagoUsuarioMonto : total;

  // Nombre del paciente (primero de la factura) para identificar el tercero
  // en la línea de caja del copago/cuota — el paciente paga esa parte, no la EPS.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pacientesAsiento: Record<string, any>[] = (() => {
    try { return JSON.parse(factura.pacientes_json || '[]'); } catch { return []; }
  })();
  const pacienteAsiento   = pacientesAsiento[0] || {};
  const pacienteNombre    = pacienteAsiento.nombre ||
    [pacienteAsiento.primerNombre, pacienteAsiento.primerApellido].filter(Boolean).join(' ') || 'Paciente';
  const pacienteTercero   = pacienteAsiento.numDocumentoIdentificacion
    ? `${pacienteAsiento.tipoDocumentoIdentificacion || 'CC'} - ${pacienteAsiento.numDocumentoIdentificacion}`
    : '';

  const lineas: Partial<LineaAsiento>[] = [
    {
      cuenta_codigo: cuentaClientesEps.codigo,
      cuenta_nombre: cuentaClientesEps.nombre,
      concepto:      `Factura salud ${factNum} - ${epsNombre}`,
      tercero_nit:   epsTercero,
      debito:        clientesEpsMonto,
      credito:       0,
      orden:         0,
    },
    {
      cuenta_codigo: cuentaIngresoSalud.codigo,
      cuenta_nombre: cuentaIngresoSalud.nombre,
      concepto:      `Ingreso ${epsNombre} - ${factNum}`,
      tercero_nit:   epsTercero,
      debito:        0,
      credito:       ingresoServicio,
      orden:         1,
    },
  ];

  if (cuentaCajaPagoUsuario) {
    lineas.push({
      cuenta_codigo: cuentaCajaPagoUsuario.codigo,
      cuenta_nombre: cuentaCajaPagoUsuario.nombre,
      concepto:      `${nombrePagoUsuario} recibido - ${pacienteNombre} - ${factNum}`,
      tercero_nit:   pacienteTercero,
      debito:        pagoUsuarioMonto,
      credito:       0,
      orden:         2,
    });
  }

  if (separarPagoUsuario) {
    lineas.push({
      cuenta_codigo: cuentaPagoUsuario!,
      cuenta_nombre: `${nombrePagoUsuario} PACIENTE`,
      concepto:      `${nombrePagoUsuario} - ${epsNombre} - ${factNum}`,
      tercero_nit:   pacienteTercero,
      debito:        0,
      credito:       pagoUsuarioMonto,
      orden:         3,
    });
  }

  // Propaga centro de costo y sede (punto de pago) de la factura de salud a cada linea.
  const sedesFacturaSalud = await resolverSedeUnica(factura.punto_pago_sede_id);
  const lineasConCcSedeSalud = lineas.map(l => ({
    ...l,
    centro_costo_id: factura.centro_costo_id || undefined,
    sedes:           sedesFacturaSalud,
  }));

  const asiento = Object.assign(new AsientoContable(), {
    company_id,
    numero,
    fecha:           factura.issue_date,
    descripcion:     `Salud - ${epsNombre} - Factura ${factNum}`,
    origen:          'salud'    as const,
    referencia_tipo: 'salud',
    referencia_id:   factura.id,
    total_debito:    total,
    total_credito:   total,
    estado:          'borrador' as const,
    lineas:          lineasConCcSedeSalud as LineaAsiento[],
  });

  await repo.save(asiento);
  console.log(`[ASIENTO] Generado #${numero} para factura salud ${factNum}`);
  return asiento;
}

// ─── generarAsientoDesdeDocumentoSoporte ─────────────────────────────────────

/**
 * Genera el asiento contable de un Documento Soporte aprobado por la DIAN.
 *
 * Mapping contable (PUC colombiano):
 *   Débito  6205  GASTOS DE COMPRAS     ← subtotal
 *   Débito  2408  IVA DESCONTABLE       ← iva_total (si > 0)
 *   Crédito 2205  PROVEEDORES NACIONALES ← total
 *
 * @returns AsientoContable creado, o null si ya existía o el periodo está cerrado.
 */
export async function generarAsientoDesdeDocumentoSoporte(
  ds: DocumentoSoporte,
  company_id: string,
): Promise<AsientoContable | null> {

  const repo = AppDataSource.getRepository(AsientoContable);

  // Idempotencia
  const existe = await repo.findOne({
    where: { company_id, referencia_tipo: 'ds', referencia_id: ds.id },
  });
  if (existe) return null;

  // No crear si el periodo contable está cerrado
  if (ds.fecha_emision && await isPeriodoCerrado(company_id, ds.fecha_emision)) {
    console.warn(`[ASIENTO] Periodo ${ds.fecha_emision.slice(0, 7)} cerrado — omitiendo asiento para ${ds.numero_ds}`);
    return null;
  }

  const numero    = await siguienteNumero(company_id);
  const subtotal  = +ds.subtotal  || 0;
  const iva       = +ds.iva_total || 0;
  const total     = +ds.total     || 0;
  const tipoDoc   = (ds.proveedor_tipo_id || 'CC').toUpperCase();
  const tercero   = `${tipoDoc} - ${ds.proveedor_nit || ''}`;

  // Hallazgo #29: cuentas configurables por empresa, con el código estándar
  // histórico como fallback si la empresa no configuró nada.
  const cuentaGasto      = await resolverCuentaEvento(company_id, 'compra', 'debito', { codigo: '6205', nombre: 'GASTOS DE COMPRAS' });
  const cuentaIvaDesc    = await resolverCuentaEvento(company_id, 'compra_iva', 'debito', { codigo: '2408', nombre: 'IVA DESCONTABLE' });
  const cuentaProveedor  = await resolverCuentaEvento(company_id, 'compra', 'credito', { codigo: '2205', nombre: 'PROVEEDORES NACIONALES' });

  // Líneas del DS (JSON simple-json en la entidad). Si el usuario asignó una
  // cuenta PUC por línea en el formulario, se contabiliza directo a esa cuenta
  // (igual que facturas usan producto.cuenta_venta por línea) — así el gasto
  // queda registrado sin que el usuario tenga que reclasificarlo luego en el
  // asiento manualmente. Si una línea no tiene cuenta asignada, se usa el
  // genérico 6205 (comportamiento anterior) como fallback.
  const itemsLineas: any[] = Array.isArray(ds.lineas) ? ds.lineas : [];

  // Hallazgo CC/sede por ítem: cada línea del asiento hereda el centro de
  // costo/sede del ítem original si se fijó uno propio; si el ítem hereda
  // (valores vacíos), usa el del Documento Soporte.
  type LineaAsientoTmp = Partial<LineaAsiento> & { _sede_id?: string };
  const lineas: LineaAsientoTmp[] = [];
  let orden = 0;

  if (itemsLineas.length > 0) {
    for (const il of itemsLineas) {
      const monto = +(il.subtotal ?? il.total ?? 0);
      if (!monto) continue;
      const cuentaCodigo = il.cuenta_puc_codigo || cuentaGasto.codigo;
      const cuentaNombre = il.cuenta_puc_codigo
        ? (il.cuenta_puc_nombre || `GASTO - ${(il.descripcion || il.description || '').slice(0, 40)}`)
        : cuentaGasto.nombre;
      lineas.push({
        cuenta_codigo: cuentaCodigo,
        cuenta_nombre: cuentaNombre,
        concepto:      `${(il.descripcion || il.description || '').slice(0, 80)} - ${ds.numero_ds}`,
        tercero_nit:   tercero,
        debito:        monto,
        credito:       0,
        orden:         orden++,
        centro_costo_id: il.centro_costo_id || ds.centro_costo_id || undefined,
        _sede_id:        il.sede_id || ds.sede_id,
      });
    }
  } else {
    // Sin líneas detalladas: gasto agregado (comportamiento anterior)
    lineas.push({
      cuenta_codigo: cuentaGasto.codigo,
      cuenta_nombre: cuentaGasto.nombre,
      concepto:      `DS ${ds.numero_ds} - ${ds.proveedor_nombre}`,
      tercero_nit:   tercero,
      debito:        subtotal,
      credito:       0,
      orden:         orden++,
      centro_costo_id: ds.centro_costo_id || undefined,
      _sede_id:        ds.sede_id,
    });
  }

  if (iva > 0) {
    lineas.push({
      cuenta_codigo: cuentaIvaDesc.codigo,
      cuenta_nombre: cuentaIvaDesc.nombre,
      concepto:      `IVA - DS ${ds.numero_ds}`,
      tercero_nit:   tercero,
      debito:        iva,
      credito:       0,
      orden:         orden++,
      centro_costo_id: ds.centro_costo_id || undefined,
      _sede_id:        ds.sede_id,
    });
  }

  // FBK-011: el crédito ya no siempre va a Proveedores — se ramifica por forma
  // de pago. Contado (payment_means_id='1') → cuenta de tesorería seleccionada
  // (caja/banco); Crédito (o sin especificar) → Proveedores, igual que antes.
  //
  // Corrección de balance (bug encontrado al tocar este código para FBK-011):
  // ds.total YA viene NETO de retención (se calcula en el formulario como
  // neta + iva - rete por línea), mientras que las líneas de débito de arriba
  // (gasto + iva) suman el monto BRUTO (subtotal + iva). Antes total_debito y
  // total_credito se fijaban ambos al mismo `total` (neto) sin que ninguna
  // línea de crédito reflejara la retención — el asiento "cuadraba" solo
  // porque ambos encabezados repetían el mismo número, pero la suma real de
  // líneas de débito (bruto) no coincidía con la de crédito (neto). Ahora se
  // agrega una línea de crédito explícita por la retención, y total_debito/
  // total_credito se calculan como la suma real de las líneas generadas.
  const retencionValor = Math.round(
    itemsLineas.reduce((s, il: any) => s + (+(il.valor_rete ?? 0) || 0), 0) * 100
  ) / 100;
  const grossTotal = subtotal + iva; // base + IVA, antes de retención — es lo que realmente suman los débitos.
  const totalAcreedor = Math.max(0, grossTotal - retencionValor);

  let cuentaCredito = cuentaProveedor;
  if (ds.payment_means_id === '1') {
    const cuentaTes = await resolverCuentaTesoreria(ds.cuenta_tesoreria_id);
    if (cuentaTes) {
      cuentaCredito = cuentaTes;
    } else {
      cuentaCredito = { codigo: '1105', nombre: 'CAJA GENERAL' };
      console.warn(`[ASIENTO][DS] Pago de contado sin cuenta de tesorería seleccionada — usando 1105 CAJA GENERAL como fallback para ${ds.numero_ds}`);
    }
  }

  lineas.push({
    cuenta_codigo: cuentaCredito.codigo,
    cuenta_nombre: cuentaCredito.nombre,
    concepto:      `DS ${ds.numero_ds} - ${ds.proveedor_nombre}`,
    tercero_nit:   tercero,
    debito:        0,
    credito:       totalAcreedor,
    orden:         orden++,
    centro_costo_id: ds.centro_costo_id || undefined,
    _sede_id:        ds.sede_id,
  });

  if (retencionValor > 0) {
    lineas.push({
      cuenta_codigo: '2365',
      cuenta_nombre: 'RETENCION EN LA FUENTE',
      concepto:      `Retefuente - DS ${ds.numero_ds}`,
      tercero_nit:   tercero,
      debito:        0,
      credito:       retencionValor,
      orden:         orden++,
      centro_costo_id: ds.centro_costo_id || undefined,
      _sede_id:        ds.sede_id,
    });
  }

  // Resuelve cada _sede_id (con caché por id) a la relación `sedes` M2M que
  // espera LineaAsiento, y descarta el campo temporal.
  const resolverSedesDs = crearResolverSedesCache();
  const lineasConCcSedeDs = await Promise.all(lineas.map(async ({ _sede_id, ...l }) => ({
    ...l,
    sedes: await resolverSedesDs(_sede_id),
  })));

  // Totales del encabezado calculados como la suma REAL de las líneas
  // generadas (no reutilizando ds.total, que es neto de retención) — así el
  // asiento cuadra de verdad, línea por línea, no solo en el encabezado.
  const totalDebitoLineas  = lineasConCcSedeDs.reduce((s, l) => s + (+(l.debito  ?? 0)), 0);
  const totalCreditoLineas = lineasConCcSedeDs.reduce((s, l) => s + (+(l.credito ?? 0)), 0);

  const asiento = Object.assign(new AsientoContable(), {
    company_id,
    numero,
    fecha:           ds.fecha_emision,
    descripcion:     `Documento Soporte ${ds.numero_ds} - ${ds.proveedor_nombre}`,
    origen:          'compra'   as const,
    referencia_tipo: 'ds',
    referencia_id:   ds.id,
    total_debito:    Math.round(totalDebitoLineas  * 100) / 100,
    total_credito:   Math.round(totalCreditoLineas * 100) / 100,
    estado:          'borrador' as const,
    lineas:          lineasConCcSedeDs as LineaAsiento[],
  });

  await repo.save(asiento);
  console.log(`[ASIENTO] Generado #${numero} para Documento Soporte ${ds.numero_ds}`);
  return asiento;
}

// ─── generarAsientoDesdeFacturaCompra ───────────────────────────────────────

/**
 * Genera el asiento contable de una Factura de Compra (proveedor), extraído del
 * endpoint batch `/generar-desde-compras` (antes 100% inline en asientos.routes.ts
 * con códigos PUC hardcodeados y sin ningún CC/sede por ítem) — hallazgos #17/#26/#35.
 * Sigue el mismo patrón que `generarAsientoDesdeDocumentoSoporte`:
 *
 *   Débito  6205 (o cuenta_puc_codigo de cada ítem)  GASTOS/COMPRAS  ← por línea, o subtotal agregado
 *   Débito  2408  IVA DESCONTABLE                     ← si iva_total > 0
 *   Débito  2367  INC POR PAGAR                        ← si inc_total > 0 (sin evento configurable propio)
 *   Crédito 2205  CUENTAS POR PAGAR - PROVEEDORES      ← total factura
 *
 * Cada línea generada usa el centro_costo_id/sede_id de su ítem de origen si tiene
 * uno propio (override), o el de la Factura de Compra si el ítem hereda — igual que
 * ya hace Documento Soporte.
 *
 * @returns AsientoContable creado, o null si ya existía o el periodo está cerrado.
 */
export async function generarAsientoDesdeFacturaCompra(
  fc: FacturaCompra,
  company_id: string,
): Promise<AsientoContable | null> {

  const repo = AppDataSource.getRepository(AsientoContable);

  // Idempotencia — misma convención que el endpoint batch (origen 'compra').
  const existe = await repo.findOne({
    where: { company_id, referencia_tipo: 'compra', referencia_id: fc.id },
  });
  if (existe) return null;

  if (fc.invoice_date && await isPeriodoCerrado(company_id, fc.invoice_date)) {
    console.warn(`[ASIENTO] Periodo ${fc.invoice_date.slice(0, 7)} cerrado — omitiendo asiento para Factura de Compra ${fc.invoice_number_str || fc.id}`);
    return null;
  }

  const numero    = await siguienteNumero(company_id);
  const factNum   = fc.invoice_number_str || fc.id.slice(0, 8);
  const provTercero = `NIT - ${fc.provider_nit || ''}`;
  const ivaTotal  = +fc.iva_total || 0;
  const incTotal  = +fc.inc_total || 0;
  const totalFact = +fc.total || 0;
  const baseTotal = totalFact - ivaTotal - incTotal;

  // Cuentas configurables por empresa (mismos eventos que Documento Soporte, para
  // que "compra" sea un único punto de configuración sin importar el submódulo de
  // origen), con el código estándar histórico como fallback.
  const cuentaGasto     = await resolverCuentaEvento(company_id, 'compra', 'debito', { codigo: '6205', nombre: 'COMPRAS' });
  const cuentaIvaDesc   = await resolverCuentaEvento(company_id, 'compra_iva', 'debito', { codigo: '2408', nombre: 'IVA DESCONTABLE' });
  const cuentaProveedor = await resolverCuentaEvento(company_id, 'compra', 'credito', { codigo: '2205', nombre: 'CUENTAS POR PAGAR - PROVEEDORES' });
  // El INC no tiene un EventoContable propio (no hay 'compra_inc' en el modelo de
  // configuración) — se deja el código histórico fijo, igual que antes.
  const cuentaIncCodigo = '2367';
  const cuentaIncNombre = 'INC POR PAGAR';

  type RawLine = {
    cuenta_puc_codigo?: string; cuenta_puc_nombre?: string;
    line_total?: number; subtotal_bruto?: number; discount_amount?: number; tax_amount?: number;
    description?: string; centro_costo_id?: string; sede_id?: string;
  };
  let rawLines: RawLine[] = [];
  try {
    rawLines = fc.lines_json ? JSON.parse(fc.lines_json) : [];
  } catch { rawLines = []; }

  const hasLinePuc = rawLines.some(l => l.cuenta_puc_codigo);

  // Hallazgo CC/sede por ítem: cada línea del asiento hereda el centro de costo/sede
  // del ítem original si se fijó uno propio; si el ítem hereda (valores vacíos), usa
  // el de la Factura de Compra — igual patrón que Documento Soporte.
  type LineaAsientoTmp = Partial<LineaAsiento> & { _sede_id?: string };
  const lineas: LineaAsientoTmp[] = [];
  let orden = 0;

  if (hasLinePuc) {
    for (const l of rawLines) {
      const lineBase = (+(l.subtotal_bruto ?? 0)) - (+(l.discount_amount ?? 0));
      const lineTax  = +(l.tax_amount ?? 0);
      if (!lineBase && !lineTax) continue;
      const cuentaCodigo = l.cuenta_puc_codigo || cuentaGasto.codigo;
      const cuentaNombre = l.cuenta_puc_codigo ? (l.cuenta_puc_nombre || 'COMPRAS') : cuentaGasto.nombre;
      const ccId   = l.centro_costo_id || fc.centro_costo_id || undefined;
      const sedeId = l.sede_id || fc.sede_id;
      if (lineBase) {
        lineas.push({
          cuenta_codigo: cuentaCodigo, cuenta_nombre: cuentaNombre,
          concepto: l.description || factNum, tercero_nit: provTercero,
          debito: lineBase, credito: 0, orden: orden++,
          centro_costo_id: ccId, _sede_id: sedeId,
        });
      }
      if (lineTax > 0) {
        lineas.push({
          cuenta_codigo: cuentaIvaDesc.codigo, cuenta_nombre: cuentaIvaDesc.nombre,
          concepto: `IVA ${factNum}`, tercero_nit: provTercero,
          debito: lineTax, credito: 0, orden: orden++,
          centro_costo_id: ccId, _sede_id: sedeId,
        });
      }
    }
  } else {
    lineas.push({
      cuenta_codigo: cuentaGasto.codigo, cuenta_nombre: cuentaGasto.nombre,
      concepto: `Compra ${factNum} - ${fc.provider_name || ''}`, tercero_nit: provTercero,
      debito: baseTotal, credito: 0, orden: orden++,
      centro_costo_id: fc.centro_costo_id || undefined, _sede_id: fc.sede_id,
    });
    if (ivaTotal > 0) {
      lineas.push({
        cuenta_codigo: cuentaIvaDesc.codigo, cuenta_nombre: cuentaIvaDesc.nombre,
        concepto: `IVA compra ${factNum}`, tercero_nit: provTercero,
        debito: ivaTotal, credito: 0, orden: orden++,
        centro_costo_id: fc.centro_costo_id || undefined, _sede_id: fc.sede_id,
      });
    }
  }

  if (incTotal > 0) {
    lineas.push({
      cuenta_codigo: cuentaIncCodigo, cuenta_nombre: cuentaIncNombre,
      concepto: `INC compra ${factNum}`, tercero_nit: provTercero,
      debito: incTotal, credito: 0, orden: orden++,
      centro_costo_id: fc.centro_costo_id || undefined, _sede_id: fc.sede_id,
    });
  }

  // FBK-011: ramificar el crédito por forma de pago — contado → cuenta de
  // tesorería seleccionada; crédito (o sin especificar) → Proveedores.
  // FBK-009: Retefuente y ReteICA se descuentan del pago al proveedor (se
  // acreditan a sus propias cuentas de pasivo), no del gasto/IVA deducible —
  // el total que efectivamente se le acredita al proveedor/tesorería es
  // totalFact menos ambas retenciones.
  const retefuenteValor = +fc.retefuente_valor || 0;
  const reteicaValor    = +fc.reteica_valor    || 0;
  const totalAcreedorFc = Math.max(0, totalFact - retefuenteValor - reteicaValor);

  let cuentaCreditoFc = cuentaProveedor;
  if (fc.payment_means_id === '1') {
    const cuentaTesFc = await resolverCuentaTesoreria(fc.cuenta_tesoreria_id);
    if (cuentaTesFc) {
      cuentaCreditoFc = cuentaTesFc;
    } else {
      cuentaCreditoFc = { codigo: '1105', nombre: 'CAJA GENERAL' };
      console.warn(`[ASIENTO][FacturaCompra] Pago de contado sin cuenta de tesorería seleccionada — usando 1105 CAJA GENERAL como fallback para ${factNum}`);
    }
  }

  lineas.push({
    cuenta_codigo: cuentaCreditoFc.codigo, cuenta_nombre: cuentaCreditoFc.nombre,
    concepto: `Factura proveedor ${factNum}`, tercero_nit: provTercero,
    debito: 0, credito: totalAcreedorFc, orden: orden++,
    centro_costo_id: fc.centro_costo_id || undefined, _sede_id: fc.sede_id,
  });

  if (retefuenteValor > 0) {
    lineas.push({
      cuenta_codigo: '2365', cuenta_nombre: 'RETENCION EN LA FUENTE',
      concepto: `Retefuente - Compra ${factNum}`, tercero_nit: provTercero,
      debito: 0, credito: retefuenteValor, orden: orden++,
      centro_costo_id: fc.centro_costo_id || undefined, _sede_id: fc.sede_id,
    });
  }
  if (reteicaValor > 0) {
    lineas.push({
      cuenta_codigo: '2368', cuenta_nombre: 'ICA POR PAGAR',
      concepto: `ReteICA - Compra ${factNum}`, tercero_nit: provTercero,
      debito: 0, credito: reteicaValor, orden: orden++,
      centro_costo_id: fc.centro_costo_id || undefined, _sede_id: fc.sede_id,
    });
  }

  const resolverSedesFc = crearResolverSedesCache();
  const lineasConCcSedeFc = await Promise.all(lineas.map(async ({ _sede_id, ...l }) => ({
    ...l,
    sedes: await resolverSedesFc(_sede_id),
  })));

  // Totales del encabezado como suma real de las líneas generadas (mismo
  // criterio de corrección que Documento Soporte — ver comentario allá).
  const totalDebitoLineasFc  = lineasConCcSedeFc.reduce((s, l) => s + (+(l.debito  ?? 0)), 0);
  const totalCreditoLineasFc = lineasConCcSedeFc.reduce((s, l) => s + (+(l.credito ?? 0)), 0);

  const asiento = Object.assign(new AsientoContable(), {
    company_id,
    numero,
    fecha:           fc.invoice_date || new Date().toISOString().slice(0, 10),
    descripcion:     `Compra - ${fc.provider_name || factNum} - Factura ${factNum}`,
    origen:          'compra'   as const,
    referencia_tipo: 'compra',
    referencia_id:   fc.id,
    total_debito:    Math.round(totalDebitoLineasFc  * 100) / 100,
    total_credito:   Math.round(totalCreditoLineasFc * 100) / 100,
    estado:          'borrador' as const,
    lineas:          lineasConCcSedeFc as LineaAsiento[],
  });

  await repo.save(asiento);
  console.log(`[ASIENTO] Generado #${numero} para Factura de Compra ${factNum}`);
  return asiento;
}
