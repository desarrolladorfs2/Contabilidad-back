/**
 * Cargue masivo de registros de facturas de salud (evento).
 * Flujo: subir Excel → preview/validación → confirmar → facturas pendiente_cierre asignadas.
 */
import { Router, Response } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { AppDataSource } from '../../config/database';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import { LoteCargue } from '../../entities/salud/LoteCargue';
import { RegistroCargue } from '../../entities/salud/RegistroCargue';
import { FacturaSalud } from '../../entities/salud/FacturaSalud';
import { ContratoSalud } from '../../entities/salud/ContratoSalud';
import { ContratoServicio } from '../../entities/salud/ContratoServicio';
import { ServicioSalud } from '../../entities/salud/ServicioSalud';
import { User } from '../../entities/User';

const router = Router();
router.use(authMiddleware);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function str(v: unknown): string { return v == null ? '' : String(v).trim(); }
function num(v: unknown): number { return isNaN(Number(v)) ? 0 : Number(v); }
function dateStr(v: unknown): string {
  if (!v) return '';
  const s = str(v);
  // Excel date serial
  if (/^\d+$/.test(s)) {
    const d = XLSX.SSF.parse_date_code(Number(s));
    if (d) return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
  }
  // Already formatted
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

interface RowFactura {
  referencia_externa: string;
  contrato_numero: string;
  periodo_inicio: string;
  periodo_fin: string;
  regimen: string;
  tipo_operacion_ss: string;
  tipo_cobertura: string;
  asignado_a_email: string;
}
interface RowPaciente {
  referencia_externa: string;
  tipo_doc: string; num_doc: string; nombre: string;
  fecha_nacimiento: string; sexo: string; tipo_usuario: string;
  cod_municipio: string; zona_territorial: string; incapacidad: string;
  num_autorizacion: string;
}
interface RowServicio {
  referencia_externa: string; num_doc_paciente: string;
  tipo_servicio: string; codigo_cups: string;
  fecha_atencion: string; cantidad: number; valor_unitario: number;
  diagnostico_principal: string; diagnostico_rel1: string;
  diagnostico_rel2: string; diagnostico_rel3: string;
  num_autorizacion: string; modalidad_servicio: string;
  grupo_servicios: string; finalidad: string; causa_motivo: string;
  tipo_diagnostico: string; via_ingreso: string;
  concepto_recaudo: string; valor_moderador: number;
  tipo_medicamento: string; nombre_medicamento: string; dias_tratamiento: number;
  tipo_otro_servicio: string; nombre_tecnologia: string;
  // SAL-019 (Res. 948/2026): documento del MÉDICO/profesional que atendió — el RIPS
  // exige que numDocumentoIdentificacion dentro de cada servicio sea el del médico,
  // no el del paciente. Si se dejan vacías, se mantiene el comportamiento anterior
  // (se usa el documento del paciente) para no romper cargues ya existentes.
  medico_tipo_doc: string; medico_num_doc: string;
  // SAL-021: código de servicio (habilitación REPS). Opcional — si se deja vacío,
  // se usa el valor configurado para ese codigo_cups en el catálogo de servicios
  // de la empresa (ver ServicioSalud.cod_servicio).
  cod_servicio: string;
}

/**
 * Hallazgo #50: si el usuario sube un .csv (fácil de confundir con .xlsx —
 * mismo ícono al "Guardar como" desde Excel), las hojas 'Pacientes' y
 * 'Servicios' quedaban vacías silenciosamente porque un CSV solo tiene una
 * hoja. Se rechaza explícitamente con un mensaje claro en vez de procesar
 * a medias sin avisar.
 */
function validarExtensionArchivo(originalname: string | undefined): string | null {
  const nombre = (originalname || '').toLowerCase();
  if (nombre.endsWith('.csv')) {
    return 'El archivo debe ser un Excel (.xlsx), no un CSV. Un CSV solo tiene una hoja y no puede contener las hojas "Pacientes" y "Servicios" que requiere esta plantilla — expórtalo desde Excel usando "Guardar como" y elige el formato .xlsx.';
  }
  if (nombre && !nombre.endsWith('.xlsx') && !nombre.endsWith('.xls')) {
    return 'El archivo debe ser un Excel (.xlsx o .xls) con las hojas "Facturas", "Pacientes" y "Servicios".';
  }
  return null;
}

function parseExcel(buf: Buffer): { facturas: RowFactura[]; pacientes: RowPaciente[]; servicios: RowServicio[] } {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });

  const toRows = <T>(sheet: XLSX.WorkSheet): T[] =>
    XLSX.utils.sheet_to_json<T>(sheet, { defval: '', raw: true });

  const facturas  = toRows<RowFactura>(wb.Sheets['Facturas']  || wb.Sheets[wb.SheetNames[0]]);
  const pacientes = toRows<RowPaciente>(wb.Sheets['Pacientes'] || wb.Sheets[wb.SheetNames[1]] || {} as XLSX.WorkSheet);
  const servicios = toRows<RowServicio>(wb.Sheets['Servicios'] || wb.Sheets[wb.SheetNames[2]] || {} as XLSX.WorkSheet);

  return { facturas, pacientes, servicios };
}

interface RegistroValidado {
  referencia_externa: string;
  accion: 'nuevo' | 'actualizar' | 'skip';
  errores: string[];
  advertencias: string[];
  factura: RowFactura;
  paciente: RowPaciente;
  servicios_paciente: RowServicio[];
  contrato_id?: string;
  eps_id?: string;
  asignado_user?: { id: string; name: string };
}

async function validarRegistros(
  rows: { facturas: RowFactura[]; pacientes: RowPaciente[]; servicios: RowServicio[] },
  cid: string,
): Promise<RegistroValidado[]> {
  const contratoRepo  = AppDataSource.getRepository(ContratoSalud);
  const csRepo        = AppDataSource.getRepository(ContratoServicio);
  const regRepo       = AppDataSource.getRepository(RegistroCargue);
  const userRepo      = AppDataSource.getRepository(User);

  // Pre-load contratos (eps is eager — no need for relations:[])
  const contratos = await contratoRepo.find({ where: { company_id: cid } });
  const contratoMap = new Map(contratos.map(c => [c.numero.trim().toLowerCase(), c]));

  const users = await userRepo.find({ where: { company_id: cid, is_active: true } });
  const userMap = new Map(users.map(u => [u.email.toLowerCase(), u]));

  // Pre-load existing registros for upsert check
  const existentes = await regRepo.find({ where: { company_id: cid } });
  const existenteMap = new Map(existentes.map(r => [r.referencia_externa, r]));

  // Pre-load CUPS habilitados por contrato usando queryBuilder
  // (company_id en contrato_servicios puede ser NULL — filtramos por contrato_id)
  const cupsMap = new Map<string, Set<string>>(); // contrato_id → Set<codigo_cups>
  const contratoIds = contratos.map(c => c.id);
  if (contratoIds.length > 0) {
    const css = await csRepo.createQueryBuilder('cs')
      .leftJoinAndSelect('cs.servicio', 'sv')
      .where('cs.contrato_id IN (:...ids)', { ids: contratoIds })
      .andWhere('cs.habilitado = :h', { h: true })
      .getMany();
    for (const cs of css) {
      if (!cupsMap.has(cs.contrato_id)) cupsMap.set(cs.contrato_id, new Set());
      cupsMap.get(cs.contrato_id)!.add(cs.servicio.codigo_cups.trim().toUpperCase());
    }
  }

  const result: RegistroValidado[] = [];

  for (const fila of rows.facturas) {
    const ref     = str(fila.referencia_externa);
    const errores: string[] = [];
    const adv: string[] = [];

    if (!ref) { errores.push('referencia_externa vacía'); }

    // Contrato
    const contrato = contratoMap.get(str(fila.contrato_numero).toLowerCase());
    if (!contrato) errores.push(`Contrato "${fila.contrato_numero}" no existe`);

    // Período
    const pIni = dateStr(fila.periodo_inicio);
    const pFin = dateStr(fila.periodo_fin);
    if (!pIni) errores.push('periodo_inicio inválido');
    if (!pFin) errores.push('periodo_fin inválido');

    // Asignado
    const userAsignado = userMap.get(str(fila.asignado_a_email).toLowerCase());
    if (!userAsignado) errores.push(`Usuario "${fila.asignado_a_email}" no existe en la empresa`);

    // Paciente de esta factura
    const paciente = rows.pacientes.find(p => str(p.referencia_externa) === ref);
    if (!paciente) errores.push('No se encontró paciente para esta factura en hoja Pacientes');

    // SAL-002 (Res. 948/2026): sin estos 5 campos el RIPS sale incompleto y puede
    // ser rechazado por el Ministerio/SISPRO — antes se podían cargar vacíos sin
    // que el validador de la carga masiva lo detectara.
    if (paciente) {
      if (!dateStr(paciente.fecha_nacimiento)) errores.push('Paciente sin fecha_nacimiento (o con formato inválido)');
      if (!str(paciente.sexo))                 errores.push('Paciente sin sexo');
      if (!str(paciente.tipo_usuario))         errores.push('Paciente sin tipo_usuario');
      if (!str(paciente.cod_municipio))        errores.push('Paciente sin cod_municipio');
      if (!str(paciente.zona_territorial))     errores.push('Paciente sin zona_territorial');
    }

    // Servicios de esta factura
    const serviciosPaciente = rows.servicios.filter(s => str(s.referencia_externa) === ref);
    if (serviciosPaciente.length === 0) adv.push('No hay servicios en hoja Servicios para esta factura');

    // Validar CUPS en contrato
    if (contrato && cupsMap.has(contrato.id)) {
      const cupsContrato = cupsMap.get(contrato.id)!;
      for (const sv of serviciosPaciente) {
        const cups = str(sv.codigo_cups).toUpperCase();
        if (cups && !cupsContrato.has(cups)) {
          errores.push(`CUPS/CUM "${cups}" no está habilitado en el contrato "${contrato.numero}"`);
        }
      }
    }

    // Upsert check
    const existente = ref ? existenteMap.get(ref) : undefined;
    let accion: RegistroValidado['accion'] = 'nuevo';
    if (existente) {
      accion = existente.status === 'cerrada' ? 'skip' : 'actualizar';
      if (accion === 'skip') adv.push('Registro ya cerrado — se omitirá');
    }

    result.push({
      referencia_externa: ref,
      accion,
      errores,
      advertencias: adv,
      factura: { ...fila, periodo_inicio: pIni, periodo_fin: pFin },
      paciente: paciente!,
      servicios_paciente: serviciosPaciente,
      contrato_id: contrato?.id,
      eps_id: contrato?.eps_id,
      asignado_user: userAsignado ? { id: userAsignado.id, name: userAsignado.name } : undefined,
    });
  }

  return result;
}

// ─── GET /api/salud/cargue/template ──────────────────────────────────────────
router.get('/template', (_req: AuthRequest, res: Response): void => {
  const wb = XLSX.utils.book_new();

  // Hoja 1: Facturas
  const wsF = XLSX.utils.aoa_to_sheet([
    ['referencia_externa','contrato_numero','periodo_inicio','periodo_fin',
     'regimen','tipo_operacion_ss','tipo_cobertura','asignado_a_email'],
    ['REF-001','CNT-2024-001','2026-01-01','2026-01-31',
     'contributivo','SS-CUFE','','facturador@empresa.com'],
  ]);
  wsF['!cols'] = [14,18,14,14,14,14,14,28].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, wsF, 'Facturas');

  // Hoja 2: Pacientes
  const wsP = XLSX.utils.aoa_to_sheet([
    ['referencia_externa','tipo_doc','num_doc','nombre','fecha_nacimiento',
     'sexo','tipo_usuario','cod_municipio','zona_territorial','incapacidad','num_autorizacion'],
    ['REF-001','CC','1234567890','Juan Perez','1990-05-15','M','01','11001','01','NO','AUTH-001'],
  ]);
  wsP['!cols'] = [14,10,14,22,14,8,12,14,16,12,16].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, wsP, 'Pacientes');

  // Hoja 3: Servicios
  const wsS = XLSX.utils.aoa_to_sheet([
    ['referencia_externa','num_doc_paciente','tipo_servicio','codigo_cups','fecha_atencion',
     'cantidad','valor_unitario','diagnostico_principal','diagnostico_rel1','diagnostico_rel2',
     'diagnostico_rel3','num_autorizacion','modalidad_servicio','grupo_servicios','finalidad',
     'causa_motivo','tipo_diagnostico','via_ingreso','concepto_recaudo','valor_moderador',
     'tipo_medicamento','nombre_medicamento','dias_tratamiento','tipo_otro_servicio','nombre_tecnologia',
     'medico_tipo_doc','medico_num_doc','cod_servicio'],
    ['REF-001','1234567890','consulta','890201','2026-01-10',
     1,85000,'J00','','','','AUTH-001','01','01','27','17','01','','','0','','','','','',
     'CC','1110542629','310'],
  ]);
  wsS['!cols'] = [14,14,14,12,16,8,14,18,14,14,14,14,16,14,12,12,14,12,14,12,14,18,14,16,18,14,16,14].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, wsS, 'Servicios');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla_cargue_registros.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ─── POST /api/salud/cargue/preview ──────────────────────────────────────────
router.post('/preview', upload.single('archivo'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) { res.status(400).json({ error: 'Archivo requerido' }); return; }
    const errExt = validarExtensionArchivo(req.file.originalname);
    if (errExt) { res.status(400).json({ error: errExt }); return; }
    const cid  = req.user!.companyId;
    const rows = parseExcel(req.file.buffer);
    const validados = await validarRegistros(rows, cid);

    const resumen = {
      total:       validados.length,
      nuevos:      validados.filter(v => v.accion === 'nuevo' && v.errores.length === 0).length,
      actualizados:validados.filter(v => v.accion === 'actualizar' && v.errores.length === 0).length,
      omitidos:    validados.filter(v => v.accion === 'skip').length,
      con_errores: validados.filter(v => v.errores.length > 0).length,
    };

    res.json({
      resumen,
      registros: validados.map(v => ({
        referencia_externa: v.referencia_externa,
        accion:             v.accion,
        errores:            v.errores,
        advertencias:       v.advertencias,
        paciente_nombre:    v.paciente?.nombre || '',
        paciente_doc:       `${v.paciente?.tipo_doc || ''} ${v.paciente?.num_doc || ''}`.trim(),
        fecha_atencion:     v.servicios_paciente[0] ? dateStr(v.servicios_paciente[0].fecha_atencion) : '',
        asignado_a:         v.asignado_user?.name || v.factura?.asignado_a_email || '',
      })),
    });
  } catch (e) {
    console.error('[cargue preview]', e);
    res.status(500).json({ error: 'Error procesando archivo', detail: e instanceof Error ? e.message : String(e) });
  }
});

// ─── POST /api/salud/cargue/confirmar ────────────────────────────────────────
router.post('/confirmar', upload.single('archivo'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) { res.status(400).json({ error: 'Archivo requerido' }); return; }
    const errExt = validarExtensionArchivo(req.file.originalname);
    if (errExt) { res.status(400).json({ error: errExt }); return; }
    const cid      = req.user!.companyId;
    const nombre   = req.file.originalname;
    const rows     = parseExcel(req.file.buffer);
    const validados = await validarRegistros(rows, cid);

    const loteRepo   = AppDataSource.getRepository(LoteCargue);
    const regRepo    = AppDataSource.getRepository(RegistroCargue);
    const facRepo    = AppDataSource.getRepository(FacturaSalud);
    const servRepo   = AppDataSource.getRepository(ServicioSalud);

    // SAL-021: código de servicio (habilitación REPS) por codigo_cups, desde el
    // catálogo de servicios de la empresa — se resuelve una sola vez para todo
    // el lote (no por fila) y se usa como respaldo si la fila no trae su propio
    // cod_servicio.
    const catalogoServicios = await servRepo.find({ where: { company_id: cid } });
    const codServicioPorCups: Record<string, string> = {};
    for (const s of catalogoServicios) {
      if (s.cod_servicio) codServicioPorCups[s.codigo_cups] = s.cod_servicio;
    }

    // Crear lote
    const lote = await loteRepo.save(loteRepo.create({
      company_id:       cid,
      nombre_archivo:   nombre,
      total_registros:  validados.length,
      created_by_user_id: req.user!.id,
      created_by_name:    req.user!.name,
    }));

    let nuevos = 0, actualizados = 0, errores = 0;

    for (const v of validados) {
      if (v.accion === 'skip') continue;
      if (v.errores.length > 0) {
        // Guardar registro con error para visibilidad
        await regRepo.save(regRepo.create({
          company_id:         cid,
          lote_id:            lote.id,
          referencia_externa: v.referencia_externa || `ERROR-${Date.now()}`,
          status:             'error',
          error_detalle:      v.errores.join(' | '),
          paciente_nombre:    v.paciente?.nombre,
          paciente_tipo_doc:  v.paciente?.tipo_doc,
          paciente_num_doc:   v.paciente?.num_doc,
          datos_raw:          { factura: v.factura, paciente: v.paciente, servicios: v.servicios_paciente },
        }));
        errores++;
        continue;
      }

      const p = v.paciente;
      const fechaAtencion = v.servicios_paciente[0] ? dateStr(v.servicios_paciente[0].fecha_atencion) : undefined;

      // Build pacientes_json for FacturaSalud
      const pacientesJson = JSON.stringify([{
        tipoDocumentoIdentificacion: p.tipo_doc,
        numDocumentoIdentificacion:  p.num_doc,
        tipoUsuario:                 p.tipo_usuario,
        fechaNacimiento:             dateStr(p.fecha_nacimiento),
        codSexo:                     p.sexo,
        codMunicipioResidencia:      p.cod_municipio,
        codZonaTerritorialResidencia:p.zona_territorial,
        incapacidad:                 p.incapacidad,
        nombre:                      p.nombre,
        numAutorizacion:             p.num_autorizacion || undefined,
        servicios: buildServicios(v.servicios_paciente, p, codServicioPorCups),
      }]);

      const totalFactura = v.servicios_paciente.reduce((s, sv) => s + num(sv.cantidad) * num(sv.valor_unitario), 0);

      if (v.accion === 'nuevo') {
        const fac = await facRepo.save(facRepo.create({
          company_id:          cid,
          tipo:                'evento',
          eps_id:              v.eps_id,
          contrato_id:         v.contrato_id,
          periodo_inicio:      v.factura.periodo_inicio,
          periodo_fin:         v.factura.periodo_fin,
          regimen:             (v.factura.regimen || 'contributivo') as any,
          tipo_operacion_ss:   (v.factura.tipo_operacion_ss || 'SS-CUFE') as any,
          tipo_cobertura:      v.factura.tipo_cobertura || undefined,
          issue_date:          new Date().toISOString().slice(0, 10),
          status:              'pendiente_cierre',
          subtotal:            totalFactura,
          tax_total:           0,
          total:               totalFactura,
          currency:            'COP',
          asignado_a_user_id:  v.asignado_user!.id,
          asignado_a_user_name:v.asignado_user!.name,
          lote_id:             lote.id,
          referencia_externa:  v.referencia_externa,
          pacientes_json:      pacientesJson,
          created_by_user_id:  req.user!.id,
          created_by_name:     req.user!.name,
        }));

        await regRepo.save(regRepo.create({
          company_id:          cid,
          lote_id:             lote.id,
          factura_salud_id:    fac.id,
          referencia_externa:  v.referencia_externa,
          asignado_a_user_id:  v.asignado_user!.id,
          asignado_a_user_name:v.asignado_user!.name,
          status:              'pendiente',
          paciente_nombre:     p.nombre,
          paciente_tipo_doc:   p.tipo_doc,
          paciente_num_doc:    p.num_doc,
          fecha_atencion:      fechaAtencion,
          datos_raw:           { factura: v.factura, paciente: v.paciente, servicios: v.servicios_paciente },
        }));
        nuevos++;

      } else {
        // Actualizar registro existente y su factura
        const existing = await regRepo.findOne({ where: { company_id: cid, referencia_externa: v.referencia_externa } });
        if (existing) {
          existing.asignado_a_user_id  = v.asignado_user!.id;
          existing.asignado_a_user_name= v.asignado_user!.name;
          existing.lote_id             = lote.id;
          existing.paciente_nombre     = p.nombre;
          existing.paciente_tipo_doc   = p.tipo_doc;
          existing.paciente_num_doc    = p.num_doc;
          existing.fecha_atencion      = fechaAtencion;
          existing.datos_raw           = { factura: v.factura, paciente: v.paciente, servicios: v.servicios_paciente };
          await regRepo.save(existing);

          if (existing.factura_salud_id) {
            await facRepo.update(existing.factura_salud_id, {
              asignado_a_user_id:  v.asignado_user!.id,
              asignado_a_user_name:v.asignado_user!.name,
              pacientes_json:      pacientesJson,
              subtotal:            totalFactura,
              total:               totalFactura,
              contrato_id:         v.contrato_id,
              eps_id:              v.eps_id,
              periodo_inicio:      v.factura.periodo_inicio,
              periodo_fin:         v.factura.periodo_fin,
            });
          }
          actualizados++;
        }
      }
    }

    // Actualizar contadores del lote
    await loteRepo.update(lote.id, { registros_nuevos: nuevos, registros_actualizados: actualizados, registros_con_error: errores });

    res.status(201).json({ lote_id: lote.id, nuevos, actualizados, errores, omitidos: validados.filter(v => v.accion === 'skip').length });
  } catch (e) {
    console.error('[cargue confirmar]', e);
    res.status(500).json({ error: 'Error confirmando cargue', detail: e instanceof Error ? e.message : String(e) });
  }
});

function buildServicios(
  svs: RowServicio[],
  p: RowPaciente,
  // SAL-021: código de servicio (habilitación REPS) por codigo_cups, tomado del
  // catálogo de servicios de la empresa (ServicioSalud.cod_servicio). Una fila
  // puede sobreescribirlo con su propia columna cod_servicio si trae un valor.
  codServicioPorCups: Record<string, string> = {},
) {
  const consultas: unknown[]=[],procedimientos: unknown[]=[],medicamentos: unknown[]=[],otros: unknown[]=[];
  for (const sv of svs) {
    const tipo = str(sv.tipo_servicio).toLowerCase();
    const codServicioRaw = str(sv.cod_servicio) || codServicioPorCups[str(sv.codigo_cups)] || '';
    const codServicio = codServicioRaw && !isNaN(Number(codServicioRaw)) ? Number(codServicioRaw) : undefined;
    // SAL-019: el documento del servicio debe ser el del MÉDICO tratante, no el
    // del paciente. Si la fila trae medico_tipo_doc/medico_num_doc se usa ese;
    // si no, se conserva el comportamiento anterior (documento del paciente) por
    // compatibilidad con cargues que aún no diligencian esta columna nueva.
    const medicoTipoDoc = str(sv.medico_tipo_doc);
    const medicoNumDoc  = str(sv.medico_num_doc);
    const base = {
      tipoDocumentoIdentificacion: medicoNumDoc ? (medicoTipoDoc || 'CC') : p.tipo_doc,
      numDocumentoIdentificacion:  medicoNumDoc || p.num_doc,
      numAutorizacion:             str(sv.num_autorizacion) || str(p.num_autorizacion) || undefined,
      vrServicio:                  num(sv.cantidad) * num(sv.valor_unitario),
      conceptoRecaudo:             str(sv.concepto_recaudo) || undefined,
      valorPagoModerador:          num(sv.valor_moderador) || undefined,
      codDiagnosticoPrincipal:     str(sv.diagnostico_principal),
    };
    if (tipo === 'consulta' || tipo === 'consultas' || tipo === 'urgencias') {
      consultas.push({ ...base, codConsulta: str(sv.codigo_cups),
        // SAL-005: normalizar con dateStr (igual que fecha_nacimiento) — antes se
        // usaba el valor crudo de la celda y una fecha dd/mm/aaaa mal interpretada
        // por Excel llegaba como serial numérico (ej. 46225) hasta el RIPS.
        fechaInicioAtencion: dateStr(sv.fecha_atencion),
        modalidadGrupoServicioTecSal: str(sv.modalidad_servicio),
        grupoServicios: str(sv.grupo_servicios),
        codServicio,
        finalidadTecnologiaSalud: str(sv.finalidad),
        causaMotivoAtencion: str(sv.causa_motivo),
        tipoDiagnosticoPrincipal: str(sv.tipo_diagnostico),
        codDiagnosticoRelacionado1: str(sv.diagnostico_rel1) || undefined,
        codDiagnosticoRelacionado2: str(sv.diagnostico_rel2) || undefined,
        codDiagnosticoRelacionado3: str(sv.diagnostico_rel3) || undefined,
      });
    } else if (tipo === 'procedimiento' || tipo === 'procedimientos') {
      procedimientos.push({ ...base, codProcedimiento: str(sv.codigo_cups),
        fechaInicioAtencion: dateStr(sv.fecha_atencion),
        viaIngresoServicioSalud: str(sv.via_ingreso),
        modalidadGrupoServicioTecSal: str(sv.modalidad_servicio),
        grupoServicios: str(sv.grupo_servicios),
        codServicio,
        finalidadTecnologiaSalud: str(sv.finalidad),
        codDiagnosticoRelacionado: str(sv.diagnostico_rel1) || undefined,
      });
    } else if (tipo === 'medicamento' || tipo === 'medicamentos') {
      medicamentos.push({ ...base, codTecnologiaSalud: str(sv.codigo_cups),
        nomTecnologiaSalud: str(sv.nombre_medicamento),
        fechaDispensAdmon: dateStr(sv.fecha_atencion),
        tipoMedicamento: str(sv.tipo_medicamento),
        cantidadMedicamento: num(sv.cantidad),
        diasTratamiento: num(sv.dias_tratamiento) || undefined,
        vrUnitMedicamento: num(sv.valor_unitario),
        codDiagnosticoRelacionado: str(sv.diagnostico_rel1) || undefined,
      });
    } else {
      otros.push({ ...base, codTecnologiaSalud: str(sv.codigo_cups),
        nomTecnologiaSalud: str(sv.nombre_tecnologia),
        fechaSuministroTecnologia: dateStr(sv.fecha_atencion),
        tipoOS: str(sv.tipo_otro_servicio),
        cantidadOS: num(sv.cantidad),
        vrUnitOS: num(sv.valor_unitario),
        codDiagnosticoRelacionado: str(sv.diagnostico_rel1) || undefined,
      });
    }
  }
  return { consultas, procedimientos, medicamentos, otrosServicios: otros };
}

// ─── GET /api/salud/cargue/lotes ─────────────────────────────────────────────
router.get('/lotes', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid   = req.user!.companyId;
    const lotes = await AppDataSource.getRepository(LoteCargue)
      .find({ where: { company_id: cid }, order: { created_at: 'DESC' }, take: 50 });
    res.json(lotes);
  } catch { res.status(500).json({ error: 'Error listando lotes' }); }
});

// ─── GET /api/salud/cargue/lotes/:id ─────────────────────────────────────────
router.get('/lotes/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const lote = await AppDataSource.getRepository(LoteCargue)
      .findOne({ where: { id: req.params.id, company_id: cid } });
    if (!lote) { res.status(404).json({ error: 'Lote no encontrado' }); return; }
    const registros = await AppDataSource.getRepository(RegistroCargue)
      .find({ where: { lote_id: lote.id, company_id: cid }, order: { created_at: 'ASC' } });
    res.json({ ...lote, registros });
  } catch { res.status(500).json({ error: 'Error cargando lote' }); }
});

// ─── GET /api/salud/cargue/mis-pendientes ────────────────────────────────────
// Para el usuario asignado: sus registros pendientes con datos de display.
// Auto-cierra registros cuya factura ya fue aprobada (corrección de datos históricos).
router.get('/mis-pendientes', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const uid = req.user!.id;
    const rcRepo      = AppDataSource.getRepository(RegistroCargue);
    const facturaRepo = AppDataSource.getRepository(FacturaSalud);

    const registros = await rcRepo.find({
      where: { company_id: cid, asignado_a_user_id: uid, status: 'pendiente' },
      order: { fecha_atencion: 'ASC' },
    });

    // Detectar y cerrar registros cuya factura ya fue aprobada (por si el trigger anterior no corrió)
    const toClose: RegistroCargue[] = [];
    for (const r of registros) {
      if (r.factura_salud_id) {
        const f = await facturaRepo.findOne({ where: { id: r.factura_salud_id }, select: ['id', 'status'] as any });
        if (f && f.status === 'aprobada') {
          r.status = 'cerrada';
          toClose.push(r);
        }
      }
    }
    if (toClose.length > 0) await rcRepo.save(toClose);

    res.json(registros.filter(r => r.status === 'pendiente'));
  } catch { res.status(500).json({ error: 'Error cargando pendientes' }); }
});

// ─── GET /api/salud/cargue/pendientes/export?lote_id= ────────────────────────
router.get('/pendientes/export', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid    = req.user!.companyId;
    const loteId = req.query['lote_id'] as string | undefined;

    const qb = AppDataSource.getRepository(RegistroCargue)
      .createQueryBuilder('r')
      .where('r.company_id = :cid', { cid })
      .andWhere('r.status = :s', { s: 'pendiente' });
    if (loteId) qb.andWhere('r.lote_id = :loteId', { loteId });

    const registros = await qb.orderBy('r.fecha_atencion', 'ASC').getMany();

    const wb = XLSX.utils.book_new();
    const data = [
      ['Referencia','Paciente','Tipo Doc','Núm Doc','Fecha Atención','Asignado a','Estado'],
      ...registros.map(r => [
        r.referencia_externa,
        r.paciente_nombre || '',
        r.paciente_tipo_doc || '',
        r.paciente_num_doc || '',
        r.fecha_atencion || '',
        r.asignado_a_user_name || '',
        r.status,
      ]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [16,24,10,16,14,22,12].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, 'Pendientes');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="registros_pendientes.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch { res.status(500).json({ error: 'Error exportando pendientes' }); }
});

// PATCH /api/salud/cargue-registros/:id/cc-sede — asigna centro de costo y sede
// a un registro cargado (y a su FacturaSalud vinculada, si ya existe). Se valida
// contra el contrato de la factura del registro (un contrato puede permitir varias
// ciudades/sedes; aqui se elige UNA de cada para este registro puntual).
router.patch('/:id/cc-sede', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { centro_costo_id, sede_id } = req.body as Record<string, string>;
    if (!centro_costo_id) { res.status(400).json({ error: 'El centro de costo es obligatorio' }); return; }
    if (!sede_id) { res.status(400).json({ error: 'La sede es obligatoria' }); return; }

    const regRepo = AppDataSource.getRepository(RegistroCargue);
    const registro = await regRepo.findOne({ where: { id: req.params.id, company_id: cid } });
    if (!registro) { res.status(404).json({ error: 'Registro no encontrado' }); return; }

    const facRepo = AppDataSource.getRepository(FacturaSalud);
    const factura = registro.factura_salud_id
      ? await facRepo.findOne({ where: { id: registro.factura_salud_id } })
      : null;

    if (factura?.contrato_id) {
      const contrato = await AppDataSource.getRepository(ContratoSalud)
        .findOne({ where: { id: factura.contrato_id }, relations: ['centros_costo', 'sedes'] });
      if (contrato?.centros_costo?.length && !contrato.centros_costo.some(c => c.id === centro_costo_id)) {
        res.status(400).json({ error: 'El centro de costo seleccionado no está habilitado para el contrato de este registro' });
        return;
      }
      if (contrato?.sedes?.length && !contrato.sedes.some(s => s.id === sede_id)) {
        res.status(400).json({ error: 'La sede seleccionada no está habilitada para el contrato de este registro' });
        return;
      }
    }

    registro.centro_costo_id = centro_costo_id;
    registro.sede_id = sede_id;
    await regRepo.save(registro);

    if (factura) {
      factura.centro_costo_id = centro_costo_id;
      factura.punto_pago_sede_id = sede_id;
      await facRepo.save(factura);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error asignando centro de costo y sede', detail: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
