/**
 * documentos-soporte.routes.ts
 *
 * Endpoints REST para el módulo Documento Soporte (DS).
 * Monta en: /api/compras/documentos-soporte
 *
 * Flujo DIAN — igual que facturas normales (invoices.routes.ts): NO existe un
 * estado intermedio "borrador". POST / genera el XML, firma y envía a la DIAN
 * en la MISMA petición, guardando el documento ya con su estado final:
 *   POST /          → aprobado_dian | rechazado   (una sola llamada)
 *   PUT  /:id        → corregir y reenviar (mismo ciclo completo)
 *   POST /:id/enviar → reenvío rápido reutilizando los datos ya guardados
 *   aprobado_dian → [POST /:id/aceptar] → aceptado
 */

import { Router, Response }              from 'express';
import { AppDataSource }                 from '../../config/database';
import { reservarConsecutivo } from '../../utils/consecutivo.util';
import { DocumentoSoporte, EstadoDocumentoSoporte } from '../../entities/compras/DocumentoSoporte';
import { CompanySettings }               from '../../entities/CompanySettings';
import { Company }                       from '../../entities/Company';
import { Tercero }                       from '../../entities/Tercero';
import { authMiddleware, AuthRequest }   from '../../middleware/auth.middleware';
import { buildDsXmlPayload, buildDsPdfPayload } from '../../utils/ds-payload.utils';
import { getCertCredentials }            from '../../services/dian.service';
import { generarAsientoDesdeDocumentoSoporte } from '../../services/asiento-generator';

// Importaciones del servicio DIAN (mismos helpers que facturas)
import { spawn } from 'child_process';
import * as path from 'path';
import { PYTHON_EXEC } from '../../utils/python-executable.util';

const router = Router();
router.use(authMiddleware);

const PYTHON_DIR  = path.resolve(__dirname, '../../..', 'python');   // backend/python/

// ─── Helper: llamar script Python DS ─────────────────────────────────────────

function callDsCli(operation: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const script = path.join(PYTHON_DIR, 'xml_builder_cli.py');   // usa el builder unificado
    const child  = spawn(PYTHON_EXEC, [script, operation], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let out = '', err = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    child.on('close', (code) => {
      if (code !== 0 && !out) return reject(new Error(err.trim() || `Python salió con código ${code}`));
      try {
        const raw   = out.trim();
        const start = raw.indexOf('{');
        const result = JSON.parse(start >= 0 ? raw.slice(start) : raw) as Record<string, unknown>;
        resolve(result);
      } catch {
        reject(new Error(`Respuesta Python inválida: ${out.slice(0, 200)}`));
      }
    });
    child.on('error', (e) => reject(new Error(`Python no iniciado (${PYTHON_EXEC}): ${e.message}`)));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

// Firmar XML DS
async function firmarXmlDs(
  xmlBase64: string, dsNumber: string, settings: CompanySettings,
): Promise<{ signed_xml_base64?: string; zip_base64?: string; filename?: string }> {
  const { pfxBase64, password } = getCertCredentials(settings);
  const { spawn: sp2 } = await import('child_process');
  const signerScript   = path.join(PYTHON_DIR, 'signer_cli.py');

  return new Promise((resolve, reject) => {
    const child = sp2(PYTHON_EXEC, [signerScript, 'sign'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let out = '', err = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    child.on('close', (code) => {
      if (code !== 0 && !out) return reject(new Error(err.trim() || `Signer salió con código ${code}`));
      try {
        const raw    = out.trim();
        const start  = raw.indexOf('{');
        const result = JSON.parse(start >= 0 ? raw.slice(start) : raw) as Record<string, unknown>;
        resolve(result as { signed_xml_base64?: string; zip_base64?: string; filename?: string });
      } catch {
        reject(new Error(`Respuesta signer inválida: ${out.slice(0, 200)}`));
      }
    });
    child.on('error', (e) => reject(new Error(`Signer no iniciado: ${e.message}`)));
    child.stdin.write(JSON.stringify({
      xml_base64: xmlBase64,
      filename:   dsNumber,
      pfx_base64: pfxBase64 ?? undefined,
      password:   password  ?? undefined,
    }));
    child.stdin.end();
  });
}

// Enviar ZIP a la DIAN
async function enviarADian(
  zipBase64: string, filename: string, settings: CompanySettings,
): Promise<Record<string, unknown>> {
  const { pfxBase64, password } = getCertCredentials(settings);
  const transmitterScript = path.join(PYTHON_DIR, 'transmitter_cli.py');

  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_EXEC, [transmitterScript, 'send-bill-sync'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let out = '', err = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    child.on('close', (code) => {
      if (code !== 0 && !out) return reject(new Error(err.trim() || `Transmitter salió con código ${code}`));
      try {
        const raw    = out.trim();
        const start  = raw.indexOf('{');
        resolve(JSON.parse(start >= 0 ? raw.slice(start) : raw) as Record<string, unknown>);
      } catch {
        reject(new Error(`Respuesta transmitter inválida: ${out.slice(0, 200)}`));
      }
    });
    child.on('error', (e) => reject(new Error(`Transmitter no iniciado: ${e.message}`)));
    child.stdin.write(JSON.stringify({
      zip_base64:  zipBase64,
      filename,
      environment: settings.environment || '2',
      pfx_base64:  pfxBase64 ?? undefined,
      password:    password  ?? undefined,
    }));
    child.stdin.end();
  });
}

// ─── Helper: obtener settings y company ──────────────────────────────────────

async function getSettings(cid: string): Promise<CompanySettings | null> {
  return AppDataSource.getRepository(CompanySettings).findOne({ where: { company_id: cid } });
}
async function getCompany(cid: string): Promise<Company | null> {
  return AppDataSource.getRepository(Company).findOne({ where: { id: cid } });
}

// ─── Helper: cargar lineas via SQL raw (fallback cuando addSelect no deserializa) ──

async function cargarLineasRaw(id: string): Promise<Record<string, unknown>[] | null> {
  try {
    const rows = await AppDataSource.query(
      `SELECT lineas FROM documentos_soporte WHERE id = ?`, [id]
    );
    if (!rows || !rows[0] || rows[0].lineas == null) return null;
    const raw = rows[0].lineas;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string' && raw.trim()) return JSON.parse(raw);
    return null;
  } catch {
    return null;
  }
}

// ─── GET /  (listar) ─────────────────────────────────────────────────────────

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      page = '1', limit = '20',
      search = '', estado = '', date_from = '', date_to = '',
    } = req.query as Record<string, string>;
    const cid = req.user!.companyId;

    let qb = AppDataSource.getRepository(DocumentoSoporte)
      .createQueryBuilder('ds')
      .leftJoinAndSelect('ds.centro_costo', 'centro_costo')
      .leftJoinAndSelect('ds.sede', 'sede')
      .leftJoinAndSelect('sede.municipio', 'sede_municipio')
      .where('ds.company_id = :cid', { cid });

    if (estado)    qb = qb.andWhere('ds.estado = :estado', { estado });
    if (date_from) qb = qb.andWhere('ds.fecha_emision >= :df', { df: date_from });
    if (date_to)   qb = qb.andWhere('ds.fecha_emision <= :dt', { dt: date_to });
    if (search) {
      const s = `%${search}%`;
      qb = qb.andWhere(
        '(ds.numero_ds LIKE :s OR ds.proveedor_nombre LIKE :s OR ds.proveedor_nit LIKE :s)',
        { s },
      );
    }

    const [items, total] = await qb
      // Orden por fecha Y HORA real de creación (created_at), no por la fecha del
      // documento (que es solo el día y puede repetirse/empatar entre varios
      // registros del mismo día, dejando el más nuevo mezclado entre los viejos).
      .orderBy('ds.created_at', 'DESC')
      .skip((+page - 1) * +limit)
      .take(+limit)
      .getManyAndCount();

    res.json({ items, total, page: +page, limit: +limit });
  } catch (e) {
    console.error('[DS] Error listando:', e);
    res.status(500).json({ error: 'Error listando documentos soporte' });
  }
});

// ─── GET /:id ────────────────────────────────────────────────────────────────

async function findDs(id: string, cid: string, withBlobs = false) {
  let qb = AppDataSource.getRepository(DocumentoSoporte)
    .createQueryBuilder('ds')
    .leftJoinAndSelect('ds.centro_costo', 'centro_costo')
    .leftJoinAndSelect('ds.sede', 'sede')
    .leftJoinAndSelect('sede.municipio', 'sede_municipio')
    .where('ds.id = :id AND ds.company_id = :cid', { id, cid });

  if (withBlobs) {
    qb = qb
      .addSelect('ds.lineas')
      .addSelect('ds.xml_base64')
      .addSelect('ds.signed_xml_base64')
      .addSelect('ds.pdf_base64')
      .addSelect('ds.zip_base64')
      .addSelect('ds.dian_response');
  } else {
    qb = qb
      .addSelect('ds.lineas')
      .addSelect('ds.dian_response');   // necesario para mostrar errores DIAN en el detalle
  }
  return qb.getOne();
}

router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const ds = await findDs(req.params.id, req.user!.companyId);
    if (!ds) { res.status(404).json({ error: 'Documento Soporte no encontrado' }); return; }
    res.json(ds);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo Documento Soporte' });
  }
});

// ─── Helper: precargar datos del tercero ─────────────────────────────────────

async function precargarTercero(cid: string, terceroId?: string): Promise<Partial<DocumentoSoporte>> {
  if (!terceroId) return {};
  const tercero = await AppDataSource.getRepository(Tercero)
    .findOne({ where: { id: terceroId, company_id: cid } });
  if (!tercero) return {};
  return {
    proveedor_tipo_id:             tercero.tipo_id,
    proveedor_nit:                 tercero.nit,
    proveedor_nombre:              tercero.nombre,
    proveedor_primer_nombre:       tercero.primer_nombre,
    proveedor_segundo_nombre:      tercero.segundo_nombre,
    proveedor_primer_apellido:     tercero.primer_apellido,
    proveedor_segundo_apellido:    tercero.segundo_apellido,
    proveedor_direccion:           tercero.direccion,
    proveedor_ciudad_codigo:       tercero.ciudad_codigo,
    proveedor_ciudad_nombre:       tercero.ciudad_nombre,
    proveedor_departamento_codigo: tercero.departamento_codigo,
    proveedor_departamento_nombre: tercero.departamento_nombre,
    proveedor_email:               tercero.email,
    proveedor_telefono:            tercero.telefono,
  };
}

// ─── Helper: ciclo completo generar XML → PDF → firmar → enviar a DIAN ───────
// Igual que facturas normales (invoices.routes.ts POST /): todo ocurre en una
// sola llamada síncrona, sin persistir un estado intermedio "borrador"/"enviando".

async function procesarYEnviarDs(
  ds: DocumentoSoporte, company: Company, settings: CompanySettings,
): Promise<{ dianResult: Record<string, unknown>; statusCode: string; statusDesc: string; dianOk: boolean }> {
  // 1. Generar XML DS
  const xmlPayload = buildDsXmlPayload(ds, company, settings);
  const xmlResult  = await callDsCli('generate-ds', xmlPayload);
  if (!xmlResult.success) throw new Error(xmlResult.error as string || 'Error generando XML DS');

  const xmlBase64 = xmlResult.xml_base64 as string;
  const cuds      = xmlResult.cuds as string;
  ds.xml_base64   = xmlBase64;
  ds.cuds         = cuds;

  // 2. Firmar XML — ANTES de generar el PDF (igual que invoices.routes.ts), para
  // poder incluir la Firma Digital Electrónica en el PDF. Antes se generaba el PDF
  // primero y por eso nunca aparecía la firma en el Documento Soporte.
  const signResult = await firmarXmlDs(xmlBase64, ds.numero_ds, settings);
  if (!signResult.signed_xml_base64 && !signResult.zip_base64) {
    throw new Error('Error firmando XML DS');
  }
  ds.signed_xml_base64 = signResult.signed_xml_base64 as string | undefined;
  ds.zip_base64        = signResult.zip_base64 as string | undefined;
  ds.archivo_firmado   = signResult.filename  as string | undefined;

  // 3. Generar PDF DS (con la firma ya disponible)
  const pdfPayload = buildDsPdfPayload(ds, company, settings, cuds);
  const pdfResult  = await callDsCli('generate-ds-pdf', pdfPayload);
  if (pdfResult.success && pdfResult.pdf_base64) {
    ds.pdf_base64 = pdfResult.pdf_base64 as string;
  }

  // 4. Enviar a DIAN
  const zipToSend   = (ds.zip_base64 || ds.signed_xml_base64)!;
  const dianResult  = await enviarADian(zipToSend, ds.numero_ds, settings);

  const statusCode: string = (
    (dianResult as any)?.status_code ??
    (dianResult as any)?.StatusCode  ??
    (dianResult as any)?.dianStatusCode ?? ''
  ).toString();
  const statusDesc: string = (
    (dianResult as any)?.status_message ??
    (dianResult as any)?.StatusDescription ?? ''
  ).toString();

  ds.dian_status_code        = statusCode;
  ds.dian_status_description = statusDesc;
  ds.dian_response           = JSON.stringify(dianResult);

  return { dianResult, statusCode, statusDesc, dianOk: statusCode === '00' };
}

// ─── POST /  (crear Y enviar a la DIAN en una sola llamada) ──────────────────

router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid      = req.user!.companyId;
    if (!req.body.centro_costo_id) { res.status(400).json({ error: 'El centro de costo es obligatorio' }); return; }
    if (!req.body.sede_id) { res.status(400).json({ error: 'La sede es obligatoria' }); return; }
    // FBK-017: el NIT/cédula digitado debe corresponder a un tercero existente
    // marcado como proveedor.
    const provNitRaw = String(req.body.proveedor_nit || '').replace(/\D/g, '');
    if (!provNitRaw) { res.status(400).json({ error: 'El NIT/cédula del proveedor es obligatorio' }); return; }
    const terceroProv = await AppDataSource.getRepository(Tercero).findOne({ where: { company_id: cid, nit: provNitRaw } });
    if (!terceroProv) {
      res.status(400).json({ error: `El NIT/cédula "${req.body.proveedor_nit}" no corresponde a ningún tercero registrado. Cree el tercero (marcado como proveedor) antes de guardar el Documento Soporte.` });
      return;
    }
    if (!terceroProv.es_proveedor) {
      res.status(400).json({ error: `El tercero "${terceroProv.nombre}" (NIT ${terceroProv.nit}) existe pero no está marcado como proveedor.` });
      return;
    }
    const settings = await getSettings(cid);
    const company  = await getCompany(cid);
    if (!settings || !company) { res.status(400).json({ error: 'Configuración de empresa no encontrada' }); return; }

    // Asignar número consecutivo de forma atómica ANTES de cualquier llamada
    // externa (generación XML / firma / envío DIAN) — mismo patrón ya usado
    // en facturas/notas de salud para eliminar la condición de carrera que
    // permitía duplicar el número cuando dos solicitudes llegaban a la vez.
    const numero    = await reservarConsecutivo(AppDataSource, cid, 'next_ds_number');
    const prefijo   = settings.ds_prefix || 'DS';
    const numero_ds = `${prefijo}-${String(numero).padStart(6, '0')}`;

    const terceroData = await precargarTercero(cid, req.body.proveedor_tercero_id);

    const repo = AppDataSource.getRepository(DocumentoSoporte);
    // Nota: con `...req.body` (tipado `any`) TypeScript puede resolver mal el
    // overload de repo.create() y creer que se le pasó un array. Se anota
    // explícitamente el literal como Partial<DocumentoSoporte> para forzar
    // el overload correcto (un solo objeto → una sola entidad).
    const dsData: Partial<DocumentoSoporte> = {
      ...req.body,
      ...terceroData,      // datos del tercero tienen precedencia sobre lo que venga en el body si se precargan
      company_id:            cid,
      numero,
      numero_ds,
      prefijo,
      estado:                'rechazado' as EstadoDocumentoSoporte,  // reemplazado abajo con el resultado real
      creado_por_usuario_id: req.user!.id,
      creado_por_nombre:     req.user!.name || req.user!.email,
    };
    const ds = repo.create(dsData);

    let dianResult: Record<string, unknown> | undefined;
    try {
      const r = await procesarYEnviarDs(ds, company, settings);
      dianResult = r.dianResult;
      ds.estado  = r.dianOk ? 'aprobado_dian' : 'rechazado';
    } catch (e: any) {
      console.error('[DS] Error generando/enviando a la DIAN:', e);
      ds.estado = 'rechazado';
      ds.dian_status_description = e.message;
    }

    await repo.save(ds);

    // Si aprobado, generar asiento contable en borrador
    if (ds.estado === 'aprobado_dian') {
      try { await generarAsientoDesdeDocumentoSoporte(ds, cid); }
      catch (e) { console.error('[ASIENTO][DS]', e); }
    }

    res.status(201).json({ ...ds, dian_response: dianResult ?? ds.dian_response });
  } catch (e) {
    console.error('[DS] Error creando:', e);
    res.status(500).json({ error: 'Error creando Documento Soporte' });
  }
});

// ─── PUT /:id  (corregir Y reenviar — mismo ciclo completo) ──────────────────

router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid  = req.user!.companyId;
    const ds   = await findDs(req.params.id, cid, true);
    if (!ds)   { res.status(404).json({ error: 'Documento Soporte no encontrado' }); return; }
    // Igual que facturas: solo se corrige y reenvía un documento rechazado
    // (no existe estado "borrador"; un aprobado/aceptado ya no se edita aquí).
    if (!['rechazado', 'borrador'].includes(ds.estado)) {
      res.status(400).json({ error: `No se puede corregir un Documento Soporte en estado: ${ds.estado}` });
      return;
    }

    const [settings, company] = await Promise.all([getSettings(cid), getCompany(cid)]);
    if (!settings || !company) { res.status(400).json({ error: 'Configuración no encontrada' }); return; }

    let terceroData: Partial<DocumentoSoporte> = {};
    if (req.body.proveedor_tercero_id && req.body.proveedor_tercero_id !== ds.proveedor_tercero_id) {
      terceroData = await precargarTercero(cid, req.body.proveedor_tercero_id);
    }

    const { id, company_id, numero, numero_ds, prefijo, estado,
            creado_por_usuario_id, creado_por_nombre, created_at, ...rest } = req.body;

    // FBK-017: revalidar tercero-proveedor también al editar, con el NIT efectivo
    // (el que venga en el body, o si no cambió, el que ya tenía el documento).
    const provNitEfectivo = String((terceroData as any).proveedor_nit ?? rest.proveedor_nit ?? ds.proveedor_nit ?? '').replace(/\D/g, '');
    if (!provNitEfectivo) { res.status(400).json({ error: 'El NIT/cédula del proveedor es obligatorio' }); return; }
    const terceroProvPut = await AppDataSource.getRepository(Tercero).findOne({ where: { company_id: cid, nit: provNitEfectivo } });
    if (!terceroProvPut) {
      res.status(400).json({ error: `El NIT/cédula "${provNitEfectivo}" no corresponde a ningún tercero registrado. Cree el tercero (marcado como proveedor) antes de guardar el Documento Soporte.` });
      return;
    }
    if (!terceroProvPut.es_proveedor) {
      res.status(400).json({ error: `El tercero "${terceroProvPut.nombre}" (NIT ${terceroProvPut.nit}) existe pero no está marcado como proveedor.` });
      return;
    }

    Object.assign(ds, rest, terceroData);

    let dianResult: Record<string, unknown> | undefined;
    try {
      const r = await procesarYEnviarDs(ds, company, settings);
      dianResult = r.dianResult;
      ds.estado  = r.dianOk ? 'aprobado_dian' : 'rechazado';
    } catch (e: any) {
      console.error('[DS] Error generando/enviando a la DIAN:', e);
      ds.estado = 'rechazado';
      ds.dian_status_description = e.message;
    }

    await AppDataSource.getRepository(DocumentoSoporte).save(ds);

    if (ds.estado === 'aprobado_dian') {
      try { await generarAsientoDesdeDocumentoSoporte(ds, cid); }
      catch (e) { console.error('[ASIENTO][DS]', e); }
    }

    res.json({ ...ds, dian_response: dianResult ?? ds.dian_response });
  } catch (e) {
    console.error('[DS] Error actualizando:', e);
    res.status(500).json({ error: 'Error actualizando Documento Soporte' });
  }
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────────
// Se conserva solo para limpiar registros heredados en estado "borrador"
// (el nuevo flujo ya no crea documentos en ese estado).

router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const ds  = await findDs(req.params.id, cid);
    if (!ds)   { res.status(404).json({ error: 'Documento Soporte no encontrado' }); return; }
    if (ds.estado !== 'borrador') {
      res.status(400).json({ error: 'Solo se pueden eliminar documentos en borrador' });
      return;
    }
    await AppDataSource.getRepository(DocumentoSoporte).remove(ds);
    res.json({ message: 'Documento Soporte eliminado' });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando Documento Soporte' });
  }
});

// ─── POST /:id/enviar  (reenvío rápido — reutiliza los datos ya guardados) ───
// Usado por el botón "↺ Reenviar a DIAN" del detalle (equivalente a
// invoices.routes.ts POST /:id/resend), sin necesidad de editar el documento.

router.post('/:id/enviar', async (req: AuthRequest, res: Response): Promise<void> => {
  const cid  = req.user!.companyId;
  const repo = AppDataSource.getRepository(DocumentoSoporte);

  const ds = await findDs(req.params.id, cid, true);
  if (!ds) { res.status(404).json({ error: 'Documento Soporte no encontrado' }); return; }

  // ── Garantizar que lineas esté cargado (TypeORM addSelect puede no deserializar simple-json) ──
  if (!Array.isArray(ds.lineas) || ds.lineas.length === 0) {
    const lineasRaw = await cargarLineasRaw(ds.id);
    if (lineasRaw && lineasRaw.length > 0) {
      ds.lineas = lineasRaw;
    }
  }

  const [settings, company] = await Promise.all([getSettings(cid), getCompany(cid)]);
  if (!settings || !company) { res.status(400).json({ error: 'Configuración no encontrada' }); return; }

  try {
    const { dianResult, dianOk } = await procesarYEnviarDs(ds, company, settings);
    ds.estado = dianOk ? 'aprobado_dian' : 'rechazado';
    await repo.save(ds);

    if (dianOk) {
      try { await generarAsientoDesdeDocumentoSoporte(ds, cid); }
      catch (e) { console.error('[ASIENTO][DS]', e); }
    }

    res.json({
      estado:                  ds.estado,
      cuds:                    ds.cuds,
      dian_status_code:        ds.dian_status_code,
      dian_status_description: ds.dian_status_description,
      dian_response:           dianResult,   // objeto completo para que el frontend detecte errores
    });
  } catch (e: any) {
    console.error('[DS] Error enviando a DIAN:', e);
    ds.estado = 'rechazado';
    ds.dian_status_description = e.message;
    await repo.save(ds);
    res.status(500).json({ error: e.message || 'Error enviando Documento Soporte a la DIAN' });
  }
});

// ─── POST /:id/aceptar  (marcar aceptado manualmente) ────────────────────────

router.post('/:id/aceptar', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const ds  = await findDs(req.params.id, cid);
    if (!ds) { res.status(404).json({ error: 'Documento Soporte no encontrado' }); return; }
    if (ds.estado !== 'aprobado_dian') {
      res.status(400).json({ error: 'Solo se puede aceptar un DS aprobado por la DIAN' });
      return;
    }

    const hoy = new Date().toISOString().slice(0, 10);
    ds.estado      = 'aceptado';
    ds.aceptado_en = hoy;
    await AppDataSource.getRepository(DocumentoSoporte).save(ds);

    res.json({ estado: ds.estado, aceptado_en: ds.aceptado_en });
  } catch (e) {
    res.status(500).json({ error: 'Error marcando aceptación' });
  }
});

// ─── GET /:id/pdf ─────────────────────────────────────────────────────────────

router.get('/:id/pdf', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const ds  = await findDs(req.params.id, cid, true);
    if (!ds)           { res.status(404).json({ error: 'DS no encontrado' }); return; }
    if (!ds.pdf_base64){ res.status(404).json({ error: 'PDF no generado aún' }); return; }

    const buf = Buffer.from(ds.pdf_base64, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${ds.numero_ds}.pdf"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: 'Error descargando PDF' });
  }
});

// ─── GET /:id/xml ─────────────────────────────────────────────────────────────

router.get('/:id/xml', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const ds  = await findDs(req.params.id, cid, true);
    if (!ds) { res.status(404).json({ error: 'DS no encontrado' }); return; }
    const xmlSrc = ds.signed_xml_base64 || ds.xml_base64;
    if (!xmlSrc) { res.status(404).json({ error: 'XML no generado aún' }); return; }

    const buf = Buffer.from(xmlSrc, 'base64');
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="${ds.numero_ds}.xml"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: 'Error descargando XML' });
  }
});

// ─── GET /:id/zip ─────────────────────────────────────────────────────────────

router.get('/:id/zip', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const ds  = await findDs(req.params.id, cid, true);
    if (!ds || !ds.zip_base64) { res.status(404).json({ error: 'ZIP no disponible' }); return; }

    const buf = Buffer.from(ds.zip_base64, 'base64');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${ds.numero_ds}.zip"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: 'Error descargando ZIP' });
  }
});

export default router;
