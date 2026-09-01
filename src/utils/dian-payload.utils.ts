/**
 * dian-payload.utils.ts
 *
 * Mapea los datos del frontend Angular al formato exacto que espera
 * el Python XML builder (InvoiceGenerationRequest de schemas.py).
 */

import { Company } from '../entities/Company';
import { CompanySettings } from '../entities/CompanySettings';
import { Factura } from '../entities/Invoice';
import { FacturaSalud } from '../entities/salud/FacturaSalud';
import { NotaCreditoSalud } from '../entities/salud/NotaCreditoSalud';
import { NotaDebitoSalud } from '../entities/salud/NotaDebitoSalud';

const TAX_TYPE_MAP: Record<string, string> = {
  'IVA': '01', 'INC': '04', 'ZA': 'ZA', 'ZY': 'ZY',
  'Excluido': 'ZA', 'Excluido IVA': 'ZA', 'No causado': 'ZY',
  '01': '01', '03': '03', '04': '04',
  '22': '22', '23': '23', '24': '24',
  '32': '32', '34': '34', '35': '35',
};

/**
 * Mapeo de tipo_id del Tercero → código DIAN tabla 6.3.4 + AdditionalAccountID
 * person_type: '1' = Persona jurídica, '2' = Persona natural
 */
const TIPO_ID_TO_DIAN: Record<string, { schemeID: string; personType: string }> = {
  // Claves de texto (vienen de terceros/RIPS)
  'NIT':  { schemeID: '31', personType: '1' },
  'CC':   { schemeID: '13', personType: '2' },
  'CE':   { schemeID: '22', personType: '2' },
  'PP':   { schemeID: '41', personType: '2' },
  'PAS':  { schemeID: '41', personType: '2' },
  'TI':   { schemeID: '12', personType: '2' },
  'RC':   { schemeID: '11', personType: '2' },
  'TE':   { schemeID: '21', personType: '2' },
  'PEP':  { schemeID: '47', personType: '2' },
  'NUIP': { schemeID: '91', personType: '2' },
  'IE':   { schemeID: '42', personType: '2' },
  'FN':   { schemeID: '50', personType: '1' },
  // Alias numéricos (vienen del select del formulario de facturas)
  '31':   { schemeID: '31', personType: '1' },
  '13':   { schemeID: '13', personType: '2' },
  '22':   { schemeID: '22', personType: '2' },
  '41':   { schemeID: '41', personType: '2' },
  '12':   { schemeID: '12', personType: '2' },
  '11':   { schemeID: '11', personType: '2' },
  '21':   { schemeID: '21', personType: '2' },
  '47':   { schemeID: '47', personType: '2' },
  '91':   { schemeID: '91', personType: '2' },
  '42':   { schemeID: '42', personType: '2' },
  '50':   { schemeID: '50', personType: '1' },
};

function buildIssuer(company: Company): Record<string, unknown> {
  return {
    nit:             company.nit,
    dv:              company.nit_dv  || undefined,   // Si está en BD, lo usa; si no, Python lo calcula
    name:            company.name,
    trade_name:      company.trade_name || company.name,
    city_code:       company.city_code        || '11001',
    city_name:       company.city_name        || 'Bogota',
    department_code: company.department_code  || '11',
    department_name: company.department_name  || 'Bogota',
    address:         company.address          || 'Carrera 1 # 1-1',
    tax_level_code:  company.tax_level_code   || 'R-99-PN',
    email:           company.email            || undefined,
    document_type:   '31',   // Emisor siempre es NIT en Colombia
    person_type:     '1',    // Persona jurídica
  };
}

/**
 * Emisor para facturas/notas del SECTOR SALUD (facturadas a la EPS/entidad pagadora).
 * Responsabilidad fiscal fija "O-23;R-99-PN" con listName "No aplica" — confirmado
 * contra el XML NS82845 (validado por el Ministerio de Salud). Es un valor quemado
 * a propósito para todo el módulo de salud (decisión de negocio), independiente de
 * lo configurado en company.tax_level_code, que sigue rigiendo para el resto de
 * facturación (normal, NC, ND, Documento Soporte y la factura de copago al paciente).
 */
function buildIssuerSalud(company: Company): Record<string, unknown> {
  return {
    ...buildIssuer(company),
    tax_level_code:      'O-23;R-99-PN',
    tax_level_list_name: 'No aplica',
  };
}

/**
 * Normaliza un valor de fecha (string ISO o Date object de TypeORM) a YYYY-MM-DD
 * usando UTC, evitando el desfase de timezone que produce off-by-one.
 */
function toDateString(d: string | Date | undefined | null): string {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  // TypeORM puede devolver un objeto Date aunque el tipo TypeScript diga string
  return (d as Date).toISOString().slice(0, 10);
}

/** Calcula la fecha de fin de vigencia sumando meses a una fecha ISO (YYYY-MM-DD). */
function addMonths(dateStr: string | Date | undefined | null, months: number): string {
  const base = toDateString(dateStr);
  if (!base) return '';
  // Usamos mediodía UTC para evitar que el ajuste DST cambie el día
  const d = new Date(base + 'T12:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function localDateString(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local  = new Date(now.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 10);
}

const TAX_LEVEL_FIX: Record<string, string> = {
  '0-13': 'O-13', '0-14': 'O-15', '0-15': 'O-15', '0-23': 'O-23', '0-47': 'O-47',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildCustomer(c: Record<string, any>): Record<string, unknown> {
  const cityCode = (c.city_code || '11001').toString();
  const deptCode = c.department_code || cityCode.slice(0, 2);
  const rawTaxLevel = c.tax_level_code || 'R-99-PN';
  const taxLevelCode = TAX_LEVEL_FIX[rawTaxLevel] ?? rawTaxLevel;
  // Mapear tipo_id del Tercero (ej: 'CC', 'NIT', 'CE') al código DIAN tabla 6.3.4
  const tipoId = ((c.tipo_id || c.id_type || 'NIT') as string).toUpperCase();
  const dianDoc = TIPO_ID_TO_DIAN[tipoId] ?? { schemeID: '31', personType: '1' };
  // DV: usar el almacenado si existe; solo aplica para NIT (tipo 31)
  const dvValue = (tipoId === 'NIT' && c.nit_dv) ? c.nit_dv : undefined;
  const isNatural = dianDoc.personType === '2';
  return {
    nit:             c.id_number   || c.nit   || '222222222222',
    dv:              dvValue,
    name:            c.name        || 'Consumidor Final',
    city_code:       cityCode,
    city_name:       c.city_name   || '',
    department_code: deptCode,
    department_name: c.department_name  || '',
    address:         c.address     || 'Carrera 1 # 1-1',
    tax_level_code:  taxLevelCode,
    document_type:   dianDoc.schemeID,
    person_type:     dianDoc.personType,
    email:           c.email       || undefined,
    phone:           c.telefono    || c.phone  || undefined,
    // Campos cac:Person — requeridos por FAK61 cuando persona natural
    ...(isNatural && {
      first_name:        c.primer_nombre   || (c.name || '').split(' ')[0] || undefined,
      middle_name:       c.segundo_nombre  || undefined,
      family_name:       c.primer_apellido || (c.name || '').split(' ')[1] || undefined,
      second_family_name: c.segundo_apellido || undefined,
    }),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildLines(lines: Record<string, any>[]): Record<string, unknown>[] {
  return lines.map((line, idx) => ({
    id:               idx + 1,
    description:      line.description,
    quantity:         Number(line.quantity)   || 1,
    unit_price:       Number(line.unit_price) || 0,
    unit_code:        line.unit_code          || 'EA',
    unspsc:           line.unspsc             || '80000000', // fallback genérico: Servicios de gestión empresarial
    tax_type:         TAX_TYPE_MAP[line.tax_type] || line.tax_type || '01',
    tax_rate:         Number(line.tax_rate ?? 0),
    discount_percent: Number(line.discount_rate ?? line.discount_percent ?? 0),
  }));
}

const DIAN_DEFAULT_TECHNICAL_KEY_TEST = 'fc8eac422eba16e22ffd8c6f94b3f40a6e38162c';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getTechnicalKey(settings: CompanySettings): string {
  const key = settings.environment === '1'
    ? (settings.technical_key_prod  || '')
    : (settings.technical_key_test  || '');
  if (!key || UUID_PATTERN.test(key)) {
    if (settings.environment !== '1') {
      console.warn('[DIAN] technical_key_test incorrecto. Usando clave estandar de habilitacion.');
      return DIAN_DEFAULT_TECHNICAL_KEY_TEST;
    }
    return key;
  }
  return key;
}

export function buildInvoiceXmlPayload(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: Record<string, any>,
  company: Company,
  settings: CompanySettings,
  invoiceNumberOverride?: string,
): Record<string, unknown> {
  let prefix = settings.invoice_prefix || 'SETP';
  let number = settings.next_invoice_number || 1;
  if (invoiceNumberOverride) {
    const numStr = invoiceNumberOverride.startsWith(prefix)
      ? invoiceNumberOverride.slice(prefix.length)
      : invoiceNumberOverride;
    const parsed = parseInt(numStr, 10);
    if (!isNaN(parsed)) number = parsed;
  }
  return {
    prefix,
    number,
    issue_date:         localDateString(),
    issuer:             buildIssuer(company),
    customer:           buildCustomer(body.customer || {}),
    software_id:            settings.software_id                  || '',
    software_pin:           settings.software_pin                 || '',
    technical_key_test:     getTechnicalKey(settings),
    resolution_number:      settings.resolution_number            || '',
    resolution_prefix:      settings.resolution_prefix            || settings.invoice_prefix || '',
    resolution_from:        settings.resolution_from              ?? 990000000,
    resolution_to:          settings.resolution_to                ?? 995000000,
    resolution_start_date:  toDateString(settings.resolution_start_date || settings.resolution_date),
    resolution_end_date:    toDateString(settings.resolution_end_date) || addMonths(settings.resolution_date, 24),
    environment:            settings.environment                  || '2',
    lines:                  buildLines(body.lines || []),
    note:                   body.notes || body.note              || undefined,
    currency:               body.currency                         || 'COP',
    test_set_id:            body.test_set_id                      || undefined,
  };
}

export function buildHealthPgpXmlPayload(
  factura: FacturaSalud,
  company: Company,
  settings: CompanySettings,
  assignedNumber: number,
  assignedPrefix: string,
): Record<string, unknown> {
  const eps = factura.eps;
  const customer = {
    nit:             eps?.nit             || '222222222222',
    name:            eps?.nombre          || 'EPS',
    city_code:       eps?.ciudad_codigo   || '11001',
    city_name:       eps?.ciudad_nombre   || 'Bogota',
    department_code: eps?.departamento_codigo || '11',
    department_name: eps?.departamento_nombre || 'Bogota',
    address:         eps?.direccion       || 'Carrera 1 # 1-1',
    // EPS/entidades pagadoras del sector salud: "No responsable de IVA" (R-99-PN),
    // listName "49" (confirmado contra el XML NS82845 validado por el Ministerio).
    // 'O-13' era un valor genérico incorrecto para este tipo de tercero.
    tax_level_code:      'R-99-PN',
    tax_level_list_name: '49',
    document_type:   '31',  // EPS siempre es NIT
    person_type:     '1',   // Persona jurídica
  };
  const periodoDesc = factura.periodo_inicio && factura.periodo_fin
    ? 'Servicios de salud bajo contrato PGP - periodo ' + factura.periodo_inicio + ' al ' + factura.periodo_fin
    : 'Servicios de salud bajo contrato PGP' + (factura.contrato?.numero ? ' ' + factura.contrato.numero : '');
  const line = {
    id: 1,
    description:      periodoDesc,
    quantity:         1,
    unit_price:       Number(factura.subtotal) || 0,
    unit_code:        '94',   // "No aplica" — correcto para PGP (pago global por período, no unidades)
    unspsc:           '85100000',
    tax_type:         'ZA',
    tax_rate:         0,
    discount_percent: 0,
  };
  return {
    customization_id:   'SS-Recaudo', // PGP siempre es SS-Recaudo, independiente de lo guardado en contrato
    prefix:             assignedPrefix,
    number:             assignedNumber,
    issue_date:         factura.issue_date || localDateString(),
    invoice_period_start: factura.periodo_inicio || undefined,
    invoice_period_end:   factura.periodo_fin   || undefined,
    payment_means_code:   'ZZZ',  // Instrumento no definido — estándar para PGP/EPS (no es efectivo)
    issuer:             buildIssuerSalud(company),
    customer,
    software_id:            settings.software_id                  || '',
    software_pin:           settings.software_pin                 || '',
    technical_key_test:     getTechnicalKey(settings),
    resolution_number:      settings.health_resolution_number ?? settings.resolution_number  ?? '',
    resolution_prefix:      assignedPrefix,
    resolution_from:        settings.health_resolution_from ?? settings.resolution_from ?? 990000000,
    resolution_to:          settings.health_resolution_to   ?? settings.resolution_to   ?? 995000000,
    resolution_start_date:  toDateString(settings.health_resolution_start_date ?? settings.health_resolution_date ?? settings.resolution_start_date ?? settings.resolution_date),
    resolution_end_date:    toDateString(settings.health_resolution_end_date ?? settings.resolution_end_date) || addMonths(settings.health_resolution_date ?? settings.resolution_date, 24),
    environment:            settings.environment                  || '2',
    lines:  [line],
    note:   factura.notes || undefined,
    currency: factura.currency || 'COP',
    health: {
      regimen:              factura.regimen            || 'contributivo',
      operation:            factura.tipo_operacion_ss || 'SS-Recaudo',
      cod_prestador:        factura.contrato?.cod_prestador || '',
      tipo_cobertura:       factura.tipo_cobertura    || '',
      // Código real de tipoCoberturaAsegurado (RIPS, Res. 948/2026). PGP no tiene
      // pacientes individuales en este payload, así que se infiere solo del régimen.
      tipo_cobertura_asegurado: inferTipoCobertura(undefined, factura.regimen) || '',
      modalidad_pago:       factura.modalidad_pago    || 'PGP',
      forma_pago_eps:        factura.contrato?.forma_pago_eps || '2',
      contrato_numero:      factura.contrato?.numero  || '',
      cucon:                factura.contrato?.cucon   || '',
      factura_sin_contrato: factura.factura_sin_contrato || '',
      periodo_inicio:       factura.periodo_inicio    || '',
      periodo_fin:          factura.periodo_fin       || '',
    },
  };
}

export function buildHealthEventoXmlPayload(
  factura: FacturaSalud,
  company: Company,
  settings: CompanySettings,
  assignedNumber: number,
  assignedPrefix: string,
  // SAL-008: número de la factura de copago/cuota moderadora al paciente (si aplica),
  // reservado ANTES de construir este payload para poder referenciarla en PrepaidPayment.
  pagoUsuarioInvoiceNumberPreview?: string,
  // SAL-011: nombre real del servicio (catálogo CUPS) por código, para armar la
  // descripción de líneas de consulta/procedimiento igual que ya se hace con
  // medicamentos/otrosServicios. Si no se pasa o el código no está en el
  // catálogo, cae al texto genérico anterior ("Consulta CUPS X").
  nombresServicios: Record<string, string> = {},
): Record<string, unknown> {
  const eps = factura.eps;
  const customer = {
    nit:             eps?.nit             || '222222222222',
    name:            eps?.nombre          || 'EPS',
    city_code:       eps?.ciudad_codigo   || '11001',
    city_name:       eps?.ciudad_nombre   || 'Bogota',
    department_code: eps?.departamento_codigo || '11',
    department_name: eps?.departamento_nombre || 'Bogota',
    address:         eps?.direccion       || 'Carrera 1 # 1-1',
    // EPS/entidades pagadoras del sector salud: "No responsable de IVA" (R-99-PN),
    // listName "49" (confirmado contra el XML NS82845 validado por el Ministerio).
    // 'O-13' era un valor genérico incorrecto para este tipo de tercero.
    tax_level_code:      'R-99-PN',
    tax_level_list_name: '49',
    document_type:   '31',  // EPS siempre es NIT
    person_type:     '1',   // Persona jurídica
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pacientes: Record<string, any>[] = (() => {
    try { return JSON.parse(factura.pacientes_json || '[]'); } catch { return []; }
  })();

  // SAL-020 (Res. 948/2026): código corto del pagador para armar el código real
  // del ítem (ej. CUPS "890244" + "SURA" → "890244SURA"), confirmado contra el
  // XML NS82845. Se deriva de nombre_comercial/nombre de la EPS (mejor esfuerzo:
  // primera palabra, sin tildes ni espacios); si no hay EPS no se arma el código
  // real y la línea cae al comportamiento anterior (UNSPSC genérico).
  const epsShortCode = ((): string => {
    const base = eps?.nombre_comercial || eps?.nombre || '';
    const primera = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/\s+/)[0] || '';
    return primera.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  })();

  const lines: Record<string, unknown>[] = [];
  let lineId = 1;

  for (const p of pacientes) {
    const svcs   = p.servicios || {};
    // Autorización: cada servicio usa su propio numAutorizacion; si no tiene, usa el del paciente.
    // Antes iba concatenada como texto en la descripción — ahora (SAL-020) va en
    // BuyersItemIdentification, y la descripción queda limpia.
    const globalAuth = p.numAutorizacion || '';
    const svcAuthNum = (svc: any): string | undefined => svc.numAutorizacion || globalAuth || undefined;

    for (const c of (svcs.consultas || [])) {
      const codigo = c.codConsulta || '';
      lines.push({
        id:               lineId++,
        // SAL-011: código + nombre real del servicio (ej. "890244 - CONSULTA DE
        // PRIMERA VEZ..."), igual al ejemplo del hallazgo; si el código no está
        // en el catálogo, cae al texto genérico anterior.
        description:      (codigo && nombresServicios[codigo])
          ? `${codigo} - ${nombresServicios[codigo]}`
          : ('Consulta CUPS ' + codigo),
        quantity:         1,
        unit_price:       Number(c.vrServicio) || 0,
        unit_code:        'EA',
        unspsc:           '85100000',
        tax_type:         'ZA',
        tax_rate:         0,
        discount_percent: 0,
        ...(codigo && epsShortCode ? { health_item_code: codigo + epsShortCode } : {}),
        ...(svcAuthNum(c) ? { authorization_number: svcAuthNum(c) } : {}),
        unit_text: 'UND',
      });
    }
    for (const pr of (svcs.procedimientos || [])) {
      const codigo = pr.codProcedimiento || '';
      lines.push({
        id:               lineId++,
        description:      (codigo && nombresServicios[codigo])
          ? `${codigo} - ${nombresServicios[codigo]}`
          : ('Procedimiento CUPS ' + codigo),
        quantity:         1,
        unit_price:       Number(pr.vrServicio) || 0,
        unit_code:        'EA',
        unspsc:           '85100000',
        tax_type:         'ZA',
        tax_rate:         0,
        discount_percent: 0,
        ...(codigo && epsShortCode ? { health_item_code: codigo + epsShortCode } : {}),
        ...(svcAuthNum(pr) ? { authorization_number: svcAuthNum(pr) } : {}),
        unit_text: 'UND',
      });
    }
    for (const m of (svcs.medicamentos || [])) {
      const codigo = m.codTecnologiaSalud || '';
      lines.push({
        id:               lineId++,
        description:      (m.nomTecnologiaSalud || m.codTecnologiaSalud || 'Medicamento'),
        quantity:         Number(m.cantidadMedicamento) || 1,
        unit_price:       Number(m.vrUnitMedicamento) || 0,
        unit_code:        'EA',
        unspsc:           '85100000',
        tax_type:         'ZA',
        tax_rate:         0,
        discount_percent: 0,
        ...(codigo && epsShortCode ? { health_item_code: codigo + epsShortCode } : {}),
        ...(svcAuthNum(m) ? { authorization_number: svcAuthNum(m) } : {}),
        unit_text: 'UND',
      });
    }
    for (const o of (svcs.otrosServicios || [])) {
      const codigo = o.codTecnologiaSalud || '';
      lines.push({
        id:               lineId++,
        description:      (o.nomTecnologiaSalud || o.codTecnologiaSalud || 'Otro servicio'),
        quantity:         Number(o.cantidadOS) || 1,
        unit_price:       Number(o.vrUnitOS) || 0,
        unit_code:        'EA',
        unspsc:           '85100000',
        tax_type:         'ZA',
        tax_rate:         0,
        discount_percent: 0,
        ...(codigo && epsShortCode ? { health_item_code: codigo + epsShortCode } : {}),
        ...(svcAuthNum(o) ? { authorization_number: svcAuthNum(o) } : {}),
        unit_text: 'UND',
      });
    }
  }

  if (lines.length === 0) {
    lines.push({
      id: 1,
      description: 'Servicios de salud por evento' + (factura.contrato?.numero ? ' - Contrato ' + factura.contrato.numero : ''),
      quantity: 1,
      unit_price: Number(factura.subtotal) || 0,
      unit_code: 'EA',
      unspsc: '85100000',
      tax_type: 'ZA',
      tax_rate: 0,
      discount_percent: 0,
    });
  }

  // BUG CORREGIDO (2026-08-31): el fallback anterior usaba factura.issue_date
  // (fecha de HOY, la de transmisión — FAD09e la fija así siempre) cuando no
  // había periodo_inicio/periodo_fin manual. Como "evento" normalmente se
  // factura días o semanas después de prestar el servicio, esto generaba un
  // InvoicePeriod que no cubre la fecha real del servicio -> rechazo RVC014
  // ("la fecha del servicio no debe estar por fuera del periodo de
  // facturación"), confirmado con una prueba real (PRUE62). El periodo debe
  // reflejar las fechas reales de los servicios (fechaInicioAtencion /
  // fechaDispensAdmon / fechaSuministroTecnologia de todos los pacientes),
  // igual que NS82845.xml. Solo se cae a issue_date si no hay ningún servicio
  // con fecha (caso extremo, factura sin líneas).
  const fechasServicio: string[] = [];
  for (const p of pacientes) {
    const svcs = p.servicios || {};
    for (const grupo of [svcs.consultas, svcs.procedimientos, svcs.medicamentos, svcs.otrosServicios]) {
      for (const s of (grupo || [])) {
        const f = s.fechaInicioAtencion || s.fechaDispensAdmon || s.fechaSuministroTecnologia;
        if (f) fechasServicio.push(String(f).slice(0, 10));
      }
    }
  }
  fechasServicio.sort();
  const periodoInicioServicio = fechasServicio[0];
  const periodoFinServicio    = fechasServicio[fechasServicio.length - 1];

  return {
    customization_id:   factura.tipo_operacion_ss || 'SS-CUFE',
    prefix:             assignedPrefix,
    number:             assignedNumber,
    issue_date:         factura.issue_date || localDateString(),
    invoice_period_start: factura.periodo_inicio || periodoInicioServicio || factura.issue_date || undefined,
    invoice_period_end:   factura.periodo_fin    || periodoFinServicio    || factura.issue_date || undefined,
    payment_means_code:   'ZZZ',  // Instrumento no definido — estándar para facturación EPS (no es efectivo)
    issuer:             buildIssuerSalud(company),
    customer,
    software_id:            settings.software_id                  || '',
    software_pin:           settings.software_pin                 || '',
    technical_key_test:     getTechnicalKey(settings),
    resolution_number:      settings.health_resolution_number ?? settings.resolution_number  ?? '',
    resolution_prefix:      assignedPrefix,
    resolution_from:        settings.health_resolution_from ?? settings.resolution_from ?? 990000000,
    resolution_to:          settings.health_resolution_to   ?? settings.resolution_to   ?? 995000000,
    resolution_start_date:  toDateString(settings.health_resolution_start_date ?? settings.health_resolution_date ?? settings.resolution_start_date ?? settings.resolution_date),
    resolution_end_date:    toDateString(settings.health_resolution_end_date ?? settings.resolution_end_date) || addMonths(settings.health_resolution_date ?? settings.resolution_date, 24),
    environment:            settings.environment                  || '2',
    lines,
    note:   factura.notes || undefined,
    currency: factura.currency || 'COP',
    health: {
      regimen:              factura.regimen            || 'contributivo',
      operation:            factura.tipo_operacion_ss || 'SS-CUFE',
      cod_prestador:        factura.contrato?.cod_prestador || '',
      tipo_cobertura:       factura.tipo_cobertura    || '',
      // Código real de tipoCoberturaAsegurado (RIPS, Res. 948/2026), tomado del primer
      // paciente si lo trae explícito, o inferido del régimen de la factura (16/17).
      tipo_cobertura_asegurado: inferTipoCobertura(pacientes[0]?.tipoCoberturaAsegurado, factura.regimen) || '',
      modalidad_pago:       factura.modalidad_pago    || 'Evento',
      forma_pago_eps:        factura.contrato?.forma_pago_eps || '2',
      contrato_numero:      factura.contrato?.numero  || '',
      cucon:                factura.contrato?.cucon   || '',
      factura_sin_contrato: factura.factura_sin_contrato || '',
      // BUG CORREGIDO (2026-08-31): igual que invoice_period_start/end más abajo
      // en este mismo archivo, se usa la fecha real del/los servicio(s) en vez de
      // la fecha de emisión — issue_date es siempre "hoy" (FAD09e) y puede no
      // coincidir con cuándo se prestó el servicio, generando inconsistencia
      // entre este dato (usado para mostrar el periodo en el PDF) y el
      // InvoicePeriod real del XML.
      periodo_inicio:       factura.periodo_inicio || periodoInicioServicio || factura.issue_date || '',
      periodo_fin:          factura.periodo_fin    || periodoFinServicio    || factura.issue_date || '',
      // SAL-008 (Res. 948/2026): copago/cuota moderadora reflejados en cac:PrepaidPayment
      // y en el PayableAmount del XML — solo si la factura trae un cobro al usuario.
      ...(Number(factura.pago_usuario_monto) > 0 ? {
        prepaid_payment: {
          paid_amount: Number(factura.pago_usuario_monto),
          scheme_id:   CONCEPTO_RECAUDO_MAP[factura.tipo_cobro_usuario || ''] || '05',
          received_date: factura.issue_date || undefined,
          // Se pasa también al PDF (ver pdf_generator.py) para mostrar la línea de
          // descuento y el porcentaje cuando es copago — antes el PDF solo llevaba
          // paid_amount/scheme_id (para el XML) y nunca reflejaba visualmente el
          // descuento del PayableAmount, mostrando el total bruto como "Total a pagar".
          tipo_cobro_usuario: factura.tipo_cobro_usuario || 'cuota_moderadora',
          porcentaje: factura.tipo_cobro_usuario === 'copago' ? (factura.pago_usuario_porcentaje ?? undefined) : undefined,
          ...(pagoUsuarioInvoiceNumberPreview ? { invoice_number: pagoUsuarioInvoiceNumberPreview } : {}),
        },
      } : {}),
      // Pacientes: array de objetos {nombre, doc} para la sección Datos Salud del PDF.
      // Las autorizaciones siguen apareciendo en el authSuffix de cada ítem de línea.
      pacientes_info: pacientes.map((p: any) => {
        const nombre = p.nombre ||
          [p.primerNombre, p.segundoNombre, p.primerApellido, p.segundoApellido]
            .filter(Boolean).join(' ') || '';
        const doc = (p.tipoDocumentoIdentificacion || 'CC') + ' ' + (p.numDocumentoIdentificacion || '');
        return { nombre, doc };
      }).filter((pi: any) => pi.nombre || pi.doc) || undefined,
    },
  };
}

/** Infiere tipoCoberturaAsegurado (Res. 948/2026) desde el regimen de la factura.
 *  contributivo → '16', subsidiado → '17'. Devuelve el valor del paciente si está definido. */
function inferTipoCobertura(pCobertura: string | undefined, regimenFactura: string | undefined): string | undefined {
  if (pCobertura) return pCobertura; // el paciente lo trae explícito → usar ese
  if (!regimenFactura) return undefined;
  if (regimenFactura === 'contributivo') return '16';
  if (regimenFactura === 'subsidiado')   return '17';
  return undefined; // especial/excepcion → no inferir, dejar que lo traiga el paciente
}

// SAL-008 (Res. 948/2026): catálogo de concepto de recaudo. Mapeo por defecto según
// convención general RIPS (01=cuota moderadora, 02=copago); 05="Otro" como respaldo
// cuando el tipo de cobro no está definido. Ajustar si Min. Salud confirma otros
// valores para esta empresa/contrato.
const CONCEPTO_RECAUDO_MAP: Record<string, string> = {
  copago:           '02',
  cuota_moderadora: '01',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function aplicarCopagoServicios(
  servicios: Record<string, any>[],
  factura: FacturaSalud,
  pagoUsuarioInvoiceNumber: string | undefined,
  estado: { hecho: boolean },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any>[] {
  return servicios.map((s) => {
    if (Number(s.valorPagoModerador) > 0) {
      // Ya viene cargado explícitamente (plantilla de cargue) — solo falta
      // completar la referencia a la factura de copago, que se asigna después.
      return (pagoUsuarioInvoiceNumber && !s.numFEVPagoModerador)
        ? { ...s, numFEVPagoModerador: pagoUsuarioInvoiceNumber }
        : s;
    }
    if (!estado.hecho && Number(factura.pago_usuario_monto) > 0) {
      // Formulario manual (sin cargue): usar los datos de copago/cuota moderadora
      // de la factura, aplicados al primer servicio del primer paciente.
      estado.hecho = true;
      const concepto = CONCEPTO_RECAUDO_MAP[factura.tipo_cobro_usuario || ''] || '05';
      return {
        ...s,
        conceptoRecaudo:    concepto,
        valorPagoModerador: Number(factura.pago_usuario_monto),
        ...(pagoUsuarioInvoiceNumber ? { numFEVPagoModerador: pagoUsuarioInvoiceNumber } : {}),
      };
    }
    return s;
  });
}

export function buildEventoRipsJson(
  factura: FacturaSalud,
  company: Company,
  invoiceNumber: string,
  // SAL-008: número de la factura de copago/cuota moderadora al paciente (si aplica),
  // reservado ANTES de generar el RIPS para poder referenciarla como numFEVPagoModerador.
  pagoUsuarioInvoiceNumber?: string,
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pacientes: Record<string, any>[] = (() => {
    try { return JSON.parse(factura.pacientes_json || '[]'); } catch { return []; }
  })();

  // BUG CORREGIDO (2026-08-31): un validador RIPS real (paquete PRUE60) rechazó
  // el envío con "Propiedades no permitidas en la estructura del RIPS: cucon".
  // Se confirmó contra el ejemplo válido NS82845.json (root del RIPS) que ni
  // cucon ni facturaSinContrato existen ahí — CUCON es un dato de otro trámite
  // (registro del contrato ante SIIFA/EPS), no un campo del RIPS JSON. Se deja
  // de enviar en el RIPS; el campo cucon sigue existiendo en el contrato para
  // otros usos (ej. XML/CustomTagGeneral) donde sí aplique.

  const usuarios = pacientes.map((p, idx) => {
    const tipoUsuario = p.tipoUsuario || '01';

    return {
      tipoDocumentoIdentificacion:  p.tipoDocumentoIdentificacion  || 'CC',
      numDocumentoIdentificacion:   String(p.numDocumentoIdentificacion || ''),
      tipoUsuario,
      fechaNacimiento:              p.fechaNacimiento              || '',
      codSexo:                      p.codSexo                      || 'M',
      // SAL-021: en el golden (NS82845) codPaisResidencia va como texto ("170"),
      // no como número. Antes salía numérico cuando no venía informado por el
      // paciente (default 170 sin comillas) o cuando el valor cargado llegaba
      // como número (ej. desde Excel).
      codPaisResidencia:            String(p.codPaisResidencia ?? 170),
      codMunicipioResidencia:       p.codMunicipioResidencia       || '11001',
      codZonaTerritorialResidencia: p.codZonaTerritorialResidencia || '01',
      incapacidad:                  p.incapacidad                  || 'NO',
      consecutivo:                  idx + 1,
      codPaisOrigen:                p.codPaisOrigen                || '170',
      // BUG CORREGIDO (2026-08-31): tipoCoberturaAsegurado a nivel de usuario se
      // había agregado especulando con el anexo de Res. 948/2026, pero un
      // validador RIPS real (paquete PRUE60 reenviado) lo rechazó con
      // "Propiedades no permitidas en la estructura del usuario:
      // tipoCoberturaAsegurado" — y el ejemplo válido NS82845.json tampoco lo
      // trae en el usuario. Se quita del RIPS; el dato equivalente para el
      // CustomTag del XML (tipo_cobertura_asegurado) no se toca, sigue igual.
      // registroSIRAS (U12, Res. 948/2026): solo para tipoUsuario=10 (SOAT)
      ...(tipoUsuario === '10' && p.registroSIRAS ? { registroSIRAS: p.registroSIRAS } : {}),
      servicios: (() => {
        // SAL-008: se completa/inyecta el copago-cuota moderadora en el primer
        // servicio del primer paciente que no lo traiga ya explícito (cargue).
        const estadoCopago = { hecho: idx !== 0 };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const consultasBase = (p.servicios?.consultas || []).map((c: any, i: number) => ({
          ...c,
          ...(p.numAutorizacion ? { numAutorizacion: p.numAutorizacion } : {}),
          consecutivo: i + 1,
        }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const procedimientosBase = (p.servicios?.procedimientos || []).map((c: any, i: number) => ({
          ...c,
          ...(p.numAutorizacion ? { numAutorizacion: p.numAutorizacion } : {}),
          consecutivo: i + 1,
        }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const medicamentosBase = (p.servicios?.medicamentos || []).map((c: any, i: number) => ({
          ...c,
          ...(p.numAutorizacion ? { numAutorizacion: p.numAutorizacion } : {}),
          consecutivo: i + 1,
        }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const otrosBase = (p.servicios?.otrosServicios || []).map((c: any, i: number) => ({
          ...c,
          ...(p.numAutorizacion ? { numAutorizacion: p.numAutorizacion } : {}),
          consecutivo: i + 1,
        }));
        const consultas      = aplicarCopagoServicios(consultasBase,      factura, pagoUsuarioInvoiceNumber, estadoCopago);
        const procedimientos = aplicarCopagoServicios(procedimientosBase, factura, pagoUsuarioInvoiceNumber, estadoCopago);
        const medicamentos   = aplicarCopagoServicios(medicamentosBase,   factura, pagoUsuarioInvoiceNumber, estadoCopago);
        const otrosServicios = aplicarCopagoServicios(otrosBase,          factura, pagoUsuarioInvoiceNumber, estadoCopago);
        // SAL-021: el golden (NS82845) omite por completo las categorías de
        // servicio que no tienen registros (ni siquiera aparece la llave vacía
        // []) — antes siempre se incluían las 4 categorías así estuvieran vacías.
        return {
          ...(consultas.length      ? { consultas }      : {}),
          ...(procedimientos.length ? { procedimientos } : {}),
          ...(medicamentos.length   ? { medicamentos }   : {}),
          ...(otrosServicios.length ? { otrosServicios } : {}),
        };
      })(),
    };
  });

  return {
    numDocumentoIdObligado:  company.nit,
    numFactura:              invoiceNumber,
    tipoNota:                null,
    // BUG CORREGIDO (2026-08-31): esta llave se llamaba "numDocumentoReferencia",
    // un nombre inventado que no coincide con el resto del sistema — la plantilla
    // de cargue masivo y su catálogo (servicios-salud.routes.ts) usan "numNota"
    // consistentemente para este mismo campo (RIPS: número de nota, cuando
    // tipoNota no es null). Confirmado también contra NS95285.json (ejemplo
    // validado), que trae la llave "numNota".
    numNota:                 null,
    usuarios,
  };
}

export function buildCreditNoteXmlPayload(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: Record<string, any>,
  company: Company,
  settings: CompanySettings,
  refInvoice: Factura,
  noteNumberOverride?: string,
): Record<string, unknown> {
  const prefix = settings.credit_note_prefix || 'NC';
  let number = settings.next_credit_note_number || 1;
  if (noteNumberOverride) {
    const numStr = noteNumberOverride.startsWith(prefix)
      ? noteNumberOverride.slice(prefix.length)
      : noteNumberOverride;
    const parsed = parseInt(numStr, 10);
    if (!isNaN(parsed)) number = parsed;
  }
  return {
    prefix,
    number,
    issue_date: localDateString(),
    billing_reference: {
      invoice_id:   refInvoice.numero_factura,
      invoice_uuid: refInvoice.cufe,
      invoice_date: refInvoice.fecha_emision,
    },
    discrepancy_code:        body.discrepancy_code        || '1',
    discrepancy_description: body.discrepancy_description || body.discrepancy_desc || undefined,
    issuer:   buildIssuer(company),
    customer: buildCustomer(body.customer || {}),
    software_id:        settings.software_id   || '',
    software_pin:       settings.software_pin  || '',
    technical_key_test: getTechnicalKey(settings),
    environment:        settings.environment   || '2',
    lines:    buildLines(body.lines || []),
    note:     body.notes || body.note || undefined,
    currency: body.currency || 'COP',
  };
}

export function buildDebitNoteXmlPayload(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: Record<string, any>,
  company: Company,
  settings: CompanySettings,
  refInvoice: Factura,
  noteNumberOverride?: string,
): Record<string, unknown> {
  const prefix = settings.debit_note_prefix || 'ND';
  let number = settings.next_debit_note_number || 1;
  if (noteNumberOverride) {
    const numStr = noteNumberOverride.startsWith(prefix)
      ? noteNumberOverride.slice(prefix.length)
      : noteNumberOverride;
    const parsed = parseInt(numStr, 10);
    if (!isNaN(parsed)) number = parsed;
  }
  return {
    prefix,
    number,
    issue_date: localDateString(),
    billing_reference: {
      invoice_id:   refInvoice.numero_factura,
      invoice_uuid: refInvoice.cufe,
      invoice_date: refInvoice.fecha_emision,
    },
    discrepancy_code:        body.discrepancy_code        || '3',
    discrepancy_description: body.discrepancy_description || body.discrepancy_desc || undefined,
    issuer:   buildIssuer(company),
    customer: buildCustomer(body.customer || {}),
    software_id:        settings.software_id   || '',
    software_pin:       settings.software_pin  || '',
    technical_key_test: getTechnicalKey(settings),
    environment:        settings.environment   || '2',
    lines:    buildLines(body.lines || []),
    note:     body.notes || body.note || undefined,
    currency: body.currency || 'COP',
  };
}

export function buildHealthCreditNotePayload(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: Record<string, any>,
  company: Company,
  settings: CompanySettings,
  refFactura: FacturaSalud,
  noteNumberOverride?: string,
): Record<string, unknown> {
  const prefix = settings.health_credit_note_prefix || 'NCSS';
  let number = settings.next_health_credit_note_number || 1;
  if (noteNumberOverride) {
    const numStr = noteNumberOverride.startsWith(prefix)
      ? noteNumberOverride.slice(prefix.length)
      : noteNumberOverride;
    const parsed = parseInt(numStr, 10);
    if (!isNaN(parsed)) number = parsed;
  }
  const eps = (refFactura as unknown as Record<string, unknown>)['eps'] as Record<string, unknown> | undefined;
  const customer = {
    nit:             (eps?.['nit']             as string) || '222222222222',
    name:            (eps?.['nombre']          as string) || 'EPS',
    city_code:       (eps?.['ciudad_codigo']   as string) || '11001',
    city_name:       (eps?.['ciudad_nombre']   as string) || 'Bogota',
    department_code: (eps?.['departamento_codigo'] as string) || '11',
    department_name: (eps?.['departamento_nombre'] as string) || 'Bogota',
    address:         (eps?.['direccion']       as string) || 'Carrera 1 # 1-1',
    // EPS/entidades pagadoras del sector salud: "No responsable de IVA" (R-99-PN),
    // listName "49" (confirmado contra el XML NS82845 validado por el Ministerio).
    // 'O-13' era un valor genérico incorrecto para este tipo de tercero (mismo bug
    // corregido en buildHealthPgpXmlPayload/buildHealthEventoXmlPayload).
    tax_level_code:      'R-99-PN',
    tax_level_list_name: '49',
    document_type:   '31',  // EPS siempre es NIT
    person_type:     '1',   // Persona jurídica
  };
  return {
    prefix,
    number,
    issue_date: localDateString(),
    billing_reference: {
      invoice_id:   refFactura.invoice_number,
      invoice_uuid: refFactura.cufe,
      invoice_date: refFactura.issue_date,
    },
    discrepancy_code:        body.discrepancy_code        || '1',
    discrepancy_description: body.discrepancy_description || body.discrepancy_desc || undefined,
    issuer:   buildIssuerSalud(company),
    customer,
    software_id:            settings.software_id   || '',
    software_pin:           settings.software_pin  || '',
    technical_key_test:     getTechnicalKey(settings),
    resolution_number:      settings.health_resolution_number ?? settings.resolution_number ?? '',
    resolution_prefix:      prefix,
    resolution_from:        settings.health_resolution_from ?? settings.resolution_from ?? 990000000,
    resolution_to:          settings.health_resolution_to   ?? settings.resolution_to   ?? 995000000,
    resolution_start_date:  toDateString(settings.health_resolution_start_date ?? settings.health_resolution_date ?? settings.resolution_start_date ?? settings.resolution_date),
    resolution_end_date:    toDateString(settings.health_resolution_end_date ?? settings.resolution_end_date) || addMonths(settings.health_resolution_date ?? settings.resolution_date, 24),
    environment:            settings.environment   || '2',
    lines:    buildLines(body.lines || []),
    note:     body.notes || body.note || undefined,
    currency: body.currency || 'COP',
    health: {
      regimen:              refFactura.regimen            || 'contributivo',
      cod_prestador:        refFactura.contrato?.cod_prestador || '',
      tipo_cobertura_asegurado: inferTipoCobertura(undefined, refFactura.regimen) || '',
      modalidad_pago:       refFactura.modalidad_pago    || 'Evento',
      forma_pago_eps:        refFactura.contrato?.forma_pago_eps || '2',
      cucon:                refFactura.contrato?.cucon   || '',
      factura_sin_contrato: refFactura.factura_sin_contrato || '',
      periodo_inicio:       refFactura.periodo_inicio    || '',
      periodo_fin:          refFactura.periodo_fin       || '',
    },
  };
}

export function buildHealthDebitNotePayload(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: Record<string, any>,
  company: Company,
  settings: CompanySettings,
  refFactura: FacturaSalud,
  noteNumberOverride?: string,
): Record<string, unknown> {
  const prefix = settings.health_debit_note_prefix || 'NDSS';
  let number = settings.next_health_debit_note_number || 1;
  if (noteNumberOverride) {
    const numStr = noteNumberOverride.startsWith(prefix)
      ? noteNumberOverride.slice(prefix.length)
      : noteNumberOverride;
    const parsed = parseInt(numStr, 10);
    if (!isNaN(parsed)) number = parsed;
  }
  const eps = (refFactura as unknown as Record<string, unknown>)['eps'] as Record<string, unknown> | undefined;
  const customer = {
    nit:             (eps?.['nit']             as string) || '222222222222',
    name:            (eps?.['nombre']          as string) || 'EPS',
    city_code:       (eps?.['ciudad_codigo']   as string) || '11001',
    city_name:       (eps?.['ciudad_nombre']   as string) || 'Bogota',
    department_code: (eps?.['departamento_codigo'] as string) || '11',
    department_name: (eps?.['departamento_nombre'] as string) || 'Bogota',
    address:         (eps?.['direccion']       as string) || 'Carrera 1 # 1-1',
    // EPS/entidades pagadoras del sector salud: "No responsable de IVA" (R-99-PN),
    // listName "49" (confirmado contra el XML NS82845 validado por el Ministerio).
    // 'O-13' era un valor genérico incorrecto para este tipo de tercero (mismo bug
    // corregido en buildHealthPgpXmlPayload/buildHealthEventoXmlPayload).
    tax_level_code:      'R-99-PN',
    tax_level_list_name: '49',
    document_type:   '31',  // EPS siempre es NIT
    person_type:     '1',   // Persona jurídica
  };
  return {
    prefix,
    number,
    issue_date: localDateString(),
    billing_reference: {
      invoice_id:   refFactura.invoice_number,
      invoice_uuid: refFactura.cufe,
      invoice_date: refFactura.issue_date,
    },
    discrepancy_code:        body.discrepancy_code        || '1',
    discrepancy_description: body.discrepancy_description || body.discrepancy_desc || undefined,
    issuer:   buildIssuerSalud(company),
    customer,
    software_id:            settings.software_id   || '',
    software_pin:           settings.software_pin  || '',
    technical_key_test:     getTechnicalKey(settings),
    resolution_number:      settings.health_resolution_number ?? settings.resolution_number ?? '',
    resolution_prefix:      prefix,
    resolution_from:        settings.health_resolution_from ?? settings.resolution_from ?? 990000000,
    resolution_to:          settings.health_resolution_to   ?? settings.resolution_to   ?? 995000000,
    resolution_start_date:  toDateString(settings.health_resolution_start_date ?? settings.health_resolution_date ?? settings.resolution_start_date ?? settings.resolution_date),
    resolution_end_date:    toDateString(settings.health_resolution_end_date ?? settings.resolution_end_date) || addMonths(settings.health_resolution_date ?? settings.resolution_date, 24),
    environment:            settings.environment   || '2',
    lines:    buildLines(body.lines || []),
    note:     body.note     || undefined,
    currency: body.currency || 'COP',
    health: {
      regimen:              refFactura.regimen            || 'contributivo',
      cod_prestador:        refFactura.contrato?.cod_prestador || '',
      tipo_cobertura_asegurado: inferTipoCobertura(undefined, refFactura.regimen) || '',
      modalidad_pago:       refFactura.modalidad_pago    || 'Evento',
      forma_pago_eps:        refFactura.contrato?.forma_pago_eps || '2',
      cucon:                refFactura.contrato?.cucon   || '',
      factura_sin_contrato: refFactura.factura_sin_contrato || '',
      periodo_inicio:       refFactura.periodo_inicio    || '',
      periodo_fin:          refFactura.periodo_fin       || '',
    },
  };
}

/**
 * Construye el payload para la factura de pago por usuario dirigida al paciente.
 * Según Concepto DIAN 012008/2026: cuando el pago es compartido EPS+usuario
 * se deben emitir dos facturas separadas. Esta es la factura al usuario.
 *
 * @param factura  FacturaSalud original (ya debe tener pacientes_json)
 * @param company  Empresa emisora
 * @param settings Configuración DIAN
 * @param assignedPrefix  Prefijo asignado para el número de factura pago usuario
 * @param assignedNumber  Número asignado para la factura pago usuario
 */
export function buildPagoUsuarioXmlPayload(
  factura: FacturaSalud,
  company: Company,
  settings: CompanySettings,
  assignedPrefix: string,
  assignedNumber: number,
  municipioData?: { ciudad_nombre?: string; departamento_nombre?: string },
): Record<string, unknown> {
  // Primer paciente: es quien pagó el pago por usuario
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pacientes: Record<string, any>[] = (() => {
    try { return JSON.parse(factura.pacientes_json || '[]'); } catch { return []; }
  })();
  const p = pacientes[0] || {};

  const nombre = p.nombre ||
    [p.primerNombre, p.segundoNombre, p.primerApellido, p.segundoApellido]
      .filter(Boolean).join(' ') || 'Paciente';

  // Tipo de documento del paciente -> código DIAN tabla 6.3.4
  const tipoId = (p.tipoDocumentoIdentificacion || 'CC').toUpperCase();
  const dianDoc = TIPO_ID_TO_DIAN[tipoId] ?? { schemeID: '13', personType: '2' };

  // Municipio del paciente (RIPS usa codMunicipioResidencia de 5 dígitos)
  const cityCode = p.codMunicipioResidencia || '11001';
  const deptCode = cityCode.slice(0, 2);

  const customer = {
    nit:             p.numDocumentoIdentificacion || '222222222222',
    dv:              undefined,   // personas naturales no tienen DV
    name:            nombre,
    city_code:       cityCode,
    city_name:       municipioData?.ciudad_nombre       || p.ciudad_nombre        || '',
    department_code: deptCode,
    department_name: municipioData?.departamento_nombre || p.departamento_nombre  || '',
    address:         p.direccion       || 'No suministrada',
    tax_level_code:  'R-99-PN',
    document_type:   dianDoc.schemeID,
    person_type:     '2',
    email:           p.email       || '',
    phone:           p.telefono    || '',
    // cac:Person (FAK61) — usar campos individuales del paciente cuando estén disponibles
    first_name:        p.primerNombre   || nombre.split(' ')[0] || 'Paciente',
    middle_name:       p.segundoNombre  || undefined,
    family_name:       p.primerApellido || nombre.split(' ').slice(1).join(' ') || undefined,
    second_family_name: p.segundoApellido || undefined,
  };

  const pagoMonto = Number(factura.pago_usuario_monto) || 0;
  const tipoCobro = factura.tipo_cobro_usuario;

  // Descripción e nota dinámicas según tipo de cobro
  let refDesc: string;
  let nota: string;
  if (tipoCobro === 'copago') {
    refDesc = `Copago (${factura.pago_usuario_porcentaje ?? ''}%) – Ref. factura ${factura.invoice_number || ''}`;
    nota    = `Copago por servicios de salud. Factura principal: ${factura.invoice_number || ''}`.trim();
  } else {
    // cuota_moderadora o undefined
    refDesc = `Cuota moderadora – Ref. factura ${factura.invoice_number || ''}`;
    nota    = `Cuota moderadora por servicios de salud. Factura principal: ${factura.invoice_number || ''}`.trim();
  }

  return {
    // Factura comercial estándar (no sector salud) — el adquiriente es el paciente (persona natural)
    customization_id:   '10',
    prefix:             assignedPrefix,
    number:             assignedNumber,
    issue_date:         factura.issue_date || localDateString(),
    issuer:             buildIssuer(company),
    customer,
    software_id:            settings.software_id    || '',
    software_pin:           settings.software_pin   || '',
    technical_key_test:     getTechnicalKey(settings),
    resolution_number:      settings.health_resolution_number ?? settings.resolution_number  ?? '',
    resolution_prefix:      assignedPrefix,
    resolution_from:        settings.health_resolution_from ?? settings.resolution_from ?? 990000000,
    resolution_to:          settings.health_resolution_to   ?? settings.resolution_to   ?? 995000000,
    resolution_start_date:  toDateString(settings.health_resolution_start_date ?? settings.health_resolution_date ?? settings.resolution_start_date ?? settings.resolution_date),
    resolution_end_date:    toDateString(settings.health_resolution_end_date ?? settings.resolution_end_date) || addMonths(settings.health_resolution_date ?? settings.resolution_date, 24),
    environment:            settings.environment    || '2',
    currency:               factura.currency        || 'COP',
    note:                   nota,
    // Forma de pago DIAN (tabla 6.3.4.1) para la factura de pago por usuario al
    // paciente — configurable por contrato (ContratoSalud.forma_pago_usuario).
    // Ver builder.py: aplica solo porque este documento SÍ envía payment_means_id
    // explícitamente; las facturas comerciales normales (buildInvoiceXmlPayload)
    // nunca setean este campo y no se ven afectadas.
    payment_means_id:      factura.contrato?.forma_pago_usuario || '1',
    lines: [{
      id:               1,
      description:      refDesc,
      quantity:         1,
      unit_price:       pagoMonto,
      unit_code:        'EA',
      unspsc:           '85100000',
      tax_type:         'ZA',   // excluido de IVA (servicios de salud)
      tax_rate:         0,
      discount_percent: 0,
    }],
    // Sin sección health — es una factura comercial dirigida a la persona natural
  };
}
