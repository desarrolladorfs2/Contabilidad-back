import { Router, Response } from 'express';
import * as XLSX from 'xlsx';
import AdmZip from 'adm-zip';
import multer from 'multer';
import { AppDataSource } from '../../config/database';
import { reservarConsecutivo } from '../../utils/consecutivo.util';
import { FacturaSalud } from '../../entities/salud/FacturaSalud';
import { Company } from '../../entities/Company';
import { CompanySettings } from '../../entities/CompanySettings';
import { authMiddleware, AuthRequest, requireRole } from '../../middleware/auth.middleware';
import { generateInvoiceXml, generateInvoicePdf, generateTirillaPdf, signXml, sendToDAIN, getCertCredentials, getStatusDian } from '../../services/dian.service';
import { buildHealthPgpXmlPayload, buildHealthEventoXmlPayload, buildEventoRipsJson, buildPagoUsuarioXmlPayload } from '../../utils/dian-payload.utils';
import { registrarAuditoria, AUDITORIA_ACCION, AUDITORIA_ENTIDAD } from '../../services/auditoria.service';
import { saveRipsJson, readRipsJson } from '../../services/rips-storage.service';
import { resolveUploadPath } from '../../services/uploads.service';
import { RegistroCargue } from '../../entities/salud/RegistroCargue';
import { Municipio } from '../../entities/catalogo/Municipio';
import { ContratoSalud } from '../../entities/salud/ContratoSalud';
import { ServicioSalud } from '../../entities/salud/ServicioSalud';
import { generarAsientoDesdeFacturaSalud } from '../../services/asiento-generator';

/**
 * Valida que centro_costo_id/punto_pago_sede_id vengan informados y que ambos
 * pertenezcan a los permitidos por el contrato (contrato.centros_costo / contrato.sedes).
 * Un contrato puede cubrir varias ciudades/sedes; la factura elige UNA de cada.
 */
async function validarCcSedeContrato(contratoId: string | undefined, centroCostoId: string | undefined, sedeId: string | undefined): Promise<string | null> {
  if (!centroCostoId) return 'El centro de costo es obligatorio';
  if (!sedeId) return 'La sede es obligatoria';
  if (!contratoId) return null; // sin contrato (ej. factura sin contrato) no hay set contra el cual validar
  const contrato = await AppDataSource.getRepository(ContratoSalud)
    .findOne({ where: { id: contratoId }, relations: ['centros_costo', 'sedes'] });
  if (!contrato) return null;
  if (contrato.centros_costo?.length && !contrato.centros_costo.some(c => c.id === centroCostoId)) {
    return 'El centro de costo seleccionado no está habilitado para este contrato';
  }
  if (contrato.sedes?.length && !contrato.sedes.some(s => s.id === sedeId)) {
    return 'La sede seleccionada no está habilitada para este contrato';
  }
  return null;
}

/** Calcula el Dígito Verificador (DV) de un NIT colombiano. */
function calcDV(nit: string): string {
  const digits = nit.replace(/\D/g, '');
  const weights = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47];
  const rev = digits.split('').reverse();
  const sum = rev.reduce((acc, d, i) => acc + parseInt(d, 10) * (weights[i] ?? 1), 0);
  const rem = sum % 11;
  return String(rem < 2 ? rem : 11 - rem);
}

/** Busca nombre de ciudad y departamento por código DANE de 5 dígitos. */
async function lookupMunicipio(cityCode: string): Promise<{ ciudad_nombre: string; departamento_nombre: string }> {
  try {
    const m = await AppDataSource.getRepository(Municipio).findOne({
      where: { codigo_dane: cityCode },
      relations: ['departamento'],
    });
    return {
      ciudad_nombre:       m?.nombre                  || '',
      departamento_nombre: m?.departamento?.nombre    || '',
    };
  } catch {
    return { ciudad_nombre: '', departamento_nombre: '' };
  }
}

/**
 * SAL-011: nombre real del servicio (catálogo CUPS de la empresa) por código,
 * para armar la descripción de líneas de consulta/procedimiento en el XML/PDF
 * (igual que medicamentos/otrosServicios, que ya traen su nombre real). No se
 * usa para el RIPS — el RIPS de consultas/procedimientos no lleva ese campo.
 */
/**
 * SAL-015 (Res. 948/2026): valida que cada paciente traiga fecha de nacimiento,
 * correo y tipo de usuario — el backend no validaba el contenido del arreglo de
 * pacientes al guardar la factura, solo el frontend (y ni siquiera eso, hasta
 * ahora). Devuelve el primer mensaje de error encontrado, o null si todo bien.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function validarPacientesRipsCompletos(pacientes: any[]): string | null {
  for (let i = 0; i < pacientes.length; i++) {
    const p = pacientes[i];
    const nombre = p?.nombre || `Paciente ${i + 1}`;
    if (!p?.fechaNacimiento) return `${nombre}: falta la fecha de nacimiento`;
    if (!p?.email)           return `${nombre}: falta el correo electrónico`;
    if (!p?.tipoUsuario)     return `${nombre}: falta el tipo de usuario`;
  }
  return null;
}

async function lookupNombresServicios(companyId: string): Promise<Record<string, string>> {
  const items = await AppDataSource.getRepository(ServicioSalud).find({ where: { company_id: companyId } });
  const map: Record<string, string> = {};
  for (const s of items) if (s.nombre) map[s.codigo_cups] = s.nombre;
  return map;
}

const router = Router();
router.use(authMiddleware);

const repo   = () => AppDataSource.getRepository(FacturaSalud);
const upload = multer({ storage: multer.memoryStorage() });

// ── GET /api/salud/facturas?page=1&limit=20&q=&tipo=&status=
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { page = '1', limit = '20', q = '', tipo, status, origen_modulo } = req.query as Record<string, string>;
    const cid = req.user!.companyId;

    const qb = repo().createQueryBuilder('f')
      .leftJoinAndSelect('f.eps', 'eps')
      .leftJoinAndSelect('f.contrato', 'contrato')
      .where('f.company_id = :cid', { cid })
      // Orden por fecha Y HORA real de creación (created_at), no por la fecha del
      // documento (que es solo el día y puede repetirse/empatar entre varios
      // registros del mismo día, dejando el más nuevo mezclado entre los viejos).
      .orderBy('f.created_at', 'DESC')
      .skip((+page - 1) * +limit)
      .take(+limit);

    if (q)      qb.andWhere('(f.invoice_number LIKE :q OR eps.nombre LIKE :q)', { q: `%${q}%` });
    if (tipo)   qb.andWhere('f.tipo = :tipo', { tipo });
    if (status) qb.andWhere('f.status = :status', { status });
    // 'Facturas de Evento' (equipo contable) solo ve las que NO vienen del modulo Facturas Clientes.
    // 'Facturas Clientes' filtra explicitamente por origen_modulo=clientes.
    if (origen_modulo === 'clientes') qb.andWhere("f.origen_modulo = 'clientes'");
    else if (origen_modulo === 'evento') qb.andWhere("(f.origen_modulo = 'evento' OR f.origen_modulo IS NULL)");

    const [items, total] = await qb.getManyAndCount();
    res.json({ items, total, page: +page, limit: +limit });
  } catch { res.status(500).json({ error: 'Error listando facturas salud' }); }
});

// ── GET /api/salud/facturas/buscar-referencia?numero=&cufe=
// Entrega 52: permite ubicar una factura de salud nuestra por numero+CUFE para
// crear notas credito/debito de salud independientes (sin partir del detalle).
router.get('/buscar-referencia', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const numero = String(req.query.numero || '').trim();
    const cufe   = String(req.query.cufe   || '').trim();
    if (!numero || !cufe) { res.status(400).json({ error: 'Indica el numero de factura y el CUFE' }); return; }
    const item = await repo().createQueryBuilder('f')
      .leftJoinAndSelect('f.eps', 'eps')
      .where('f.company_id = :cid AND f.invoice_number = :numero AND f.cufe = :cufe', {
        cid: req.user!.companyId, numero, cufe,
      })
      .getOne();
    if (!item) { res.status(404).json({ error: 'No se encontro ninguna factura de salud nuestra con ese numero y CUFE' }); return; }
    res.json(item);
  } catch {
    res.status(500).json({ error: 'Error buscando la factura' });
  }
});

// ── GET /api/salud/facturas/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({
      where: { id: req.params.id, company_id: req.user!.companyId },
      relations: ['eps', 'contrato', 'contrato.centros_costo', 'contrato.sedes', 'contrato.sedes.municipio'],
    });
    if (!item) { res.status(404).json({ error: 'Factura no encontrada' }); return; }

    // Auto-revert facturas atascadas en "enviando" (backend crasheó antes de terminar)
    if (item.status === 'enviando') {
      const updatedAt   = new Date(item.updated_at as unknown as string);
      const minutesAgo  = (Date.now() - updatedAt.getTime()) / 60_000;
      if (minutesAgo > 10) {
        item.status = 'rechazada';
        item.dian_status_description = 'Envío interrumpido — reintente';
        try { await repo().save(item); } catch { /* non-blocking */ }
      }
    }

    // Parsear pacientes_json para devolverlo como array
    const result: Record<string, unknown> = { ...item };
    if (item.pacientes_json) {
      try { result['pacientes'] = JSON.parse(item.pacientes_json); } catch { result['pacientes'] = []; }
    }
    res.json(result);
  } catch { res.status(500).json({ error: 'Error' }); }
});

// ── POST /api/salud/facturas  (crear borrador)
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid  = req.user!.companyId;
    const body = { ...req.body };

    const errorCcSede = await validarCcSedeContrato(body.contrato_id, body.centro_costo_id, body.punto_pago_sede_id);
    if (errorCcSede) { res.status(400).json({ error: errorCcSede }); return; }

    // Serializar pacientes a JSON si vienen como array
    if (Array.isArray(body.pacientes)) {
      if (body.tipo === 'evento') {
        const errPac = validarPacientesRipsCompletos(body.pacientes);
        if (errPac) { res.status(400).json({ error: errPac }); return; }
      }
      body.pacientes_json = JSON.stringify(body.pacientes);
      delete body.pacientes;
    }

    const item = repo().create({ ...body, company_id: cid, status: 'borrador', created_by_user_id: req.user!.id, created_by_name: req.user!.name });
    const saved = await repo().save(item) as unknown as FacturaSalud;
    await registrarAuditoria({ req, accion: AUDITORIA_ACCION.CREAR, entidad: AUDITORIA_ENTIDAD.FACTURA_SALUD, entidadId: saved.id, datosNuevos: { invoice_number: saved.invoice_number, total: saved.total } });
    res.status(201).json(saved);
  } catch { res.status(500).json({ error: 'Error creando factura salud' }); }
});

// ── PUT /api/salud/facturas/:id
// Hallazgo #52: antes se podía editar (incluido el campo status) una factura ya
// aprobada o anulada, sin ningún guardia de máquina de estados.
router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!item) { res.status(404).json({ error: 'Factura no encontrada' }); return; }
    if (['aprobada', 'anulada'].includes(item.status)) {
      res.status(400).json({ error: `No se puede editar una factura en estado "${item.status}"` });
      return;
    }

    const body = { ...req.body };
    // El estado de la factura solo debe cambiar a través de los endpoints
    // dedicados (/enviar, anulación, etc.), nunca por un PUT genérico.
    delete body.status;
    const errorCcSede = await validarCcSedeContrato(
      body.contrato_id ?? item.contrato_id,
      body.centro_costo_id ?? item.centro_costo_id,
      body.punto_pago_sede_id ?? item.punto_pago_sede_id,
    );
    if (errorCcSede) { res.status(400).json({ error: errorCcSede }); return; }
    if (Array.isArray(body.pacientes)) {
      body.pacientes_json = JSON.stringify(body.pacientes);
      delete body.pacientes;
    }

    repo().merge(item, body);
    await repo().save(item);
    res.json(item);
  } catch { res.status(500).json({ error: 'Error actualizando factura salud' }); }
});

// ── POST /api/salud/facturas/:id/enviar
router.post('/:id/enviar', async (req: AuthRequest, res: Response): Promise<void> => {
  const cid = req.user!.companyId;
  let item: FacturaSalud | null = null;

  try {
    // 1. Cargar factura con relaciones
    item = await repo().findOne({
      where: { id: req.params.id, company_id: cid },
      relations: ['eps', 'contrato'],
    });
    if (!item) { res.status(404).json({ error: 'Factura no encontrada' }); return; }
    if (!['borrador', 'rechazada', 'pendiente_cierre'].includes(item.status)) {
      res.status(400).json({ error: `No se puede enviar una factura en estado "${item.status}"` }); return;
    }
    // SAL-015: bloquear la emisión si algún paciente no trae fecha de nacimiento,
    // correo o tipo de usuario — sin ellos el RIPS puede salir incompleto y ser
    // rechazado por SISPRO. Se valida aquí (al enviar) además de en la creación,
    // para cubrir también las facturas "pendiente_cierre" que llegan por cargue.
    if (item.tipo === 'evento') {
      let pacientesActuales: unknown[] = [];
      try { pacientesActuales = JSON.parse(item.pacientes_json || '[]'); } catch { pacientesActuales = []; }
      const errPac = validarPacientesRipsCompletos(pacientesActuales);
      if (errPac) { res.status(400).json({ error: errPac }); return; }
    }
    const errorCcSede = await validarCcSedeContrato(item.contrato_id, item.centro_costo_id, item.punto_pago_sede_id);
    if (errorCcSede) { res.status(400).json({ error: errorCcSede }); return; }

    // SAL-054: contratos PGP facturados desde "Facturas Clientes" — a la EPS ya
    // se le factura aparte, de forma consolidada (una sola factura periódica),
    // así que desde este módulo NO se debe generar ni emitir una factura a la
    // EPS por cada encuentro. Lo único que se emite aquí es el copago/cuota
    // moderadora que paga el paciente en el punto de atención. Esto NO aplica
    // al módulo dedicado de facturación PGP a la EPS (tipo === 'pgp'), que sigue
    // igual — solo afecta encuentros con origen_modulo === 'clientes' cuyo
    // contrato es modalidad PGP.
    const esPgpSinFacturaEps = item.origen_modulo === 'clientes' && item.contrato?.modalidad_pago === 'PGP';
    if (esPgpSinFacturaEps && !(Number(item.pago_usuario_monto) > 0)) {
      res.status(400).json({
        error: 'Este contrato es PGP: a la EPS se le factura aparte (consolidado), así que desde acá solo se emite el copago o la cuota moderadora del paciente. Configure un valor de copago/cuota moderadora mayor a $0 antes de enviar.',
      });
      return;
    }

    // 2. Cargar empresa y configuración DIAN
    const settingsRepo = AppDataSource.getRepository(CompanySettings);
    const settings = await settingsRepo.findOne({ where: { company_id: cid } });
    if (!settings) { res.status(400).json({ error: 'Empresa sin configuración DIAN. Configúrela en Ajustes.' }); return; }

    const company = await AppDataSource.getRepository(Company).findOne({ where: { id: cid } });
    if (!company) { res.status(400).json({ error: 'Empresa no encontrada' }); return; }

    // 3. Asignar número de factura con incremento atómico en BD
    //    El UPDATE es síncrono en sql.js y atómico en MariaDB/MySQL, eliminando
    //    la race condition cuando varios usuarios envían facturas simultáneamente.
    const assignedPrefix = item.prefix || settings.health_prefix || 'FVS';
    const needsAutoNumber = !item.number;
    let assignedNumber: number;

    if (needsAutoNumber) {
      // Reservar el número ANTES de cualquier operación async larga.
      // Incremento atómico del consecutivo vía reservarConsecutivo() -- ver
      // src/utils/consecutivo.util.ts (antes usaba UPDATE...RETURNING, que
      // no es compatible con MariaDB para sentencias UPDATE).
      assignedNumber = await reservarConsecutivo(AppDataSource, cid, 'next_health_invoice_number');
    } else {
      assignedNumber = item.number!;
    }

    // 4. Marcar como "enviando" + fijar issue_date = hoy Colombia (regla DIAN FAD09e:
    //    IssueDate debe coincidir con SigningTime; no se puede transmitir con fecha pasada)
    // en-CA locale produce YYYY-MM-DD directo en la zona horaria de Colombia
    const todayColombia = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    item.status = 'enviando';
    item.prefix = assignedPrefix;
    item.number = assignedNumber;
    item.invoice_number = `${assignedPrefix}${assignedNumber}`;
    item.issue_date = todayColombia;   // siempre hoy al transmitir
    // Quién envía es quien firma la factura — sobreescribir el nombre del creador
    item.created_by_name    = req.user!.name;
    item.created_by_user_id = req.user!.id;
    await repo().save(item);

    // 4c. SAL-054: rama especial PGP + Facturas Clientes — no se emite factura a
    //     la EPS. El "documento" transmitido de este registro es directamente el
    //     copago/cuota moderadora del paciente, con el mismo número/prefijo ya
    //     asignado arriba (no hay una factura "principal" separada).
    if (esPgpSinFacturaEps) {
      try {
        const pacientesArrPgp = (() => { try { return JSON.parse(item.pacientes_json || '[]'); } catch { return []; } })();
        const municipioPgp = await lookupMunicipio(pacientesArrPgp[0]?.codMunicipioResidencia || '11001');
        const xmlPayload = buildPagoUsuarioXmlPayload(item, company, settings, assignedPrefix, assignedNumber, municipioPgp);

        // RIPS: se sigue generando igual (evidencia del servicio prestado, aparte
        // de a quién se le facture) — sin numFEVPagoModerador porque acá no hay
        // una factura a la EPS separada que referenciar.
        if (!item.rips_json && !item.rips_json_path) {
          const invoiceNum = `${assignedPrefix}${assignedNumber}`;
          const ripsData = buildEventoRipsJson(item, company, invoiceNum, undefined);
          item.rips_json_path = saveRipsJson(item.company_id, item.id, JSON.stringify(ripsData));
          item.rips_filename  = `RIPS_${invoiceNum}.json`;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const xmlResult = await generateInvoiceXml(xmlPayload) as Record<string, any>;
        if (!xmlResult.success || xmlResult.error) {
          item.status = 'rechazada';
          item.dian_status_description = String(xmlResult.error || 'Error generando XML DIAN (copago PGP)');
          await repo().save(item);
          res.status(400).json({ error: 'Error generando XML', detail: xmlResult.error, trace: xmlResult.traceback });
          return;
        }
        const { xml_base64, cufe, invoice_number } = xmlResult as { xml_base64: string; cufe: string; invoice_number: string };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const signResult = await signXml(xml_base64, { invoice_number, cufe }, settings) as Record<string, any>;
        if (!signResult.success || signResult.error) {
          item.status = 'rechazada';
          item.dian_status_description = 'Error firmando XML: ' + String(signResult.error || '');
          await repo().save(item);
          res.status(400).json({ error: 'Error firmando XML', detail: signResult.error });
          return;
        }
        const { zip_base64, signed_filename: signedFilename, signed_xml_base64 } = signResult as { zip_base64: string; signed_filename: string; signed_xml_base64?: string };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dianResult = await sendToDAIN(zip_base64, signedFilename, settings.environment, settings) as Record<string, any>;

        item.cufe                    = cufe;
        item.xml_base64              = xml_base64;
        item.signed_xml_base64       = signed_xml_base64 || undefined;
        item.dian_status_code        = dianResult.status_code        || undefined;
        item.dian_status_description = dianResult.status_description || dianResult.error_message || undefined;
        item.dian_response_raw       = JSON.stringify(dianResult);

        const dianOk = dianResult.status_code === '00';
        item.status = dianOk ? 'aprobada' : 'rechazada';
        await repo().save(item);

        if (dianOk) {
          try {
            const rcRepo = AppDataSource.getRepository(RegistroCargue);
            const rc = await rcRepo.findOne({ where: { factura_salud_id: item.id } });
            if (rc && rc.status === 'pendiente') { rc.status = 'cerrada'; await rcRepo.save(rc); }
          } catch { /* No bloquea — la factura ya está aprobada */ }
          try { await generarAsientoDesdeFacturaSalud(item, cid); } catch (e) { console.error('[ASIENTO]', e); }
        }

        // PDF (mismo patrón que el pago por usuario normal, paso 12d)
        try {
          const issueDatetime = new Date().toLocaleString('sv-SE', { timeZone: 'America/Bogota' }).replace(' ', 'T') + '-05:00';
          const pdfPayload: Record<string, unknown> = {
            ...xmlPayload,
            cufe,
            environment:          settings.environment,
            signed_filename:      item.invoice_number,
            issue_datetime:       issueDatetime,
            pdf_primary_color:    settings.pdf_primary_color  ?? '#1a56db',
            pdf_secondary_color:  settings.pdf_secondary_color ?? '#374151',
            logo_base64:          settings.logo_path ? (() => { try { return require('fs').readFileSync(resolveUploadPath(settings.logo_path)).toString('base64'); } catch { return undefined; } })() : undefined,
            signed_xml_b64:       signed_xml_base64 || undefined,
          };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pdfResult = await generateInvoicePdf(pdfPayload) as Record<string, any>;
          if (pdfResult.pdf_base64) {
            item.pdf_base64 = pdfResult.pdf_base64 as string;
            await repo().save(item);
          }
        } catch (pdfErr) {
          console.error('[PDF] Error generando PDF copago PGP (Facturas Clientes):', pdfErr);
        }

        res.json({
          ok:             true,
          invoice_number: item.invoice_number,
          cufe,
          status:         item.status,
          dian: { status_code: dianResult.status_code, status_description: dianResult.status_description },
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (item.status === 'enviando') {
          try { item.status = 'rechazada'; item.dian_status_description = 'Error inesperado: ' + msg.slice(0, 200); await repo().save(item); } catch { /* ignore */ }
        }
        res.status(500).json({ error: 'Error enviando factura a DIAN', detail: msg });
      }
      return;
    }

    // 4b. SAL-008 (copago/cuota moderadora): si la factura de evento va a generar
    //     también la factura de pago por usuario (ver paso 12 más abajo), se reserva
    //     su número AHORA — antes de construir el XML/RIPS principal — para poder
    //     referenciarla como numFEVPagoModerador dentro de la factura a la EPS.
    //     La generación real de esa factura sigue ocurriendo en el paso 12 (solo si
    //     la factura principal queda aprobada); aquí solo se reserva el consecutivo.
    let pagoUsuarioInvoiceNumberPreview: string | undefined;
    let pagoUsuarioNumeroReservado: number | undefined;
    if (item.tipo === 'evento' && Number(item.pago_usuario_monto) > 0) {
      pagoUsuarioNumeroReservado = await reservarConsecutivo(AppDataSource, cid, 'next_health_invoice_number');
      pagoUsuarioInvoiceNumberPreview = `${assignedPrefix}${pagoUsuarioNumeroReservado}`;
    }

    // 5. Construir payload XML según tipo de factura
    const nombresServicios = item.tipo === 'evento' ? await lookupNombresServicios(cid) : {};
    const xmlPayload = item.tipo === 'evento'
      ? buildHealthEventoXmlPayload(item, company, settings, assignedNumber, assignedPrefix, pagoUsuarioInvoiceNumberPreview, nombresServicios)
      : buildHealthPgpXmlPayload(item, company, settings, assignedNumber, assignedPrefix);

    // Para Evento: generar y guardar RIPS JSON automáticamente antes de enviar
    // (se guarda en disco, no en la base — ver rips-storage.service.ts)
    if (item.tipo === 'evento' && !item.rips_json && !item.rips_json_path) {
      const invoiceNum = `${assignedPrefix}${assignedNumber}`;
      const ripsData = buildEventoRipsJson(item, company, invoiceNum, pagoUsuarioInvoiceNumberPreview);
      item.rips_json_path = saveRipsJson(item.company_id, item.id, JSON.stringify(ripsData));
      item.rips_filename  = `RIPS_${invoiceNum}.json`;
    }

    // 6. Generar XML
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const xmlResult = await generateInvoiceXml(xmlPayload) as Record<string, any>;
    if (!xmlResult.success || xmlResult.error) {
      item.status = 'rechazada';
      item.dian_status_description = String(xmlResult.error || 'Error generando XML DIAN');
      await repo().save(item);
      res.status(400).json({ error: 'Error generando XML', detail: xmlResult.error, trace: xmlResult.traceback });
      return;
    }

    const { xml_base64, cufe, invoice_number } = xmlResult as { xml_base64: string; cufe: string; invoice_number: string };

    // 7. Firmar XML
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const signResult = await signXml(xml_base64, { invoice_number, cufe }, settings) as Record<string, any>;
    if (!signResult.success || signResult.error) {
      item.status = 'rechazada';
      item.dian_status_description = 'Error firmando XML: ' + String(signResult.error || '');
      await repo().save(item);
      res.status(400).json({ error: 'Error firmando XML', detail: signResult.error });
      return;
    }

    const { zip_base64, signed_filename: signedFilename, signed_xml_base64 } = signResult as { zip_base64: string; signed_filename: string; signed_xml_base64?: string };

    // 8. Enviar a DIAN
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dianResult = await sendToDAIN(zip_base64, signedFilename, settings.environment, settings) as Record<string, any>;

    // 9. Actualizar factura con resultado
    item.cufe                    = cufe;
    item.xml_base64              = xml_base64;
    item.signed_xml_base64       = signed_xml_base64 || undefined;
    item.dian_status_code        = dianResult.status_code        || undefined;
    item.dian_status_description = dianResult.status_description || dianResult.error_message || undefined;
    // Guardar respuesta cruda completa para diagnóstico
    item.dian_response_raw = JSON.stringify(dianResult);

    const dianOk = dianResult.status_code === '00';
    item.status = dianOk ? 'aprobada' : 'rechazada';

    await repo().save(item);

    // 9b. Si aprobada, cerrar el RegistroCargue asociado (sale de "Mis Asignaciones")
    if (dianOk) {
      try {
        const rcRepo = AppDataSource.getRepository(RegistroCargue);
        const rc = await rcRepo.findOne({ where: { factura_salud_id: item.id } });
        if (rc && rc.status === 'pendiente') {
          rc.status = 'cerrada';
          await rcRepo.save(rc);
        }
      } catch { /* No bloquea — la factura ya está aprobada */ }
    }

    // 9c. Si aprobada, generar asiento contable en borrador para el contador
    if (dianOk) {
      try { await generarAsientoDesdeFacturaSalud(item, cid); } catch (e) { console.error('[ASIENTO]', e); }
    }

    // 10. Generar PDF
    try {
      const issueDatetime = new Date().toLocaleString('sv-SE', { timeZone: 'America/Bogota' }).replace(' ', 'T') + '-05:00';
      const pdfPayload: Record<string, unknown> = {
        ...xmlPayload,
        cufe,
        environment:          settings.environment,
        signed_filename:      item.invoice_number,
        issue_datetime:       issueDatetime,
        pdf_primary_color:    settings.pdf_primary_color  ?? '#1a56db',
        pdf_secondary_color:  settings.pdf_secondary_color ?? '#374151',
        logo_base64:          settings.logo_path ? (() => { try { return require('fs').readFileSync(resolveUploadPath(settings.logo_path)).toString('base64'); } catch { return undefined; } })() : undefined,
        signed_xml_b64:       signed_xml_base64 || undefined,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pdfResult = await generateInvoicePdf(pdfPayload) as Record<string, any>;
      if (pdfResult.pdf_base64) {
        item.pdf_base64 = pdfResult.pdf_base64 as string;
        await repo().save(item);
      }
    } catch (pdfErr) {
      // PDF error no bloquea la respuesta — la factura ya está en DIAN
      console.error('[PDF] Error generando PDF salud:', pdfErr);
    }

    // 12. Generar factura de pago por usuario al paciente (Concepto DIAN 012008/2026)
    //     Solo si: factura aprobada + evento + pago_usuario_monto > 0 + tiene pacientes
    console.log(`[PagoUsuario-Check] dianOk=${dianOk} tipo=${item.tipo} pago_usuario_monto=${item.pago_usuario_monto} (${typeof item.pago_usuario_monto}) Number=${Number(item.pago_usuario_monto)}`);
    if (dianOk && item.tipo === 'evento' && Number(item.pago_usuario_monto) > 0) {
      try {
        // El número del pago por usuario ya fue reservado ANTES de construir la
        // factura principal (paso 4b), para poder referenciarlo en el XML/RIPS
        // como numFEVPagoModerador (SAL-008). Si por algún motivo no se reservó
        // ahí (ruta antigua / borde no esperado), se reserva aquí como respaldo.
        let copagoNum = pagoUsuarioNumeroReservado;
        if (!copagoNum) {
          copagoNum = await reservarConsecutivo(AppDataSource, cid, 'next_health_invoice_number');
        }
        const copagoPrefix = assignedPrefix;
        const pacientesArr0 = (() => { try { return JSON.parse(item.pacientes_json || '[]'); } catch { return []; } })();
        const copagoMunicipio = await lookupMunicipio(pacientesArr0[0]?.codMunicipioResidencia || '11001');
        const copagoPayload = buildPagoUsuarioXmlPayload(item, company, settings, copagoPrefix, copagoNum, copagoMunicipio);

        // 12a. Generar XML del pago por usuario
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cXmlResult = await generateInvoiceXml(copagoPayload) as Record<string, any>;
        if (!cXmlResult.success || !cXmlResult.xml_base64) {
          throw new Error('Error generando XML pago usuario: ' + (cXmlResult.error || 'sin detalle'));
        }

        const { xml_base64: cXml, cufe: cCufe, invoice_number: cInvNum } = cXmlResult;

        // 12b. Firmar
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cSignResult = await signXml(cXml, { invoice_number: cInvNum, cufe: cCufe }, settings) as Record<string, any>;
        if (!cSignResult.success || !cSignResult.zip_base64) {
          throw new Error('Error firmando XML pago usuario: ' + (cSignResult.error || 'sin detalle'));
        }

        const { zip_base64: cZip, signed_filename: cFilename, signed_xml_base64: cSignedXml } = cSignResult;

        // 12c. Enviar a DIAN
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cDianResult = await sendToDAIN(cZip, cFilename, settings.environment, settings) as Record<string, any>;

        item.pago_usuario_invoice_number    = cInvNum;
        item.pago_usuario_cufe              = cCufe;
        item.pago_usuario_dian_status       = String(cDianResult.status_code ?? '');
        item.pago_usuario_dian_description  = String(cDianResult.status_description ?? '');
        item.pago_usuario_dian_response_raw = JSON.stringify(cDianResult);

        // 12d. Generar PDF del pago por usuario
        try {
          const issueDatetime = new Date().toLocaleString('sv-SE', { timeZone: 'America/Bogota' }).replace(' ', 'T') + '-05:00';
          const cPdfPayload = {
            ...copagoPayload,
            cufe:                cCufe,
            environment:         settings.environment,
            signed_filename:     cInvNum,
            issue_datetime:      issueDatetime,
            pdf_primary_color:   settings.pdf_primary_color  ?? '#1a56db',
            pdf_secondary_color: settings.pdf_secondary_color ?? '#374151',
            logo_base64:         settings.logo_path ? (() => { try { return require('fs').readFileSync(resolveUploadPath(settings.logo_path)).toString('base64'); } catch { return undefined; } })() : undefined,
            signed_xml_b64:      cSignedXml || undefined,
          };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const cPdfResult = await generateInvoicePdf(cPdfPayload) as Record<string, any>;
          if (cPdfResult.pdf_base64) item.pago_usuario_pdf_base64 = cPdfResult.pdf_base64 as string;
        } catch (cPdfErr) {
          console.error('[PDF-PagoUsuario] Error generando PDF pago usuario:', cPdfErr);
        }

        await repo().save(item);
        console.log(`[PagoUsuario] Factura ${cInvNum} generada. DIAN: ${cDianResult.status_code} – ${cDianResult.status_description}`);
      } catch (pagoUsuarioErr) {
        // Error en pago usuario no revierte la factura principal (ya está aprobada en DIAN)
        console.error('[PagoUsuario] Error generando factura de pago por usuario:', pagoUsuarioErr);
      }
    }

    res.json({
      ok:                           true,
      invoice_number:               item.invoice_number,
      cufe,
      status:                       item.status,
      pago_usuario_invoice_number:  item.pago_usuario_invoice_number || undefined,
      dian: {
        status_code:        dianResult.status_code,
        status_description: dianResult.status_description,
      },
    });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Si el item quedo en "enviando" y fallo, revertir a rechazada
    if (item && item.status === 'enviando') {
      try {
        item.status = 'rechazada';
        item.dian_status_description = 'Error inesperado: ' + msg.slice(0, 200);
        await repo().save(item);
      } catch { /* ignore */ }
    }
    res.status(500).json({ error: 'Error enviando factura a DIAN', detail: msg });
  }
});

// ── GET /api/salud/facturas/:id/pdf
router.get('/:id/pdf', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({
      where: { id: req.params.id, company_id: req.user!.companyId },
      relations: ['eps', 'contrato'],
    });
    if (!item) { res.status(404).json({ error: 'Factura no encontrada' }); return; }

    // Si ya tiene PDF cacheado, devolverlo directamente
    if (item.pdf_base64) {
      const buffer = Buffer.from(item.pdf_base64, 'base64');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${item.invoice_number || item.id}.pdf"`);
      res.send(buffer);
      return;
    }

    // Sin PDF guardado: regenerar desde los datos de la factura
    if (!item.xml_base64 || !item.cufe) {
      res.status(404).json({ error: 'PDF no disponible: factura sin XML o CUFE' }); return;
    }

    const settingsRepo = AppDataSource.getRepository(CompanySettings);
    const settings = await settingsRepo.findOne({ where: { company_id: req.user!.companyId } });
    const company  = await AppDataSource.getRepository(Company).findOne({ where: { id: req.user!.companyId } });
    if (!settings || !company) { res.status(400).json({ error: 'Configuración no encontrada' }); return; }

    // SAL-054: si es un registro PGP de "Facturas Clientes" (sin factura a la
    // EPS), el documento guardado es el copago/cuota moderadora del paciente,
    // no la factura de evento/PGP normal — hay que reconstruirlo con el mismo
    // builder que se usó al enviarlo.
    const esPgpSinFacturaEpsPdf = item.origen_modulo === 'clientes' && item.contrato?.modalidad_pago === 'PGP';
    const nombresServiciosPdf = item.tipo === 'evento' && !esPgpSinFacturaEpsPdf ? await lookupNombresServicios(req.user!.companyId) : {};
    let xmlPayload: Record<string, unknown>;
    if (esPgpSinFacturaEpsPdf) {
      const pacientesArrPdf = (() => { try { return JSON.parse(item.pacientes_json || '[]'); } catch { return []; } })();
      const municipioPdf = await lookupMunicipio(pacientesArrPdf[0]?.codMunicipioResidencia || '11001');
      xmlPayload = buildPagoUsuarioXmlPayload(item, company, settings, item.prefix!, item.number!, municipioPdf);
    } else {
      xmlPayload = item.tipo === 'evento'
        ? buildHealthEventoXmlPayload(item, company, settings, item.number!, item.prefix!, item.pago_usuario_invoice_number || undefined, nombresServiciosPdf)
        : buildHealthPgpXmlPayload(item, company, settings, item.number!, item.prefix!);
    }
    const issueDatetime = `${item.issue_date}T00:00:00-05:00`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfResult = await generateInvoicePdf({
      ...xmlPayload,
      cufe:                item.cufe,
      environment:         settings.environment,
      signed_filename:     item.invoice_number,
      issue_datetime:      issueDatetime,
      pdf_primary_color:   settings.pdf_primary_color  ?? '#1a56db',
      pdf_secondary_color: settings.pdf_secondary_color ?? '#374151',
      logo_base64:         settings.logo_path ? (() => { try { return require('fs').readFileSync(resolveUploadPath(settings.logo_path)).toString('base64'); } catch { return undefined; } })() : undefined,
      signed_xml_b64:      item.signed_xml_base64 || undefined,
    }) as Record<string, any>;

    if (!pdfResult.pdf_base64) {
      res.status(500).json({ error: 'Error generando PDF', detail: pdfResult.error }); return;
    }

    // Guardar para futuras peticiones
    item.pdf_base64 = pdfResult.pdf_base64 as string;
    await repo().save(item);

    const buffer = Buffer.from(item.pdf_base64, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${item.invoice_number || item.id}.pdf"`);
    res.send(buffer);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: 'Error obteniendo PDF', detail: msg });
  }
});

// ── GET /api/salud/facturas/:id/tirilla-pdf
// Tirilla POS (recibo termico 80mm) — modulo "Facturas Clientes".
const TIRILLA_PAYMENT_METHOD_LABELS: Record<string, string> = {
  '10': 'Efectivo', '20': 'Cheque', '42': 'Transferencia Bancaria',
  '47': 'Débito Automático', '48': 'Tarjeta de Crédito', '49': 'Tarjeta Débito',
  '71': 'Bonos', '72': 'Vales', 'ZZZ': 'Otro',
};

router.get('/:id/tirilla-pdf', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({
      where: { id: req.params.id, company_id: req.user!.companyId },
      relations: ['eps', 'contrato', 'punto_pago_sede'],
    });
    if (!item) { res.status(404).json({ error: 'Factura no encontrada' }); return; }

    const regenerate = req.query.force === '1';
    if (item.tirilla_pdf_base64 && !regenerate) {
      const buffer = Buffer.from(item.tirilla_pdf_base64, 'base64');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="tirilla-${item.invoice_number || item.id}.pdf"`);
      res.send(buffer);
      return;
    }

    const settings = await AppDataSource.getRepository(CompanySettings).findOne({ where: { company_id: req.user!.companyId } });
    const company  = await AppDataSource.getRepository(Company).findOne({ where: { id: req.user!.companyId } });
    if (!settings || !company) { res.status(400).json({ error: 'Configuración no encontrada' }); return; }

    const pacientes = (() => { try { return JSON.parse(item.pacientes_json || '[]'); } catch { return []; } })();
    const primerPaciente = pacientes[0] || {};
    const pacienteNombre = primerPaciente.nombre ||
      [primerPaciente.primerNombre, primerPaciente.segundoNombre, primerPaciente.primerApellido, primerPaciente.segundoApellido]
        .filter(Boolean).join(' ') || undefined;
    const pacienteDoc = primerPaciente.numDocumentoIdentificacion
      ? `${primerPaciente.tipoDocumentoIdentificacion || 'CC'} ${primerPaciente.numDocumentoIdentificacion}`
      : undefined;

    const items: Array<{ descripcion: string; cantidad: number; valor: number }> = [];
    for (const p of pacientes) {
      const svcs = p.servicios || {};
      for (const c of (svcs.consultas || [])) items.push({ descripcion: `Consulta CUPS ${c.codConsulta || ''}`, cantidad: 1, valor: Number(c.vrServicio) || 0 });
      for (const pr of (svcs.procedimientos || [])) items.push({ descripcion: `Procedimiento CUPS ${pr.codProcedimiento || ''}`, cantidad: 1, valor: Number(pr.vrServicio) || 0 });
      for (const m of (svcs.medicamentos || [])) items.push({ descripcion: m.nomTecnologiaSalud || m.codTecnologiaSalud || 'Medicamento', cantidad: Number(m.cantidadMedicamento) || 1, valor: Number(m.vrUnitMedicamento) || 0 });
      for (const o of (svcs.otrosServicios || [])) items.push({ descripcion: o.nomTecnologiaSalud || o.codTecnologiaSalud || 'Otro servicio', cantidad: Number(o.cantidadOS) || 1, valor: Number(o.vrUnitOS) || 0 });
    }
    if (items.length === 0) items.push({ descripcion: 'Servicios de salud', cantidad: 1, valor: Number(item.subtotal) || 0 });

    // La tirilla es el recibo del pago que hace el PACIENTE en caja. Cuando el
    // contrato tiene "pago por usuario" configurado, ese cobro corresponde a
    // una factura DIAN aparte (la de pago por usuario — cuota moderadora o
    // copago), no a la factura que se le cobra a la EPS. Por eso el CUFE, el
    // prefijo/número y el total impresos en la tirilla deben ser los de esa
    // factura de pago por usuario, no los de la factura EPS.
    // SAL-054: en PGP + Facturas Clientes no hay una factura de pago-usuario
    // "aparte" (item.pago_usuario_invoice_number queda vacío) porque la única
    // factura del registro YA ES el copago/cuota moderadora — hay que tratarla
    // igual que el caso normal de cobro al usuario para que la tirilla muestre
    // el valor y el CUFE correctos (no el total ni el CUFE "de la EPS").
    const esPgpSinFacturaEpsTirilla = item.origen_modulo === 'clientes' && item.contrato?.modalidad_pago === 'PGP';
    const tieneCobroUsuario = !!item.pago_usuario_invoice_number || esPgpSinFacturaEpsTirilla;
    const [tirillaPrefix, tirillaNumber] = item.pago_usuario_invoice_number
      ? (() => {
          const m = item.pago_usuario_invoice_number!.match(/^([A-Za-z]*)(\d+)$/);
          return m ? [m[1], m[2]] : [item.prefix || '', String(item.number ?? '')];
        })()
      : [item.prefix || '', String(item.number ?? '')];

    // El paciente no debe ver cuánto factura cada servicio a la EPS. Cuando el
    // contrato tiene "pago por usuario", el único valor que sí debe verse es el
    // cargo genérico (copago/cuota moderadora) — la misma descripción que ya se
    // usa en la factura de pago por usuario (ver buildPagoUsuarioXmlPayload en
    // dian-payload.utils.ts), para que ambos documentos digan lo mismo.
    let cargoUsuario: { descripcion: string; valor: number } | null = null;
    if (tieneCobroUsuario) {
      // Si no hay una factura EPS separada que referenciar (caso PGP), se omite
      // el "Ref. factura X" — sería la misma factura referenciándose a sí misma.
      const refFactura = esPgpSinFacturaEpsTirilla ? '' : ` – Ref. factura ${item.invoice_number || ''}`;
      const descripcion = item.tipo_cobro_usuario === 'copago'
        ? `Copago (${item.pago_usuario_porcentaje ?? ''}%)${refFactura}`
        : `Cuota moderadora${refFactura}`;
      cargoUsuario = { descripcion, valor: Number(item.pago_usuario_monto ?? item.total) || 0 };
    }

    const tirillaPayload = {
      company_name:    company.trade_name || company.name || '',
      company_nit:     `${company.nit || ''}${company.nit_dv ? '-' + company.nit_dv : ''}`,
      company_address: company.address || '',
      company_city:    company.city_name || '',
      sede_nombre:      item.punto_pago_sede?.nombre || '',
      resolution_number: settings.health_resolution_number ?? settings.resolution_number ?? '',
      prefix:           tirillaPrefix,
      number:           tirillaNumber,
      issue_datetime:   `${item.issue_date} ${new Date(item.updated_at as unknown as string).toTimeString().slice(0, 5)}`,
      cajero_nombre:    item.created_by_name || '',
      paciente_nombre:  pacienteNombre,
      paciente_doc:     pacienteDoc,
      contrato_nombre:  item.eps?.nombre || item.contrato?.numero || '',
      items,
      // Solo se envía subtotal (suma de valores EPS) cuando NO hay cobro al
      // usuario aparte — si lo hay, ese subtotal expondría precios negociados
      // con la EPS que el paciente no debe ver, y ya no aplica como "lo que se
      // le cobró", así que se omite.
      subtotal:         tieneCobroUsuario ? undefined : item.subtotal,
      total:            tieneCobroUsuario ? (item.pago_usuario_monto ?? item.total) : item.total,
      cargo_usuario:    cargoUsuario,
      payment_method_label: TIRILLA_PAYMENT_METHOD_LABELS[String(item.payment_method_id || '')] || '',
      valor_recibido:   item.valor_recibido,
      valor_cambio:     item.valor_cambio,
      cufe:             item.pago_usuario_cufe || item.cufe || '',
      environment:      settings.environment,
    };

    const pdfResult = await generateTirillaPdf(tirillaPayload) as Record<string, any>;
    if (!pdfResult.pdf_base64) {
      res.status(500).json({ error: 'Error generando tirilla', detail: pdfResult.error }); return;
    }

    item.tirilla_pdf_base64 = pdfResult.pdf_base64 as string;
    await repo().save(item);

    const buffer = Buffer.from(item.tirilla_pdf_base64, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="tirilla-${item.invoice_number || item.id}.pdf"`);
    res.send(buffer);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: 'Error obteniendo tirilla', detail: msg });
  }
});

// ── GET /api/salud/facturas/:id/pago-usuario-pdf
router.get('/:id/pago-usuario-pdf', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({
      where: { id: req.params.id, company_id: req.user!.companyId },
      relations: ['eps', 'contrato'],
    });
    if (!item) { res.status(404).json({ error: 'Factura no encontrada' }); return; }
    if (!item.pago_usuario_invoice_number) {
      res.status(404).json({ error: 'Esta factura no tiene pago por usuario registrado' }); return;
    }

    // Si ya tiene PDF de pago usuario cacheado, devolverlo directamente
    if (item.pago_usuario_pdf_base64) {
      const buffer = Buffer.from(item.pago_usuario_pdf_base64, 'base64');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="pago-usuario-${item.pago_usuario_invoice_number}.pdf"`);
      res.send(buffer);
      return;
    }

    // Sin PDF guardado: regenerar desde los datos del pago usuario
    if (!item.pago_usuario_cufe) {
      res.status(404).json({ error: 'PDF de pago por usuario no disponible (sin CUFE)' }); return;
    }

    const settings = await AppDataSource.getRepository(CompanySettings).findOne({ where: { company_id: req.user!.companyId } });
    const company  = await AppDataSource.getRepository(Company).findOne({ where: { id: req.user!.companyId } });
    if (!settings || !company) { res.status(400).json({ error: 'Configuración no encontrada' }); return; }

    const [cPrefix, cNumber] = (() => {
      const inv = item.pago_usuario_invoice_number!;
      const m = inv.match(/^([A-Za-z]*)(\d+)$/);
      return m ? [m[1], parseInt(m[2], 10)] : [item.prefix || 'FVS', 1];
    })();
    const _pacs0 = (() => { try { return JSON.parse(item.pacientes_json || '[]'); } catch { return []; } })();
    const _mun0 = await lookupMunicipio(_pacs0[0]?.codMunicipioResidencia || '11001');
    const pagoUsuarioPayload = buildPagoUsuarioXmlPayload(item, company, settings, cPrefix, cNumber, _mun0);
    const issueDatetime = `${item.issue_date}T00:00:00-05:00`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfResult = await generateInvoicePdf({
      ...pagoUsuarioPayload,
      cufe:                item.pago_usuario_cufe,
      environment:         settings.environment,
      signed_filename:     item.pago_usuario_invoice_number,
      issue_datetime:      issueDatetime,
      pdf_primary_color:   settings.pdf_primary_color  ?? '#1a56db',
      pdf_secondary_color: settings.pdf_secondary_color ?? '#374151',
      logo_base64:         settings.logo_path ? (() => { try { return require('fs').readFileSync(resolveUploadPath(settings.logo_path)).toString('base64'); } catch { return undefined; } })() : undefined,
    }) as Record<string, any>;

    if (!pdfResult.pdf_base64) {
      res.status(500).json({ error: 'Error regenerando PDF de pago por usuario', detail: pdfResult.error }); return;
    }

    item.pago_usuario_pdf_base64 = pdfResult.pdf_base64 as string;
    await repo().save(item);

    const buffer = Buffer.from(item.pago_usuario_pdf_base64, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="pago-usuario-${item.pago_usuario_invoice_number}.pdf"`);
    res.send(buffer);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: 'Error obteniendo PDF de pago por usuario', detail: msg });
  }
});

// ── POST /api/salud/facturas/:id/resend-pago-usuario
router.post('/:id/resend-pago-usuario', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid  = req.user!.companyId;
    const item = await repo().findOne({
      where: { id: req.params.id, company_id: cid },
      relations: ['eps', 'contrato'],
    });
    if (!item) { res.status(404).json({ error: 'Factura no encontrada' }); return; }
    if (!item.pago_usuario_invoice_number) {
      res.status(400).json({ error: 'Esta factura no tiene pago por usuario registrado' }); return;
    }
    if (item.pago_usuario_dian_status === '00') {
      res.status(400).json({ error: 'El pago por usuario ya está aprobado por la DIAN' }); return;
    }

    const settingsRepo = AppDataSource.getRepository(CompanySettings);
    const companyRepo  = AppDataSource.getRepository(Company);
    const settings     = await settingsRepo.findOne({ where: { company_id: cid } });
    const company      = await companyRepo.findOne({ where: { id: cid } });
    if (!settings || !company) { res.status(400).json({ error: 'Configuración no encontrada' }); return; }

    // Reconstruir el número y prefijo desde el invoice_number almacenado
    const [cPrefix, cNumber] = (() => {
      const inv = item.pago_usuario_invoice_number!;
      const m = inv.match(/^([A-Za-z]*)(\d+)$/);
      return m ? [m[1], parseInt(m[2], 10)] : [item.prefix || 'FVS', 1];
    })();
    const _pacs1 = (() => { try { return JSON.parse(item.pacientes_json || '[]'); } catch { return []; } })();
    const _mun1 = await lookupMunicipio(_pacs1[0]?.codMunicipioResidencia || '11001');
    const pagoUsuarioPayload = buildPagoUsuarioXmlPayload(item, company, settings, cPrefix, cNumber, _mun1);

    // Regenerar XML → firmar → enviar a DIAN
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cXmlResult = await generateInvoiceXml(pagoUsuarioPayload) as Record<string, any>;
    if (!cXmlResult.success || !cXmlResult.xml_base64) {
      res.status(500).json({ error: 'Error generando XML pago usuario', detail: cXmlResult.error }); return;
    }
    const { xml_base64: cXml, cufe: cCufe, invoice_number: cInvNum } = cXmlResult;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cSignResult = await signXml(cXml, { invoice_number: cInvNum, cufe: cCufe }, settings) as Record<string, any>;
    if (!cSignResult.success || !cSignResult.zip_base64) {
      res.status(500).json({ error: 'Error firmando XML pago usuario', detail: cSignResult.error }); return;
    }
    const { zip_base64: cZip, signed_filename: cFilename, signed_xml_base64: cSignedXml } = cSignResult;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cDianResult = await sendToDAIN(cZip, cFilename, settings.environment, settings) as Record<string, any>;

    // Guardar debug del response completo de la DIAN para diagnóstico
    try {
      const fs = require('fs'); const path = require('path');
      const debugDir = path.join(__dirname, '../../../_debug');
      if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
      fs.writeFileSync(
        path.join(debugDir, `pago-usuario-${item.pago_usuario_invoice_number}-${Date.now()}.json`),
        JSON.stringify(cDianResult, null, 2),
      );
    } catch { /* no bloquea */ }

    item.pago_usuario_cufe                 = cCufe;
    item.pago_usuario_dian_status          = String(cDianResult.status_code ?? '');
    item.pago_usuario_dian_description     = String(cDianResult.status_description ?? '');
    item.pago_usuario_dian_response_raw    = JSON.stringify(cDianResult);

    // Regenerar PDF si fue aprobado
    if (cDianResult.status_code === '00') {
      try {
        const issueDatetime = new Date().toLocaleString('sv-SE', { timeZone: 'America/Bogota' }).replace(' ', 'T') + '-05:00';
        const cPdfPayload = {
          ...pagoUsuarioPayload,
          cufe: cCufe, environment: settings.environment, signed_filename: cInvNum,
          issue_datetime: issueDatetime,
          pdf_primary_color: settings.pdf_primary_color ?? '#1a56db',
          pdf_secondary_color: settings.pdf_secondary_color ?? '#374151',
          logo_base64: settings.logo_path ? (() => { try { return require('fs').readFileSync(resolveUploadPath(settings.logo_path)).toString('base64'); } catch { return undefined; } })() : undefined,
          signed_xml_b64: cSignedXml || undefined,
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cPdfResult = await generateInvoicePdf(cPdfPayload) as Record<string, any>;
        if (cPdfResult.pdf_base64) item.pago_usuario_pdf_base64 = cPdfResult.pdf_base64 as string;
      } catch { /* PDF no bloquea */ }
    }

    await repo().save(item);

    res.json({
      ok: true,
      pago_usuario_invoice_number:  item.pago_usuario_invoice_number,
      pago_usuario_dian_status:     item.pago_usuario_dian_status,
      pago_usuario_dian_description: item.pago_usuario_dian_description,
      pago_usuario_dian_errors:     cDianResult.errors ?? [],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: 'Error reenviando pago por usuario', detail: msg });
  }
});

// ── GET /api/salud/facturas/:id/pago-usuario-xml
router.get('/:id/pago-usuario-xml', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid  = req.user!.companyId;
    const item = await repo().findOne({
      where: { id: req.params.id, company_id: cid },
      relations: ['eps', 'contrato'],
    });
    if (!item) { res.status(404).json({ error: 'Factura no encontrada' }); return; }
    if (!item.pago_usuario_invoice_number) {
      res.status(404).json({ error: 'Esta factura no tiene pago por usuario registrado' }); return;
    }

    const settingsRepo = AppDataSource.getRepository(CompanySettings);
    const companyRepo  = AppDataSource.getRepository(Company);
    const settings     = await settingsRepo.findOne({ where: { company_id: cid } });
    const company      = await companyRepo.findOne({ where: { id: cid } });
    if (!settings || !company) { res.status(400).json({ error: 'Configuración no encontrada' }); return; }

    const [cPrefix, cNumber] = (() => {
      const inv = item.pago_usuario_invoice_number!;
      const m = inv.match(/^([A-Za-z]*)(\d+)$/);
      return m ? [m[1], parseInt(m[2], 10)] : [item.prefix || 'FVS', 1];
    })();
    const _pacs2 = (() => { try { return JSON.parse(item.pacientes_json || '[]'); } catch { return []; } })();
    const _mun2 = await lookupMunicipio(_pacs2[0]?.codMunicipioResidencia || '11001');
    const pagoUsuarioPayload = buildPagoUsuarioXmlPayload(item, company, settings, cPrefix, cNumber, _mun2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cXmlResult = await generateInvoiceXml(pagoUsuarioPayload) as Record<string, any>;
    if (!cXmlResult.success || !cXmlResult.xml_base64) {
      res.status(500).json({ error: 'Error generando XML', detail: cXmlResult.error }); return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cSignResult = await signXml(cXmlResult.xml_base64, { invoice_number: cXmlResult.invoice_number, cufe: cXmlResult.cufe }, settings) as Record<string, any>;
    const xmlToSend   = cSignResult.success ? cSignResult.signed_xml_base64 : cXmlResult.xml_base64;

    const buffer = Buffer.from(xmlToSend, 'base64');
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="pago-usuario-${item.pago_usuario_invoice_number}.xml"`);
    res.send(buffer);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: 'Error generando XML pago por usuario', detail: msg });
  }
});

// ── POST /api/salud/facturas/:id/rips  (cargar Excel RIPS → JSON)
router.post('/:id/rips', upload.single('file'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!item) { res.status(404).json({ error: 'Factura no encontrada' }); return; }
    // Hallazgo #51: el RIPS no debe poder reemplazarse una vez la factura ya fue
    // aprobada por la DIAN — desincroniza lo transmitido de lo guardado como "RIPS
    // actual" y rompe la trazabilidad frente a un requerimiento de la EPS.
    if (item.status === 'aprobada') {
      res.status(400).json({ error: 'No se puede reemplazar el RIPS de una factura ya aprobada por la DIAN' });
      return;
    }
    if (!req.file) { res.status(400).json({ error: 'Archivo Excel requerido' }); return; }

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });

    // ── Hoja Factura: validar numFactura ─────────────────────────────────
    const wsFactura = wb.Sheets['Factura'];
    if (!wsFactura) { res.status(400).json({ error: 'El Excel no tiene hoja "Factura"' }); return; }
    const facturaRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wsFactura, { defval: '' });
    if (!facturaRows.length) { res.status(400).json({ error: 'La hoja "Factura" está vacía' }); return; }

    const numFacturaExcel = String(facturaRows[0]['numFactura'] || '').trim();
    const numFacturaDB    = (item.invoice_number || '').trim();

    if (!numFacturaExcel) {
      res.status(400).json({ error: 'La hoja "Factura" no tiene valor en numFactura' }); return;
    }
    if (numFacturaExcel !== numFacturaDB) {
      res.status(400).json({
        error: `El número de factura del Excel ("${numFacturaExcel}") no coincide con esta factura ("${numFacturaDB}"). Corrija el Excel antes de cargar.`,
      }); return;
    }

    // ── Parsear hojas de servicios ────────────────────────────────────────
    function sheet<T>(name: string): T[] {
      const ws = wb.Sheets[name];
      if (!ws) return [];
      return XLSX.utils.sheet_to_json<T>(ws, { defval: '' });
    }

    const usuarios     = sheet<Record<string, unknown>>('Usuarios');
    const consultas    = sheet<Record<string, unknown>>('Consultas');
    const procedimientos = sheet<Record<string, unknown>>('Procedimientos');
    const medicamentos = sheet<Record<string, unknown>>('Medicamentos');
    const otrosServicios = sheet<Record<string, unknown>>('OtrosServicios');

    // ── Agrupar servicios por usuario ─────────────────────────────────────
    function byUsuario<T extends Record<string, unknown>>(rows: T[], key: string): Map<string, T[]> {
      const map = new Map<string, T[]>();
      for (const row of rows) {
        const u = String(row[key] || '').trim();
        if (!map.has(u)) map.set(u, []);
        map.get(u)!.push(row);
      }
      return map;
    }

    const cMap  = byUsuario(consultas, 'Usuario');
    const pMap  = byUsuario(procedimientos, 'Usuario');
    const mMap  = byUsuario(medicamentos, 'Usuario');
    const oMap  = byUsuario(otrosServicios, 'Usuario');

    const usuariosJson = usuarios.map(u => {
      const key = String(u['Usuario'] || '').trim();
      return {
        tipoDocumentoIdentificacion:    u['tipoDocumentoIdentificacion'],
        numDocumentoIdentificacion:     u['numDocumentoIdentificacion'],
        tipoUsuario:                    u['tipoUsuario'],
        fechaNacimiento:                u['fechaNacimiento'],
        codSexo:                        u['codSexo'],
        codPaisResidencia:              u['codPaisResidencia'],
        codMunicipioResidencia:         u['codMunicipioResidencia'],
        codZonaTerritorialResidencia:   u['codZonaTerritorialResidencia'],
        incapacidad:                    u['incapacidad'],
        consecutivo:                    u['consecutivo'],
        codPaisOrigen:                  u['codPaisOrigen'],
        servicios: {
          consultas:       cMap.get(key) || [],
          procedimientos:  pMap.get(key) || [],
          medicamentos:    mMap.get(key) || [],
          otrosServicios:  oMap.get(key) || [],
        },
      };
    });

    const ripsJson = {
      numDocumentoIdObligado: String(facturaRows[0]['numDocumentoIdObligado'] || ''),
      numFactura:             numFacturaExcel,
      usuarios:               usuariosJson,
    };

    // ── Guardar en factura (en disco, no en la base — ver rips-storage.service.ts) ──
    item.rips_json_path = saveRipsJson(item.company_id, item.id, JSON.stringify(ripsJson));
    item.rips_filename  = `RIPS_${numFacturaDB}.json`;
    await repo().save(item);

    res.json({
      ok: true,
      rips_filename: item.rips_filename,
      stats: {
        usuarios:        usuariosJson.length,
        consultas:       consultas.length,
        procedimientos:  procedimientos.length,
        medicamentos:    medicamentos.length,
        otrosServicios:  otrosServicios.length,
      },
    });
  } catch (e: unknown) {
    res.status(500).json({ error: 'Error procesando Excel RIPS', detail: (e as Error).message });
  }
});

// ── GET /api/salud/facturas/:id/rips  (descargar JSON RIPS)
router.get('/:id/rips', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!item) { res.status(404).json({ error: 'Factura no encontrada' }); return; }
    // Preferir el archivo en disco (nuevas facturas); si no hay, usar la
    // columna legacy (facturas de antes de este cambio que ya tenían el
    // RIPS inline en la base y cupieron sin problema).
    const contenido = item.rips_json_path ? readRipsJson(item.rips_json_path) : item.rips_json;
    if (!contenido) { res.status(404).json({ error: 'RIPS no disponible' }); return; }
    const filename = item.rips_filename || `RIPS_${item.invoice_number || item.id}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(contenido);
  } catch { res.status(500).json({ error: 'Error descargando RIPS' }); }
});

// ── POST /api/salud/facturas/:id/anular
router.post('/:id/anular', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!item) { res.status(404).json({ error: 'Factura no encontrada' }); return; }
    if (item.status === 'anulada') { res.status(400).json({ error: 'La factura ya está anulada' }); return; }
    if (item.status === 'borrador') { res.status(400).json({ error: 'Use Eliminar para borradores' }); return; }
    if (item.status === 'enviando') { res.status(400).json({ error: 'No se puede anular mientras se está enviando' }); return; }

    const { motivo } = req.body as { motivo?: string };
    if (!motivo?.trim()) { res.status(400).json({ error: 'Debe indicar el motivo de anulación' }); return; }

    item.status           = 'anulada';
    item.motivo_anulacion = motivo.trim();
    await repo().save(item);

    res.json({ ok: true, status: 'anulada', motivo: item.motivo_anulacion });
  } catch { res.status(500).json({ error: 'Error anulando factura' }); }
});

// ── GET /api/salud/facturas/:id/zip  (descarga ZIP con XML + PDF + RIPS)
router.get('/:id/zip', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!item) { res.status(404).json({ error: 'Factura no encontrada' }); return; }

    const zip      = new AdmZip();
    const baseName = item.invoice_number || item.id;
    let   hasFiles = false;

    if (item.xml_base64) {
      zip.addFile(`${baseName}.xml`, Buffer.from(item.xml_base64, 'base64'));
      hasFiles = true;
    }
    if (item.pdf_base64) {
      zip.addFile(`${baseName}.pdf`, Buffer.from(item.pdf_base64, 'base64'));
      hasFiles = true;
    }
    const ripsContenido = item.rips_json_path ? readRipsJson(item.rips_json_path) : item.rips_json;
    if (ripsContenido) {
      zip.addFile(item.rips_filename || `RIPS_${baseName}.json`, Buffer.from(ripsContenido, 'utf-8'));
      hasFiles = true;
    }

    if (!hasFiles) { res.status(404).json({ error: 'No hay documentos disponibles para descargar' }); return; }

    const buf = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.zip"`);
    res.send(buf);
  } catch (e: unknown) {
    res.status(500).json({ error: 'Error generando ZIP', detail: (e as Error).message });
  }
});

// ── GET /api/salud/facturas/:id/attached-document
// Genera el AttachedDocument UBL requerido por el validador del Ministerio de Salud.
// Contiene la factura firmada + la ApplicationResponse de DIAN (obtenida vía GetStatus).
router.get('/:id/attached-document', async (req: AuthRequest, res: Response): Promise<void> => {
  const cid = req.user!.companyId;
  try {
    // leftJoinAndSelect carga la relación eps (eager no funciona en createQueryBuilder)
    const item = await repo().createQueryBuilder('f')
      .leftJoinAndSelect('f.eps', 'eps')
      .addSelect('f.xml_base64')
      .addSelect('f.signed_xml_base64')
      .where('f.id = :id AND f.company_id = :cid', { id: req.params.id, cid })
      .getOne();
    if (!item) { res.status(404).json({ error: 'Factura no encontrada' }); return; }
    if (item.status !== 'aprobada' && item.status !== 'anulada') {
      res.status(400).json({ error: 'Solo se puede generar el AttachedDocument para facturas aprobadas por la DIAN' }); return;
    }
    if (!item.cufe) { res.status(400).json({ error: 'La factura no tiene CUFE' }); return; }

    const settings = await AppDataSource.getRepository(CompanySettings).findOne({ where: { company_id: cid } });
    if (!settings) { res.status(400).json({ error: 'Empresa sin configuración' }); return; }
    const company  = await AppDataSource.getRepository(Company).findOne({ where: { id: cid } });
    if (!company)  { res.status(400).json({ error: 'Empresa no encontrada' }); return; }

    // 1. Obtener ApplicationResponse XML de DIAN via GetStatus
    let applicationResponseXml = '';
    try {
      const statusResult = await getStatusDian(item.cufe, settings.environment || '2', settings) as Record<string, unknown>;
      const arBase64 = statusResult.xml_base64_bytes as string | undefined;
      if (arBase64) {
        applicationResponseXml = Buffer.from(arBase64, 'base64').toString('utf-8');
      }
    } catch {
      // Si GetStatus falla continuamos sin ApplicationResponse
    }

    // 2. Extraer IssueDate, IssueTime y ResponseCode del ApplicationResponse
    const arDateMatch = applicationResponseXml.match(/<(?:\w+:)?IssueDate[^>]*>([^<]+)<\/(?:\w+:)?IssueDate>/);
    const arTimeMatch = applicationResponseXml.match(/<(?:\w+:)?IssueTime[^>]*>([^<]+)<\/(?:\w+:)?IssueTime>/);
    const arCodeMatch = applicationResponseXml.match(/<(?:\w+:)?ResponseCode[^>]*>([^<]+)<\/(?:\w+:)?ResponseCode>/);
    const arDate = arDateMatch ? arDateMatch[1].trim() : (item.issue_date || new Date().toISOString().slice(0, 10));
    const arTime = arTimeMatch ? arTimeMatch[1].trim() : '00:00:00-05:00';
    const arCode = arCodeMatch ? arCodeMatch[1].trim() : '02';

    // 3. XML firmado de la factura
    const signedXmlBase64 = item.signed_xml_base64 || item.xml_base64 || '';
    const invoiceXml = signedXmlBase64 ? Buffer.from(signedXmlBase64, 'base64').toString('utf-8') : '';

    // 4. Variables del documento
    const issueDate  = item.issue_date || new Date().toISOString().slice(0, 10);
    const issueTime  = new Date().toLocaleTimeString('en-CA', { hour12: false, timeZone: 'America/Bogota' }) + '-05:00';
    const invoiceNum = item.invoice_number || '';
    const issuerNit  = company.nit || '';
    const issuerName = company.name || '';
    const issuerDv   = company.nit_dv || calcDV(company.nit || '');
    const issuerTaxLevel = (company as any).tax_level_code || 'R-99-PN';
    const epsNit     = item.eps?.nit    || '';
    const epsName    = item.eps?.nombre || '';

    // 5. ParentDocumentLineReference (ApplicationResponse) — va DESPUÉS de Attachment
    const parDocLineRef = applicationResponseXml ? `
  <cac:ParentDocumentLineReference>
    <cbc:LineID>1</cbc:LineID>
    <cac:DocumentReference>
      <cbc:ID>${invoiceNum}</cbc:ID>
      <cbc:UUID schemeName="CUFE-SHA384">${item.cufe}</cbc:UUID>
      <cbc:IssueDate>${arDate}</cbc:IssueDate>
      <cbc:DocumentType>ApplicationResponse</cbc:DocumentType>
      <cac:Attachment>
        <cac:ExternalReference>
          <cbc:MimeCode>text/xml</cbc:MimeCode>
          <cbc:EncodingCode>UTF-8</cbc:EncodingCode>
          <cbc:Description><![CDATA[${applicationResponseXml}]]></cbc:Description>
        </cac:ExternalReference>
      </cac:Attachment>
      <cac:ResultOfVerification>
        <cbc:ValidatorID>Unidad Especial Dirección de Impuestos y Aduanas Nacionales</cbc:ValidatorID>
        <cbc:ValidationResultCode>${arCode}</cbc:ValidationResultCode>
        <cbc:ValidationDate>${arDate}</cbc:ValidationDate>
        <cbc:ValidationTime>${arTime}</cbc:ValidationTime>
      </cac:ResultOfVerification>
    </cac:DocumentReference>
  </cac:ParentDocumentLineReference>` : '';

    // 6. Construir AttachedDocument con orden XSD correcto
    const attachedDoc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<AttachedDocument
  xmlns="urn:oasis:names:specification:ubl:schema:xsd:AttachedDocument-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
  xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"
  xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1"
  xmlns:xades="http://uri.etsi.org/01903/v1.3.2#"
  xmlns:xades141="http://uri.etsi.org/01903/v1.4.1#"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionContent>
        <sts:DianExtensions xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1">
          <sts:InvoiceSource>
            <cbc:IdentificationCode listAgencyID="6" listAgencyName="United Nations Economic Commission for Europe" listSchemeURI="urn:oasis:names:specification:ubl:codelist:gc:CountryIdentificationCode-2.1">CO</cbc:IdentificationCode>
          </sts:InvoiceSource>
          <sts:SoftwareProvider>
            <sts:ProviderID schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)" schemeID="${issuerDv}" schemeName="31">${issuerNit}</sts:ProviderID>
            <sts:SoftwareID schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">${settings.software_id || ''}</sts:SoftwareID>
          </sts:SoftwareProvider>
        </sts:DianExtensions>
      </ext:ExtensionContent>
    </ext:UBLExtension>
    <ext:UBLExtension>
      <ext:ExtensionContent/>
    </ext:UBLExtension>
  </ext:UBLExtensions>
  <cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>Documentos adjuntos</cbc:CustomizationID>
  <cbc:ProfileID>Factura Electrónica de Venta</cbc:ProfileID>
  <cbc:ProfileExecutionID>${settings.environment || '2'}</cbc:ProfileExecutionID>
  <cbc:ID>${invoiceNum}</cbc:ID>
  <cbc:IssueDate>${issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${issueTime}</cbc:IssueTime>
  <cbc:DocumentType>Contenedor de Factura Electrónica</cbc:DocumentType>
  <cbc:ParentDocumentID>${invoiceNum}</cbc:ParentDocumentID>
  <cac:SenderParty>
    <cac:PartyTaxScheme>
      <cbc:RegistrationName>${issuerName}</cbc:RegistrationName>
      <cbc:CompanyID schemeAgencyID="195" schemeID="${issuerDv}" schemeName="31">${issuerNit}</cbc:CompanyID>
      <cbc:TaxLevelCode listName="No aplica">${issuerTaxLevel}</cbc:TaxLevelCode>
      <cac:TaxScheme>
        <cbc:ID>01</cbc:ID>
        <cbc:Name>IVA</cbc:Name>
      </cac:TaxScheme>
    </cac:PartyTaxScheme>
  </cac:SenderParty>
  <cac:ReceiverParty>
    <cac:PartyTaxScheme>
      <cbc:RegistrationName>${epsName}</cbc:RegistrationName>
      <cbc:CompanyID schemeAgencyID="195" schemeID="0" schemeName="31">${epsNit}</cbc:CompanyID>
      <cbc:TaxLevelCode listName="48">O-13</cbc:TaxLevelCode>
      <cac:TaxScheme>
        <cbc:ID>01</cbc:ID>
        <cbc:Name>IVA</cbc:Name>
      </cac:TaxScheme>
    </cac:PartyTaxScheme>
  </cac:ReceiverParty>
  <cac:Attachment>
    <cac:ExternalReference>
      <cbc:MimeCode>text/xml</cbc:MimeCode>
      <cbc:EncodingCode>UTF-8</cbc:EncodingCode>
      <cbc:Description><![CDATA[${invoiceXml}]]></cbc:Description>
    </cac:ExternalReference>
  </cac:Attachment>${parDocLineRef}
</AttachedDocument>`;

    // Firmar el AttachedDocument con XAdES (mismo firmador que las facturas)
    let finalXml = attachedDoc;
    try {
      const adBase64 = Buffer.from(attachedDoc, 'utf-8').toString('base64');
      const signResult = await signXml(adBase64, { invoice_number: invoiceNum }, settings) as Record<string, unknown>;
      if (signResult.success && signResult.signed_xml_base64) {
        finalXml = Buffer.from(signResult.signed_xml_base64 as string, 'base64').toString('utf-8');
      }
    } catch {
      // Si el firmado falla (ej: sin certificado) devolvemos el XML sin firmar
    }

    const buf = Buffer.from(finalXml, 'utf-8');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${invoiceNum}_AttachedDocument.xml"`);
    res.send(buf);
  } catch (e: unknown) {
    res.status(500).json({ error: 'Error generando AttachedDocument', detail: (e as Error).message });
  }
});

// -- DELETE /api/salud/facturas/:id  (solo borradores)
router.delete('/:id', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const repo = AppDataSource.getRepository(FacturaSalud);
    const item = await repo.findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!item) { res.status(404).json({ error: 'Factura no encontrada' }); return; }
    if (item.status !== 'borrador') { res.status(400).json({ error: 'Solo se pueden eliminar borradores' }); return; }
    await repo.remove(item);
    res.json({ ok: true });
  } catch (e: unknown) {
    res.status(500).json({ error: 'Error eliminando factura', detail: (e as Error).message });
  }
});

export default router;
