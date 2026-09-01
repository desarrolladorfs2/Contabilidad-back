/**
 * ds-payload.utils.ts
 *
 * Construye el payload JSON que recibe xml_builder_cli.py (generate-ds)
 * para generar el XML UBL 2.1 del Documento Soporte (Res. 0167/2021).
 *
 * ROLES EN DS — CONFIRMADO en el Anexo Técnico oficial (dian.gov.co), al revés de lo
 * que se asumía originalmente:
 *   AccountingSupplierParty (XML) = VENDEDOR / SNO = proveedor no obligado a facturar
 *   AccountingCustomerParty (XML) = ADQUIRIENTE / ABS = nuestra empresa (obligada)
 *
 * Este archivo sigue construyendo "issuer" = nuestra empresa y "customer" = proveedor
 * (los nombres se mantienen por compatibilidad) — es ds_builder.py (Python) quien decide
 * a qué tag UBL (Supplier/Customer) va cada uno. Nuestra empresa sigue siendo quien genera
 * y firma el documento; solo cambia en qué tag UBL queda su identidad legal.
 *
 * El payload debe cumplir el schema DsGenerationRequest de ds_builder.py,
 * que reutiliza el mismo patrón de InvoiceGenerationRequest del builder de facturas.
 */

import { Company }          from '../entities/Company';
import { CompanySettings }  from '../entities/CompanySettings';
import { DocumentoSoporte } from '../entities/compras/DocumentoSoporte';
import { NotaAjusteDS }     from '../entities/compras/NotaAjusteDS';

/** Mapeo tipo_id → schemeID DIAN (tabla 6.3.4) */
const TIPO_ID_MAP: Record<string, { schemeID: string; personType: string }> = {
  'NIT': { schemeID: '31', personType: '1' },
  'CC':  { schemeID: '13', personType: '2' },
  'CE':  { schemeID: '22', personType: '2' },
  'PP':  { schemeID: '41', personType: '2' },
  'PAS': { schemeID: '41', personType: '2' },
  'TI':  { schemeID: '12', personType: '2' },
  'RC':  { schemeID: '11', personType: '2' },
  'TE':  { schemeID: '21', personType: '2' },
  'PEP': { schemeID: '47', personType: '2' },
  'NUIP':{ schemeID: '91', personType: '2' },
  'IE':  { schemeID: '42', personType: '2' },
};

function tipoIdDian(tipoId: string): { schemeID: string; personType: string } {
  return TIPO_ID_MAP[tipoId?.toUpperCase()] ?? { schemeID: '13', personType: '2' };
}

/**
 * CustomizationID para Documento Soporte — CONFIRMADO contra el ejemplo oficial
 * DIAN "DocumentoSoporte-OperacionConResidente.xml" (caja de herramientas
 * Validación Previa v1.1, tabla TipoOperacion-2.1.gc): NO es un código de "tipo
 * de documento" por tipo_ds (DS01..DS04, como se asumía originalmente — ese
 * intento causaba los rechazos DSAD02b/DSFC04). Es el indicador de
 * Residente(10)/No Residente(11) del PROVEEDOR/SNO (vendedor), no de nuestra
 * empresa ni del tipo de DS.
 *
 * Se deriva de tipoIdDian(): los esquemas de identificación NO válidos para
 * TipoIdFiscal-2.1.gc en Documento Soporte (13=CC, 12=TI, 11=RC, 91=NUIP) son
 * personas naturales colombianas → Residente (se fuerza igualmente a NIT/31 en
 * el XML final, ver ds_builder.py). Los esquemas de extranjeros que sí están en
 * esa tabla (21=TE, 22=CE, 41=PP/PAS, 42=IE, 47=PEP, 50=NIT otro país) → No
 * Residente.
 */
const RESIDENTE_SCHEME_IDS = new Set(['13', '12', '11', '91', '31']);

function customizationIdForProveedor(tipoId: string | undefined | null): string {
  const { schemeID } = tipoIdDian(tipoId || 'CC');
  return RESIDENTE_SCHEME_IDS.has(schemeID) ? '10' : '11';
}

function toDateStr(d: string | Date | undefined | null): string {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  return (d as Date).toISOString().slice(0, 10);
}

/**
 * Parsea el campo lineas de forma robusta.
 * TypeORM puede devolver el campo simple-json como string crudo en algunos casos.
 */
function parseLineas(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try { return JSON.parse(raw); } catch { return []; }
  }
  return [];
}

/**
 * Convierte las líneas del DS (formato DB) al formato InvoiceLineItem
 * que espera el builder Python.
 */
function buildLines(lineas: any[]): Record<string, unknown>[] {
  return lineas.map((l: any) => {
    const qty   = +(l.cantidad    ?? l.quantity  ?? 1);
    const price = +(l.precio_unitario ?? l.unit_price ?? 0);
    const iva   = +(l.valor_iva   ?? l.tax_amount ?? 0);

    // Calcular tasa de IVA a partir del valor; si no hay IVA, tipo 01 con 0%
    let taxRate = 0;
    if (price > 0 && qty > 0 && iva > 0) {
      taxRate = Math.round((iva / (price * qty)) * 100 * 100) / 100;
    }

    return {
      description:      l.descripcion ?? l.description ?? 'Servicio',
      quantity:         qty,
      unit_price:       price,
      tax_type:         '01', // IVA (código 01)
      tax_rate:         taxRate,
      unit_code:        l.unit_code  ?? 'EA',
      unspsc:           l.unspsc     ?? '43231500',
      discount_percent: +(l.descuento_porcentaje ?? l.discount_percent ?? 0),
    };
  });
}

/** Construye el bloque de nuestra empresa (adquiriente/ABS) — va como AccountingCustomerParty en el XML DS */
function buildEmisor(company: Company): Record<string, unknown> {
  return {
    nit:             company.nit,
    dv:              company.nit_dv   || undefined,
    name:            company.name,
    trade_name:      company.trade_name || company.name,
    city_code:       company.city_code        || '11001',
    city_name:       company.city_name        || 'Bogota',
    department_code: company.department_code  || '11',
    department_name: company.department_name  || 'Bogota',
    address:         company.address          || 'Carrera 1 # 1-1',
    tax_level_code:  company.tax_level_code   || 'O-13',
    tax_scheme_id:   '01',
    tax_scheme_name: 'IVA',
    email:           company.email            || undefined,
    document_type:   '31',   // Emisor siempre NIT
    person_type:     '1',    // Persona jurídica
  };
}

/** Construye el bloque del proveedor no obligado (vendedor/SNO) — va como AccountingSupplierParty en el XML DS */
function buildProveedor(ds: DocumentoSoporte): Record<string, unknown> {
  const tipoInfo = tipoIdDian(ds.proveedor_tipo_id || 'CC');
  const isPersonaNatural = tipoInfo.personType === '2';

  const base: Record<string, unknown> = {
    nit:             ds.proveedor_nit,
    name:            ds.proveedor_nombre,
    city_code:       ds.proveedor_ciudad_codigo       || '11001',
    city_name:       ds.proveedor_ciudad_nombre       || 'Bogota',
    department_code: ds.proveedor_departamento_codigo || '11',
    department_name: ds.proveedor_departamento_nombre || 'Bogota',
    address:         ds.proveedor_direccion           || 'Carrera 1 # 1-1',
    email:           ds.proveedor_email               || undefined,
    phone:           ds.proveedor_telefono            || undefined,
    document_type:   tipoInfo.schemeID,
    person_type:     tipoInfo.personType,
    tax_level_code:  'R-99-PN',  // No obligado a facturar
    tax_scheme_id:   '01',
    tax_scheme_name: 'IVA',
  };

  // Para persona natural: incluir nombres y apellidos por separado (FAK61)
  if (isPersonaNatural) {
    base.first_name         = ds.proveedor_primer_nombre    || undefined;
    base.middle_name        = ds.proveedor_segundo_nombre   || undefined;
    base.family_name        = ds.proveedor_primer_apellido  || undefined;
    base.second_family_name = ds.proveedor_segundo_apellido || undefined;
  }

  return base;
}

// ────────────────────────────────────────────────────────────────────────────────

/**
 * Payload para generate-ds (xml_builder_cli.py).
 * Cumple el schema DsGenerationRequest de ds_builder.py.
 */
export function buildDsXmlPayload(
  ds:       DocumentoSoporte,
  company:  Company,
  settings: CompanySettings,
): Record<string, unknown> {
  // Parseo robusto: TypeORM puede devolver simple-json como string crudo
  let lineas = parseLineas(ds.lineas);

  // Fallback: si no hay líneas, construir una sintética con los totales del DS
  // Esto ocurre cuando addSelect no deserializa el campo select:false correctamente
  if (lineas.length === 0 && +ds.subtotal > 0) {
    lineas = [{
      descripcion:      'Bienes y/o servicios adquiridos',
      cantidad:         1,
      precio_unitario:  +ds.subtotal,
      valor_iva:        +(ds.iva_total  ?? 0),
      total:            +ds.total,
    }];
    console.warn('[DS] lineas vacías — usando línea sintética desde totales para', ds.numero_ds);
  }

  // Resolución / rango de numeración autorizado para DS (sts:InvoiceControl —
  // obligatorio en el esquema DIAN, es lo que faltaba y causaba el ZB01).
  // Si no hay una resolución DS específica configurada, se usa la resolución
  // general de facturación como respaldo (común durante habilitación cuando
  // la DIAN asigna un solo set de pruebas para todos los tipos de documento).
  const resolutionNumber = settings.ds_resolution_number || settings.resolution_number || '';
  if (!resolutionNumber) {
    console.warn(
      '[DS] No hay número de resolución/autorización DIAN configurado para Documento ' +
      'Soporte (ds_resolution_number ni resolution_number). La DIAN exige sts:InvoiceControl ' +
      'con un número de autorización válido — configúralo en Ajustes de la empresa.'
    );
  }
  const resolutionStart = toDateStr(
    settings.ds_resolution_start_date || settings.resolution_start_date ||
    settings.ds_resolution_date       || settings.resolution_date
  ) || toDateStr(ds.fecha_emision);
  const resolutionEnd = toDateStr(settings.ds_resolution_end_date || settings.resolution_end_date) || '2030-12-31';

  return {
    // Identificación del documento
    document_id:      ds.numero_ds,                    // "DS-000009" — ID completo
    prefix:           ds.prefijo || 'DS',              // para CorporateRegistrationScheme
    number:           ds.numero  || 1,

    issue_date:       toDateStr(ds.fecha_emision),
    currency:         ds.moneda || 'COP',

    // CustomizationID según tipo_ds
    customization_id: customizationIdForProveedor(ds.proveedor_tipo_id),

    // Nuestra empresa (adquiriente/ABS) — ds_builder.py la coloca en AccountingCustomerParty
    issuer:           buildEmisor(company),

    // Proveedor no obligado (vendedor/SNO) — ds_builder.py lo coloca en AccountingSupplierParty
    customer:         buildProveedor(ds),

    // Config técnica DIAN
    software_id:          settings.software_id           || '',
    software_pin:         settings.software_pin          || '',
    technical_key_test:   settings.technical_key_prod    || settings.technical_key_test || '',
    environment:          settings.environment            || '2',

    resolution_number:     resolutionNumber,
    resolution_prefix:     settings.ds_resolution_prefix || ds.prefijo || settings.resolution_prefix || 'DS',
    resolution_from:       settings.ds_resolution_from   ?? settings.resolution_from   ?? 1,
    resolution_to:         settings.ds_resolution_to     ?? settings.resolution_to     ?? 99999999,
    resolution_start_date: resolutionStart,
    resolution_end_date:   resolutionEnd,

    // Notas
    note: ds.notas || undefined,

    // Líneas convertidas al formato InvoiceLineItem
    lines: buildLines(lineas),
  };
}

/**
 * Calcula los campos de retención agregados a partir de las líneas del DS
 * (rete_rate / valor_rete, capturados por línea en el formulario) — para
 * mostrarlos en el PDF, que solo entiende un bloque de retención a nivel de
 * documento (mismo formato que usa Factura: tiene_retencion/valor_retencion/
 * tarifa_retencion/concepto_retencion). FBK-013: la retención ya se calcula y
 * se guarda por línea, pero nunca llegaba al PDF — este es solo un ajuste de
 * mapeo para el PDF, no cambia lo que se calcula ni se guarda en BD, y NO se
 * envía a la DIAN (el XML UBL del DS no lleva este bloque).
 */
function computeRetencionDs(lineas: any[]): { tiene: boolean; valor: number; tarifa: number; concepto: string } {
  let valor = 0;
  let baseTotal = 0;
  const tarifas = new Set<number>();
  for (const l of lineas) {
    const v = +(l.valor_rete ?? 0);
    const r = +(l.rete_rate ?? 0);
    if (v > 0) {
      valor += v;
      tarifas.add(r);
    }
    const qty   = +(l.cantidad ?? l.quantity ?? 1);
    const price = +(l.precio_unitario ?? l.unit_price ?? 0);
    baseTotal += qty * price;
  }
  if (valor <= 0) return { tiene: false, valor: 0, tarifa: 0, concepto: '' };
  // Si todas las líneas con retención usan la misma tarifa, se muestra esa tarifa
  // tal cual; si hay tarifas mixtas, se muestra la tarifa efectiva (blended).
  const tarifa = tarifas.size === 1
    ? [...tarifas][0]
    : Math.round((valor / (baseTotal || valor)) * 100 * 100) / 100;
  const concepto = tarifas.size === 1
    ? 'Retención en la fuente'
    : 'Retención en la fuente (tarifas mixtas por línea)';
  return { tiene: true, valor: Math.round(valor * 100) / 100, tarifa, concepto };
}

/**
 * Payload para generate-ds-pdf (xml_builder_cli.py).
 */
export function buildDsPdfPayload(
  ds:       DocumentoSoporte,
  company:  Company,
  settings: CompanySettings,
  cuds?:    string,
): Record<string, unknown> {
  const lineas = parseLineas(ds.lineas);
  const retencion = computeRetencionDs(lineas);
  return {
    ...buildDsXmlPayload(ds, company, settings),
    // El PDF usa 'cufe' o 'cuds' según la operación
    cufe:              cuds || ds.cuds || undefined,
    cuds:              cuds || ds.cuds || undefined,
    document_type:     'ds',
    // Título exacto requerido en el PDF por la resolución DIAN
    pdf_title:         'Documento soporte en adquisiciones efectuadas a no obligados a facturar',
    // logoParaPdf es una RUTA de archivo, no base64 — hay que leer y codificar el
    // archivo, igual que hacen invoices.routes.ts / credit-notes.routes.ts. Antes se
    // pasaba la ruta cruda como si fuera base64, por eso el PDF del DS nunca mostraba
    // ni el logo ni la marca de agua.
    logo_base64:       readLogoBase64(settings.logoParaPdf),
    pdf_primary_color: settings.pdf_primary_color || '#1a56db',
    // Firma Digital Electrónica en el PDF — requiere que el XML ya esté firmado
    // (procesarYEnviarDs() ahora firma ANTES de generar el PDF, igual que facturas).
    signed_xml_b64:    ds.signed_xml_base64 || undefined,
    // FBK-013: retención calculada por línea, expuesta al PDF (solo visual).
    tiene_retencion:    retencion.tiene,
    valor_retencion:    retencion.valor,
    tarifa_retencion:   retencion.tarifa,
    concepto_retencion: retencion.concepto || undefined,
    // FBK-011/014: forma y medio de pago del DS, mismo formato que Factura/FacturaCompra.
    payment_means_id:  ds.payment_means_id  || '1',
    payment_method_id: ds.payment_method_id || '42',
  };
}

/** Lee el archivo de logo desde disco y lo codifica en base64 (o undefined si no existe). */
function readLogoBase64(logoPath?: string): string | undefined {
  if (!logoPath) return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('fs').readFileSync(logoPath).toString('base64');
  } catch {
    return undefined;
  }
}

// ────────────────────────────────────────────────────────────────────────────────

/**
 * Payload para Nota de Ajuste DS (operación generate-credit-note / generate-debit-note).
 * Las notas de ajuste DS siguen el mismo formato que NC/ND de facturas.
 */
export function buildNotaAjusteDsXmlPayload(
  nota:     NotaAjusteDS,
  ds:       DocumentoSoporte,
  company:  Company,
  settings: CompanySettings,
): Record<string, unknown> {
  // NC_DS → 92, ND_DS → 93
  const docTypeCode = nota.tipo === 'NC_DS' ? '92' : '93';

  return {
    document_type_code:     docTypeCode,
    customization_id:       customizationIdForProveedor(ds.proveedor_tipo_id),
    nota_number:            nota.numero_nota_ajuste,
    issue_date:             toDateStr(nota.fecha_emision),
    currency:               nota.moneda || 'COP',
    description:            nota.descripcion || '',
    discrepancy_code:       nota.codigo_discrepancia    || undefined,
    discrepancy_description:nota.descripcion_discrepancia || undefined,

    // DS referenciado
    ref_ds_number:          ds.numero_ds,
    ref_ds_cuds:            ds.cuds || undefined,
    ref_ds_date:            toDateStr(ds.fecha_emision),

    // Nuestra empresa como "supplier" en el XML
    issuer:                 buildEmisor(company),

    // El no obligado como "customer" en el XML
    customer:               buildProveedor(ds),

    resolution_number:      settings.ds_resolution_number || settings.resolution_number || '',
    technical_key_test:     settings.technical_key_prod   || settings.technical_key_test || '',
    environment:            settings.environment           || '2',
    software_id:            settings.software_id           || '',
    software_pin:           settings.software_pin          || '',

    subtotal:               +nota.subtotal,
    total_impuestos:        +nota.total_impuestos,
    total:                  +nota.total,

    lines:                  nota.lineas || [],
  };
}
