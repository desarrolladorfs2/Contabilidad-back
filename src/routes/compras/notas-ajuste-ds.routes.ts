/**
 * notas-ajuste-ds.routes.ts
 *
 * Endpoints REST para Notas de Ajuste al Documento Soporte.
 * Monta en: /api/compras/notas-ajuste-ds
 *
 * DocumentTypeCode: 92 (NC_DS — reduce) | 93 (ND_DS — incrementa)
 */

import { Router, Response }             from 'express';
import { AppDataSource }                from '../../config/database';
import { reservarConsecutivo } from '../../utils/consecutivo.util';
import { NotaAjusteDS }                 from '../../entities/compras/NotaAjusteDS';
import { DocumentoSoporte }             from '../../entities/compras/DocumentoSoporte';
import { CompanySettings }              from '../../entities/CompanySettings';
import { Company }                      from '../../entities/Company';
import { authMiddleware, AuthRequest }  from '../../middleware/auth.middleware';
import { buildNotaAjusteDsXmlPayload }  from '../../utils/ds-payload.utils';
import { getCertCredentials }           from '../../services/dian.service';
import { spawn }                        from 'child_process';
import * as path                        from 'path';
import { PYTHON_EXEC }                  from '../../utils/python-executable.util';

const router = Router();
router.use(authMiddleware);

const PYTHON_DIR  = path.resolve(__dirname, '../../..', 'python');   // backend/python/

// ─── Helpers ─────────────────────────────────────────────────────────────────

function callDsCli(operation: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const script = path.join(PYTHON_DIR, 'ds_xml_builder_cli.py');
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
        resolve(JSON.parse(start >= 0 ? raw.slice(start) : raw) as Record<string, unknown>);
      } catch {
        reject(new Error(`Respuesta Python inválida: ${out.slice(0, 200)}`));
      }
    });
    child.on('error', (e) => reject(new Error(`Python no iniciado: ${e.message}`)));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function firmarXml(xmlBase64: string, filename: string, settings: CompanySettings) {
  const { pfxBase64, password } = getCertCredentials(settings);
  const signerScript = path.join(PYTHON_DIR, 'signer_cli.py');
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(PYTHON_EXEC, [signerScript, 'sign'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let out = '', err = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    child.on('close', (code) => {
      if (code !== 0 && !out) return reject(new Error(err.trim() || `Signer salió con código ${code}`));
      try {
        const raw = out.trim();
        resolve(JSON.parse(raw.slice(raw.indexOf('{') >= 0 ? raw.indexOf('{') : 0)) as Record<string, unknown>);
      } catch {
        reject(new Error(`Signer: respuesta no JSON: ${out.slice(0, 200)}`));
      }
    });
    child.on('error', (e) => reject(new Error(`Signer no iniciado: ${e.message}`)));
    child.stdin.write(JSON.stringify({
      xml_base64: xmlBase64, filename,
      pfx_base64: pfxBase64 ?? undefined, password: password ?? undefined,
    }));
    child.stdin.end();
  });
}

async function enviarADian(zipBase64: string, filename: string, settings: CompanySettings) {
  const { pfxBase64, password } = getCertCredentials(settings);
  const transmitterScript = path.join(PYTHON_DIR, 'transmitter_cli.py');
  return new Promise<Record<string, unknown>>((resolve, reject) => {
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
        const raw = out.trim();
        resolve(JSON.parse(raw.slice(raw.indexOf('{') >= 0 ? raw.indexOf('{') : 0)) as Record<string, unknown>);
      } catch {
        reject(new Error(`Transmitter: respuesta no JSON: ${out.slice(0, 200)}`));
      }
    });
    child.on('error', (e) => reject(new Error(`Transmitter no iniciado: ${e.message}`)));
    child.stdin.write(JSON.stringify({
      zip_base64: zipBase64, filename,
      environment: settings.environment || '2',
      pfx_base64: pfxBase64 ?? undefined, password: password ?? undefined,
    }));
    child.stdin.end();
  });
}

async function getSettings(cid: string) {
  return AppDataSource.getRepository(CompanySettings).findOne({ where: { company_id: cid } });
}
async function getCompany(cid: string) {
  return AppDataSource.getRepository(Company).findOne({ where: { id: cid } });
}

function findNota(id: string, cid: string, withBlobs = false) {
  let qb = AppDataSource.getRepository(NotaAjusteDS)
    .createQueryBuilder('na')
    .innerJoin('na.documento_soporte', 'ds', 'ds.company_id = :cid', { cid })
    .where('na.id = :id', { id });
  if (withBlobs) {
    qb = qb.addSelect(['na.xml_base64', 'na.signed_xml_base64', 'na.pdf_base64',
                       'na.zip_base64', 'na.dian_response', 'na.lineas']);
  } else {
    qb = qb.addSelect('na.lineas');
  }
  return qb.getOne();
}

// ─── GET /  (listar) ─────────────────────────────────────────────────────────

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { page = '1', limit = '20', search = '', estado = '',
            ds_id = '', date_from = '', date_to = '' } = req.query as Record<string, string>;
    const cid = req.user!.companyId;

    let qb = AppDataSource.getRepository(NotaAjusteDS)
      .createQueryBuilder('na')
      .innerJoin('na.documento_soporte', 'ds', 'ds.company_id = :cid', { cid });

    if (ds_id)     qb = qb.andWhere('na.documento_soporte_id = :ds_id', { ds_id });
    if (estado)    qb = qb.andWhere('na.estado = :estado', { estado });
    if (date_from) qb = qb.andWhere('na.fecha_emision >= :df', { df: date_from });
    if (date_to)   qb = qb.andWhere('na.fecha_emision <= :dt', { dt: date_to });
    if (search) {
      const s = `%${search}%`;
      qb = qb.andWhere('(na.numero_nota_ajuste LIKE :s OR ds.numero_ds LIKE :s OR ds.proveedor_nombre LIKE :s)', { s });
    }

    const [items, total] = await qb
      .addSelect('ds.numero_ds')
      .addSelect('ds.proveedor_nombre')
      // Orden por fecha Y HORA real de creación (created_at), no por la fecha del
      // documento (que es solo el día y puede repetirse/empatar entre varios
      // registros del mismo día, dejando el más nuevo mezclado entre los viejos).
      .orderBy('na.created_at', 'DESC')
      .skip((+page - 1) * +limit)
      .take(+limit)
      .getManyAndCount();

    res.json({ items, total, page: +page, limit: +limit });
  } catch (e) {
    res.status(500).json({ error: 'Error listando notas ajuste DS' });
  }
});

// ─── GET /:id ────────────────────────────────────────────────────────────────

router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const nota = await findNota(req.params.id, req.user!.companyId);
    if (!nota) { res.status(404).json({ error: 'Nota Ajuste DS no encontrada' }); return; }
    res.json(nota);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo Nota Ajuste DS' });
  }
});

// ─── POST /  (crear) ─────────────────────────────────────────────────────────

router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid      = req.user!.companyId;
    const settings = await getSettings(cid);
    if (!settings) { res.status(400).json({ error: 'Configuración no encontrada' }); return; }

    const { documento_soporte_id } = req.body;
    if (!documento_soporte_id) { res.status(400).json({ error: 'documento_soporte_id requerido' }); return; }

    // Verificar que el DS existe y pertenece a la empresa
    const ds = await AppDataSource.getRepository(DocumentoSoporte)
      .findOne({ where: { id: documento_soporte_id, company_id: cid } });
    if (!ds) { res.status(404).json({ error: 'Documento Soporte de referencia no encontrado' }); return; }
    if (!['aprobado_dian', 'aceptado'].includes(ds.estado)) {
      res.status(400).json({ error: 'Solo se puede ajustar un DS aprobado por la DIAN' });
      return;
    }

    const repo    = AppDataSource.getRepository(NotaAjusteDS);
    // Reserva atómica del consecutivo — mismo patrón que documentos-soporte.routes.ts
    // (evita que dos Notas de Ajuste DS creadas al mismo tiempo choquen con el
    // mismo número).
    const numero  = await reservarConsecutivo(AppDataSource, cid, 'next_nota_ajuste_ds_number');
    const prefijo = settings.nota_ajuste_ds_prefix || 'NADS';
    const numStr  = String(numero).padStart(6, '0');
    const numero_nota_ajuste = `${prefijo}-${numStr}`;

    const nota = repo.create({
      ...req.body,
      company_id:             cid,
      documento_soporte_id:   ds.id,
      proveedor_tercero_id:   ds.proveedor_tercero_id,
      // Centro de costo y sede: se cargan del Documento Soporte referenciado, no se seleccionan aqui.
      centro_costo_id:        ds.centro_costo_id,
      sede_id:                ds.sede_id,
      // Ciudad: se copia del Documento Soporte referenciado, mismo criterio que CC/sede. FBK-012 (remanente).
      ciudad_codigo:          ds.ciudad_codigo,
      ciudad_nombre:          ds.ciudad_nombre,
      numero,
      prefijo,
      numero_nota_ajuste,
      estado:                 'borrador' as const,
      creado_por_usuario_id:  req.user!.id,
      creado_por_nombre:      req.user!.name || req.user!.email,
    });

    await repo.save(nota);

    res.status(201).json(nota);
  } catch (e) {
    console.error('[NADS] Error creando:', e);
    res.status(500).json({ error: 'Error creando Nota Ajuste DS' });
  }
});

// ─── PUT /:id ─────────────────────────────────────────────────────────────────

router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const nota = await findNota(req.params.id, req.user!.companyId);
    if (!nota) { res.status(404).json({ error: 'Nota Ajuste DS no encontrada' }); return; }
    if (nota.estado !== 'borrador') {
      res.status(400).json({ error: 'Solo se pueden editar notas en borrador' });
      return;
    }
    const { id, company_id, numero, numero_nota_ajuste, ...rest } = req.body;
    Object.assign(nota, rest);
    await AppDataSource.getRepository(NotaAjusteDS).save(nota);
    res.json(nota);
  } catch (e) {
    res.status(500).json({ error: 'Error actualizando Nota Ajuste DS' });
  }
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────────

router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const nota = await findNota(req.params.id, req.user!.companyId);
    if (!nota) { res.status(404).json({ error: 'Nota Ajuste DS no encontrada' }); return; }
    if (nota.estado !== 'borrador') {
      res.status(400).json({ error: 'Solo se pueden eliminar notas en borrador' });
      return;
    }
    await AppDataSource.getRepository(NotaAjusteDS).remove(nota);
    res.json({ message: 'Nota Ajuste DS eliminada' });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando Nota Ajuste DS' });
  }
});

// ─── POST /:id/enviar ─────────────────────────────────────────────────────────

router.post('/:id/enviar', async (req: AuthRequest, res: Response): Promise<void> => {
  const cid  = req.user!.companyId;
  const repo = AppDataSource.getRepository(NotaAjusteDS);

  const nota = await findNota(req.params.id, cid, true);
  if (!nota) { res.status(404).json({ error: 'Nota Ajuste DS no encontrada' }); return; }
  if (!['borrador', 'rechazada'].includes(nota.estado)) {
    res.status(400).json({ error: `No se puede reenviar nota en estado: ${nota.estado}` });
    return;
  }

  const [settings, company] = await Promise.all([getSettings(cid), getCompany(cid)]);
  if (!settings || !company) { res.status(400).json({ error: 'Configuración no encontrada' }); return; }

  // Cargar DS de referencia con blobs
  const ds = await AppDataSource.getRepository(DocumentoSoporte)
    .createQueryBuilder('ds')
    .addSelect(['ds.lineas'])
    .where('ds.id = :id AND ds.company_id = :cid', { id: nota.documento_soporte_id, cid })
    .getOne();
  if (!ds) { res.status(404).json({ error: 'DS de referencia no encontrado' }); return; }

  nota.estado = 'enviada';
  await repo.save(nota);

  try {
    // 1. Generar XML Nota Ajuste
    const xmlPayload = buildNotaAjusteDsXmlPayload(nota, ds, company, settings);
    const xmlResult  = await callDsCli('generate-nota-ajuste', xmlPayload);
    if (!xmlResult.success) throw new Error(xmlResult.error as string || 'Error generando XML nota ajuste');

    const xmlBase64 = xmlResult.xml_base64 as string;
    const cuds      = xmlResult.cuds as string;
    nota.xml_base64 = xmlBase64;
    nota.cuds       = cuds;

    // 2. Firmar XML
    const signResult = await firmarXml(xmlBase64, nota.numero_nota_ajuste, settings);
    nota.signed_xml_base64 = signResult.signed_xml_base64 as string | undefined;
    nota.zip_base64        = signResult.zip_base64 as string | undefined;
    nota.archivo_firmado   = signResult.filename as string | undefined;

    // 3. Enviar a DIAN
    const zipToSend  = (nota.zip_base64 || nota.signed_xml_base64)!;
    const dianResult = await enviarADian(zipToSend, nota.numero_nota_ajuste, settings);

    const statusCode = ((dianResult as any)?.status_code ?? (dianResult as any)?.StatusCode ?? '').toString();
    nota.dian_status_code        = statusCode;
    nota.dian_status_description = ((dianResult as any)?.status_message ?? '').toString();
    nota.dian_response           = JSON.stringify(dianResult);
    nota.estado                  = statusCode === '00' ? 'aprobada' : 'rechazada';

    await repo.save(nota);

    res.json({
      estado:     nota.estado,
      cuds:       nota.cuds,
      dian_status_code:        nota.dian_status_code,
      dian_status_description: nota.dian_status_description,
    });
  } catch (e: any) {
    console.error('[NADS] Error enviando a DIAN:', e);
    nota.estado = 'rechazada';
    nota.dian_status_description = e.message;
    await repo.save(nota);
    res.status(500).json({ error: e.message || 'Error enviando Nota Ajuste DS' });
  }
});

// ─── GET /:id/pdf ─────────────────────────────────────────────────────────────

router.get('/:id/pdf', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const nota = await findNota(req.params.id, req.user!.companyId, true);
    if (!nota || !nota.pdf_base64) { res.status(404).json({ error: 'PDF no disponible' }); return; }
    const buf = Buffer.from(nota.pdf_base64, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${nota.numero_nota_ajuste}.pdf"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: 'Error descargando PDF nota ajuste' });
  }
});

export default router;
