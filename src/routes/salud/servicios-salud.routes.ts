import { Router, Response } from 'express';
import * as XLSX from 'xlsx-js-style';
import multer from 'multer';
import { AppDataSource } from '../../config/database';
import { ServicioSalud } from '../../entities/salud/ServicioSalud';
import { ContratoServicio } from '../../entities/salud/ContratoServicio';
import { ContratoSalud } from '../../entities/salud/ContratoSalud';
import { Eps } from '../../entities/salud/Eps';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';

const router  = Router();
const upload  = multer({ storage: multer.memoryStorage() });
router.use(authMiddleware);

const sRepo  = () => AppDataSource.getRepository(ServicioSalud);
const csRepo = () => AppDataSource.getRepository(ContratoServicio);
const cRepo  = () => AppDataSource.getRepository(ContratoSalud);

/**
 * Parsea un valor monetario proveniente de una celda de Excel, tolerando el
 * formato colombiano de miles/decimales (ej: "1.500.000" o "1.500.000,50").
 * `parseFloat` directo trunca ese formato silenciosamente (interpreta el punto
 * como separador decimal, dando 1.5 en vez de 1500000) — hallazgo #49.
 */
function parseNumeroExcel(valor: unknown): number {
  if (valor === null || valor === undefined || valor === '') return 0;
  if (typeof valor === 'number') return valor;
  let s = String(valor).trim().replace(/[^\d.,-]/g, '');
  if (!s) return 0;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // Ambos presentes: el que aparece último es el separador decimal.
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1) {
    const decimales = s.length - lastComma - 1;
    s = decimales <= 2 ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (lastDot > -1) {
    const cantidadPuntos = (s.match(/\./g) || []).length;
    const decimales = s.length - lastDot - 1;
    // Más de un punto → todos son separadores de miles (ej "1.500.000").
    // Un solo punto con exactamente 3 dígitos después → también miles
    // colombianos (ej "1.500" = 1500), no decimal.
    if (cantidadPuntos > 1 || decimales === 3) s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// ── GET /api/salud/servicios?page=1&limit=50&q=&categoria=&activo=
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { page = '1', limit = '50', q = '', categoria, activo } = req.query as Record<string, string>;
    const cid = req.user!.companyId;

    const qb = sRepo().createQueryBuilder('s')
      .where('s.company_id = :cid', { cid })
      .orderBy('s.categoria', 'ASC')
      .addOrderBy('s.codigo_cups', 'ASC')
      .skip((+page - 1) * +limit)
      .take(+limit);

    if (q)         qb.andWhere('(s.codigo_cups LIKE :q OR s.nombre LIKE :q)', { q: `%${q}%` });
    if (categoria) qb.andWhere('s.categoria = :categoria', { categoria });
    if (activo !== undefined) qb.andWhere('s.activo = :activo', { activo: activo === 'true' });

    const [items, total] = await qb.getManyAndCount();
    res.json({ items, total, page: +page, limit: +limit });
  } catch { res.status(500).json({ error: 'Error listando servicios' }); }
});

// ── POST /api/salud/servicios  (crear individual)
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const dup = await sRepo().findOne({ where: { codigo_cups: req.body.codigo_cups, company_id: cid } });
    if (dup) { res.status(409).json({ error: `Ya existe el código CUPS ${req.body.codigo_cups}` }); return; }
    const item = sRepo().create({ ...req.body, company_id: cid });
    await sRepo().save(item);
    res.status(201).json(item);
  } catch { res.status(500).json({ error: 'Error creando servicio' }); }
});

// ── PUT /api/salud/servicios/:id
router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await sRepo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!item) { res.status(404).json({ error: 'Servicio no encontrado' }); return; }
    sRepo().merge(item, req.body);
    await sRepo().save(item);
    res.json(item);
  } catch { res.status(500).json({ error: 'Error actualizando servicio' }); }
});

// ── DELETE /api/salud/servicios/:id
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await sRepo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!item) { res.status(404).json({ error: 'Servicio no encontrado' }); return; }
    await sRepo().remove(item);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Error eliminando servicio' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CARGUES EXCEL
// ─────────────────────────────────────────────────────────────────────────────

function readSheet(buffer: Buffer): Record<string, unknown>[] {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: '' }) as Record<string, unknown>[];
}

/**
 * POST /api/salud/servicios/excel/maestro
 * Columnas: codigo_cups, nombre, categoria, descripcion, valor_base
 * Crea o actualiza el catálogo base de servicios.
 */
router.post('/excel/maestro', upload.single('file'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) { res.status(400).json({ error: 'Archivo requerido' }); return; }
    const cid  = req.user!.companyId;
    const rows = readSheet(req.file.buffer);
    let created = 0, updated = 0, errors: string[] = [];

    for (const row of rows) {
      const codigo = String(row['codigo_cups'] || '').trim().toUpperCase();
      const nombre = String(row['nombre'] || '').trim();
      const cat    = String(row['categoria'] || '').trim();

      if (!codigo || !nombre || !cat) {
        errors.push(`Fila sin codigo_cups/nombre/categoria: ${JSON.stringify(row)}`);
        continue;
      }

      const validCats = ['consultas', 'procedimientos', 'medicamentos', 'otrosServicios'];
      if (!validCats.includes(cat)) {
        errors.push(`Categoría inválida "${cat}" para CUPS ${codigo}. Válidas: ${validCats.join(', ')}`);
        continue;
      }

      const existing = await sRepo().findOne({ where: { codigo_cups: codigo, company_id: cid } });
      if (existing) {
        existing.nombre      = nombre;
        existing.categoria   = cat as import('../../entities/salud/ServicioSalud').CategoriaRips;
        existing.descripcion = String(row['descripcion'] || '').trim() || existing.descripcion;
        existing.valor_base  = parseNumeroExcel(row['valor_base']) || existing.valor_base;
        await sRepo().save(existing);
        updated++;
      } else {
        await sRepo().save(sRepo().create({
          company_id:  cid,
          codigo_cups: codigo,
          nombre,
          categoria:   cat as import('../../entities/salud/ServicioSalud').CategoriaRips,
          descripcion: String(row['descripcion'] || '').trim() || undefined,
          valor_base:  parseNumeroExcel(row['valor_base']) || 0,
          activo:      true,
        }));
        created++;
      }
    }

    res.json({ ok: true, created, updated, errors });
  } catch (e: unknown) {
    res.status(500).json({ error: `Error procesando Excel: ${(e as Error).message}` });
  }
});

/**
 * POST /api/salud/servicios/excel/asignar
 *
 * Acepta DOS formatos de columnas en el mismo Excel, para poder reutilizar
 * tal cual el mismo archivo maestro que llega de las EPS (ver Cambios/50):
 *   - Formato maestro (recomendado): NIT, CODIGO CONTRATO, CUPS/CUMS, VALOR
 *     — más EPS, PROGRAMA, TIPO CONTRATO, DESCRIPCION, Correo Notificador FE
 *     si vienen, se ignoran (son de referencia, no se necesitan para asignar).
 *     Con CODIGO CONTRATO se asigna al contrato exacto — necesario porque una
 *     misma EPS puede tener varios contratos con tarifas distintas para el
 *     mismo código (confirmado con datos reales: SOS EPS tiene 4 contratos
 *     con precios distintos para el mismo CUPS).
 *   - Formato corto (compatibilidad con lo que ya existía): codigo_cups,
 *     nit_eps, valor_acordado. Sin un contrato específico por fila, se
 *     asigna a TODOS los contratos activos de esa EPS — solo seguro cuando
 *     esa EPS tiene un único contrato.
 * En ambos casos, si se seleccionó una EPS/Contrato en el modal, esa
 * selección manual sigue funcionando igual que antes y manda sobre lo que
 * traiga el archivo.
 * El servicio (CUPS/CUM) debe existir YA en el submódulo de Servicios
 * (cargado antes con "Cargar maestro") — esta ruta nunca crea servicios
 * nuevos, solo los enlaza a un contrato.
 */
router.post('/excel/asignar', upload.single('file'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) { res.status(400).json({ error: 'Archivo requerido' }); return; }
    const cid  = req.user!.companyId;
    const rows = readSheet(req.file.buffer);
    let assigned = 0, skipped = 0, errors: string[] = [];

    // Puede venir un contrato_id directo (desde el selector UI) o eps_nit (desde la columna del Excel)
    const defaultNit       = String((req.body as Record<string, string>).eps_nit || '').trim();
    const contratoIdDirect = String((req.body as Record<string, string>).contrato_id || '').trim();

    // Si viene contrato_id directo, verificar que existe
    let contratoDirecto: ContratoSalud | null = null;
    if (contratoIdDirect) {
      contratoDirecto = await cRepo().findOne({ where: { id: contratoIdDirect, company_id: cid } });
      if (!contratoDirecto) { res.status(400).json({ error: 'Contrato seleccionado no encontrado' }); return; }
    }

    for (const row of rows) {
      const codigo = String(row['CUPS/CUMS'] ?? row['codigo_cups'] ?? '').trim().toUpperCase();
      if (!codigo) { errors.push(`Fila sin CUPS/CUMS: ${JSON.stringify(row)}`); continue; }

      // Buscar servicio — SOLO si ya está en el catálogo (no se crea aquí, ver Cargar maestro)
      const servicio = await sRepo().findOne({ where: { codigo_cups: codigo, company_id: cid } });
      if (!servicio) { errors.push(`CUPS/CUM ${codigo} no existe en el submódulo de Servicios — súbelo primero con "Cargar maestro".`); continue; }

      const valorCrudo    = row['VALOR'] ?? row['valor_acordado'];
      const valorAcordado = valorCrudo !== undefined && valorCrudo !== '' ? parseNumeroExcel(valorCrudo) : undefined;

      // Determinar contrato(s) destino
      let contratos: ContratoSalud[];
      const codigoContrato = String(row['CODIGO CONTRATO'] ?? row['codigo_contrato'] ?? '').trim();

      if (contratoDirecto) {
        contratos = [contratoDirecto];
      } else {
        const nit_eps = String(row['NIT'] ?? row['nit_eps'] ?? '').trim() || defaultNit;
        if (!nit_eps) { errors.push(`Fila sin NIT: ${JSON.stringify(row)}`); continue; }
        const eps = await AppDataSource.getRepository(Eps).findOne({ where: { nit: nit_eps, company_id: cid } });
        if (!eps) { errors.push(`EPS con NIT ${nit_eps} no encontrada`); continue; }

        if (codigoContrato) {
          // Contrato exacto — evita mandar el mismo valor a otro contrato de la misma EPS.
          const contratoExacto = await cRepo().findOne({ where: { eps_id: eps.id, company_id: cid, numero: codigoContrato } });
          if (!contratoExacto) { errors.push(`Contrato "${codigoContrato}" no existe para la EPS NIT ${nit_eps}`); continue; }
          contratos = [contratoExacto];
        } else {
          contratos = await cRepo().find({ where: { eps_id: eps.id, company_id: cid, estado: 'activo' } });
          if (contratos.length === 0) { skipped++; continue; }
        }
      }

      for (const contrato of contratos) {
        const existing = await csRepo().findOne({ where: { contrato_id: contrato.id, servicio_id: servicio.id } });
        if (existing) {
          existing.habilitado = true;
          if (valorAcordado !== undefined) existing.valor_acordado = valorAcordado;
          await csRepo().save(existing);
        } else {
          await csRepo().save(csRepo().create({
            company_id:     cid,
            contrato_id:    contrato.id,
            servicio_id:    servicio.id,
            valor_acordado: valorAcordado,
            habilitado:     true,
          }));
          assigned++;
        }
      }
    }

    res.json({ ok: true, assigned, skipped, errors });
  } catch (e: unknown) {
    res.status(500).json({ error: `Error procesando Excel: ${(e as Error).message}` });
  }
});

/**
 * POST /api/salud/servicios/excel/desactivar
 * Columnas: codigo_cups, nit_eps
 * Inactiva esos servicios en los contratos activos de esa EPS.
 */
router.post('/excel/desactivar', upload.single('file'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) { res.status(400).json({ error: 'Archivo requerido' }); return; }
    const cid  = req.user!.companyId;
    const rows = readSheet(req.file.buffer);
    let deactivated = 0, errors: string[] = [];

    const defaultNitDes    = String((req.body as Record<string, string>).eps_nit || '').trim();
    const contratoIdDesDirect = String((req.body as Record<string, string>).contrato_id || '').trim();

    let contratoDesDirecto: ContratoSalud | null = null;
    if (contratoIdDesDirect) {
      contratoDesDirecto = await cRepo().findOne({ where: { id: contratoIdDesDirect, company_id: cid } });
      if (!contratoDesDirecto) { res.status(400).json({ error: 'Contrato seleccionado no encontrado' }); return; }
    }

    for (const row of rows) {
      const codigo = String(row['codigo_cups'] || '').trim().toUpperCase();
      if (!codigo) { errors.push(`Fila sin codigo_cups: ${JSON.stringify(row)}`); continue; }

      const servicio = await sRepo().findOne({ where: { codigo_cups: codigo, company_id: cid } });
      if (!servicio) { errors.push(`CUPS ${codigo} no existe`); continue; }

      let contratosD: ContratoSalud[];
      if (contratoDesDirecto) {
        contratosD = [contratoDesDirecto];
      } else {
        const nit_eps = String(row['nit_eps'] || '').trim() || defaultNitDes;
        if (!nit_eps) { errors.push(`Fila sin nit_eps: ${JSON.stringify(row)}`); continue; }
        const eps = await AppDataSource.getRepository(Eps).findOne({ where: { nit: nit_eps, company_id: cid } });
        if (!eps) { errors.push(`EPS NIT ${nit_eps} no encontrada`); continue; }
        contratosD = await cRepo().find({ where: { eps_id: eps.id, company_id: cid } });
      }

      for (const contrato of contratosD) {
        const cs = await csRepo().findOne({ where: { contrato_id: contrato.id, servicio_id: servicio.id } });
        if (cs) { cs.habilitado = false; await csRepo().save(cs); deactivated++; }
      }
    }

    res.json({ ok: true, deactivated, errors });
  } catch (e: unknown) {
    res.status(500).json({ error: `Error procesando Excel: ${(e as Error).message}` });
  }
});

// ── GET /api/salud/servicios/plantilla/:tipo  ─────────────────────────────────
router.get('/plantilla/:tipo', async (req: AuthRequest, res: Response): Promise<void> => {
  const tipo = req.params.tipo as 'maestro' | 'asignar' | 'desactivar' | 'rips';

  const templates: Record<string, { cols: string[]; sample: Record<string, unknown>[] }> = {
    maestro: {
      cols: ['codigo_cups', 'nombre', 'categoria', 'valor_base', 'descripcion'],
      sample: [
        { codigo_cups: '890101', nombre: 'CONSULTA MEDICINA GENERAL', categoria: 'consultas', valor_base: 50000, descripcion: 'Descripción opcional' },
        { codigo_cups: '890201', nombre: 'CONSULTA MEDICINA ESPECIALIZADA', categoria: 'consultas', valor_base: 80000, descripcion: '' },
        { codigo_cups: '903851', nombre: 'HEMOGRAMA IV', categoria: 'procedimientos', valor_base: 25000, descripcion: '' },
        { codigo_cups: 'C01AA05', nombre: 'DIGOXINA 0.25MG TABLETA', categoria: 'medicamentos', valor_base: 500, descripcion: '' },
      ],
    },
    asignar: {
      cols: ['NIT', 'CODIGO CONTRATO', 'CUPS/CUMS', 'VALOR'],
      sample: [
        { NIT: '800251440', 'CODIGO CONTRATO': '01-01-08-00110-2026', 'CUPS/CUMS': '890101', VALOR: 55000 },
        { NIT: '800251440', 'CODIGO CONTRATO': '01-01-08-00110-2026', 'CUPS/CUMS': '890201', VALOR: '' },
      ],
    },
    desactivar: {
      cols: ['codigo_cups', 'nit_eps'],
      sample: [
        { codigo_cups: '890101', nit_eps: '800251440' },
      ],
    },
  };

  // ── Plantilla RIPS multi-hoja ──────────────────────────────────────────
  if (tipo === 'rips') {
    const wbRips = XLSX.utils.book_new();
    const sheets: Record<string, { cols: string[]; sample: Record<string, unknown> }> = {
      Factura: {
        cols: ['numDocumentoIdObligado', 'numFactura', 'tipoNota', 'numNota'],
        sample: { numDocumentoIdObligado: '900123456', numFactura: 'SETP994000001', tipoNota: '', numNota: '' },
      },
      Usuarios: {
        cols: ['Usuario','tipoDocumentoIdentificacion','numDocumentoIdentificacion','tipoUsuario','fechaNacimiento','codSexo','codPaisResidencia','codMunicipioResidencia','codZonaTerritorialResidencia','incapacidad','consecutivo','codPaisOrigen'],
        sample: { Usuario:'CC12345678','tipoDocumentoIdentificacion':'CC','numDocumentoIdentificacion':12345678,'tipoUsuario':'01','fechaNacimiento':'1990-01-15','codSexo':'H','codPaisResidencia':170,'codMunicipioResidencia':'11001','codZonaTerritorialResidencia':'1','incapacidad':'NO','consecutivo':1,'codPaisOrigen':'170' },
      },
      Consultas: {
        cols: ['Usuario','codPrestador','fechaInicioAtencion','numAutorizacion','codConsulta','modalidadGrupoServicioTecSal','grupoServicios','codServicio','finalidadTecnologiaSalud','causaMotivoAtencion','codDiagnosticoPrincipal','codDiagnosticoRelacionado1','codDiagnosticoRelacionado2','codDiagnosticoRelacionado3','tipoDiagnosticoPrincipal','tipoDocumentoIdentificacion','numDocumentoIdentificacion','vrServicio','conceptoRecaudo','valorPagoModerador','numFEVPagoModerador','consecutivo'],
        sample: { Usuario:'CC12345678',codPrestador:'050011399101',fechaInicioAtencion:'2026-01-15 08:00',numAutorizacion:'',codConsulta:931001,modalidadGrupoServicioTecSal:'01',grupoServicios:'01',codServicio:739,finalidadTecnologiaSalud:15,causaMotivoAtencion:38,codDiagnosticoPrincipal:'E109',codDiagnosticoRelacionado1:'',codDiagnosticoRelacionado2:'',codDiagnosticoRelacionado3:'',tipoDiagnosticoPrincipal:'03',tipoDocumentoIdentificacion:'CC',numDocumentoIdentificacion:12345678,vrServicio:0,conceptoRecaudo:'05',valorPagoModerador:0,numFEVPagoModerador:'',consecutivo:1 },
      },
      Procedimientos: {
        cols: ['Usuario','codPrestador','fechaInicioAtencion','idMIPRES','numAutorizacion','codProcedimiento','viaIngresoServicioSalud','modalidadGrupoServicioTecSal','grupoServicios','codServicio','finalidadTecnologiaSalud','tipoDocumentoIdentificacion','numDocumentoIdentificacion','codDiagnosticoPrincipal','codDiagnosticoRelacionado','vrServicio','conceptoRecaudo','valorPagoModerador','numFEVPagoModerador','consecutivo'],
        sample: { Usuario:'CC12345678',codPrestador:'050011399101',fechaInicioAtencion:'2026-01-15',idMIPRES:'',numAutorizacion:'',codProcedimiento:998704,viaIngresoServicioSalud:'02',modalidadGrupoServicioTecSal:'01',grupoServicios:'01',codServicio:739,finalidadTecnologiaSalud:16,tipoDocumentoIdentificacion:'CC',numDocumentoIdentificacion:12345678,codDiagnosticoPrincipal:'E109',codDiagnosticoRelacionado:'',vrServicio:0,conceptoRecaudo:'05',valorPagoModerador:0,numFEVPagoModerador:'',consecutivo:1 },
      },
      Medicamentos: {
        cols: ['Usuario','codPrestador','numAutorizacion','idMIPRES','fechaDispensAdmon','codDiagnosticoPrincipal','codDiagnosticoRelacionado','tipoMedicamento','codTecnologiaSalud','nomTecnologiaSalud','concentracionMedicamento','unidadMedida','formaFarmaceutica','unidadMinDispensa','cantidadMedicamento','diasTratamiento','tipoDocumentoIdentificacion','numDocumentoIdentificacion','vrUnitMedicamento','vrServicio','conceptoRecaudo','valorPagoModerador','numFEVPagoModerador','consecutivo'],
        sample: { Usuario:'CC12345678',codPrestador:'050011399101',numAutorizacion:'',idMIPRES:'',fechaDispensAdmon:'2026-01-20',codDiagnosticoPrincipal:'E109',codDiagnosticoRelacionado:'',tipoMedicamento:'01',codTecnologiaSalud:'19915564-6',nomTecnologiaSalud:'GLIMEPIRIDA 4MG',concentracionMedicamento:'',unidadMedida:'',formaFarmaceutica:'',unidadMinDispensa:30,cantidadMedicamento:30,diasTratamiento:30,tipoDocumentoIdentificacion:'CC',numDocumentoIdentificacion:12345678,vrUnitMedicamento:0,vrServicio:0,conceptoRecaudo:'05',valorPagoModerador:0,numFEVPagoModerador:'',consecutivo:1 },
      },
      OtrosServicios: {
        cols: ['Usuario','codPrestador','numAutorizacion','idMIPRES','fechaSuministroTecnologia','tipoOS','codTecnologiaSalud','nomTecnologiaSalud','cantidadOS','tipoDocumentoIdentificacion','numDocumentoIdentificacion','vrUnitOS','vrServicio','conceptoRecaudo','valorPagoModerador','numFEVPagoModerador','consecutivo'],
        sample: { Usuario:'CC12345678',codPrestador:'050011399101',numAutorizacion:'',idMIPRES:'',fechaSuministroTecnologia:'2026-01-10',tipoOS:'01',codTecnologiaSalud:20039206,nomTecnologiaSalud:'TIRAS REACTIVAS GLUCOSA',cantidadOS:200,tipoDocumentoIdentificacion:'CC',numDocumentoIdentificacion:12345678,vrUnitOS:0,vrServicio:0,conceptoRecaudo:'05',valorPagoModerador:0,numFEVPagoModerador:'',consecutivo:1 },
      },
    };
    // Campos opcionales por hoja
    const optionalFields: Record<string, string[]> = {
      Factura:         ['tipoNota', 'numNota'],
      Usuarios:        ['codPaisOrigen'],
      Consultas:       ['numAutorizacion', 'codServicio', 'codDiagnosticoRelacionado1', 'codDiagnosticoRelacionado2', 'codDiagnosticoRelacionado3', 'valorPagoModerador', 'numFEVPagoModerador'],
      Procedimientos:  ['idMIPRES', 'numAutorizacion', 'codServicio', 'codDiagnosticoRelacionado', 'valorPagoModerador', 'numFEVPagoModerador'],
      Medicamentos:    ['numAutorizacion', 'idMIPRES', 'codDiagnosticoRelacionado', 'concentracionMedicamento', 'unidadMedida', 'formaFarmaceutica', 'diasTratamiento', 'valorPagoModerador', 'numFEVPagoModerador'],
      OtrosServicios:  ['numAutorizacion', 'idMIPRES', 'valorPagoModerador', 'numFEVPagoModerador'],
    };

    for (const [name, def2] of Object.entries(sheets)) {
      const ws2 = XLSX.utils.json_to_sheet([def2.sample], { header: def2.cols });
      ws2['!cols'] = def2.cols.map(() => ({ wch: 22 }));

      // Style header row: required = green bg, optional = yellow bg
      const optional = optionalFields[name] || [];
      def2.cols.forEach((col: string, i: number) => {
        const cellAddr = XLSX.utils.encode_cell({ r: 0, c: i });
        if (!ws2[cellAddr]) return;
        const isOpt = optional.includes(col);
        ws2[cellAddr].s = {
          fill:  { fgColor: { rgb: isOpt ? 'FFF9C4' : 'C8E6C9' } },
          font:  { bold: true, color: { rgb: isOpt ? '7B6000' : '1B5E20' } },
          alignment: { horizontal: 'center' },
        };
      });

      // Add a legend row below headers (row index 2, after data row)
      const legendCell = XLSX.utils.encode_cell({ r: 2, c: 0 });
      ws2[legendCell] = {
        v: '🟢 Verde = Obligatorio   🟡 Amarillo = Opcional',
        s: { font: { italic: true, color: { rgb: '555555' } } },
      };
      // Expand sheet range to include legend row
      const range = XLSX.utils.decode_range(ws2['!ref'] || 'A1');
      if (range.e.r < 2) range.e.r = 2;
      ws2['!ref'] = XLSX.utils.encode_range(range);

      XLSX.utils.book_append_sheet(wbRips, ws2, name);
    }
    const buf2 = XLSX.write(wbRips, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Plantilla_RIPS.xlsx"');
    res.send(buf2);
    return;
  }

  const def = templates[tipo];
  if (!def) { res.status(400).json({ error: 'Tipo de plantilla inválido' }); return; }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(def.sample, { header: def.cols });
  ws['!cols'] = def.cols.map(() => ({ wch: 22 }));
  XLSX.utils.book_append_sheet(wb, ws, 'Plantilla');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="plantilla_${tipo}.xlsx"`);
  res.send(buf);
});

// ── GET /api/salud/servicios/:id/contratos
// Devuelve todos los ContratoServicio de un servicio dado, con contrato + EPS cargados
router.get('/:id/contratos', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const servicio = await sRepo().findOne({ where: { id: req.params.id, company_id: cid } });
    if (!servicio) { res.status(404).json({ error: 'Servicio no encontrado' }); return; }

    const items = await csRepo().createQueryBuilder('cs')
      .leftJoinAndSelect('cs.contrato', 'c')
      .leftJoinAndSelect('c.eps', 'eps')
      .where('cs.servicio_id = :id', { id: req.params.id })
      .orderBy('eps.nombre', 'ASC')
      .addOrderBy('c.numero', 'ASC')
      .getMany();

    res.json(items);
  } catch { res.status(500).json({ error: 'Error cargando contratos del servicio' }); }
});

// ── PUT /api/salud/servicios/:id/contratos/:csId
// Actualiza valor_acordado y/o habilitado de una asignación específica
router.put('/:id/contratos/:csId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const servicio = await sRepo().findOne({ where: { id: req.params.id, company_id: cid } });
    if (!servicio) { res.status(404).json({ error: 'Servicio no encontrado' }); return; }

    const cs = await csRepo().findOne({ where: { id: req.params.csId, servicio_id: req.params.id } });
    if (!cs) { res.status(404).json({ error: 'Asignación no encontrada' }); return; }

    const { valor_acordado, habilitado } = req.body as Record<string, unknown>;
    if (valor_acordado !== undefined) {
      cs.valor_acordado = (valor_acordado !== null && valor_acordado !== '')
        ? parseFloat(String(valor_acordado)) : undefined;
    }
    if (habilitado !== undefined) cs.habilitado = Boolean(habilitado);

    await csRepo().save(cs);
    res.json(cs);
  } catch { res.status(500).json({ error: 'Error actualizando asignación' }); }
});

// ── GET /api/salud/servicios/por-contrato/:contratoId  (para el formulario de factura)
router.get('/por-contrato/:contratoId', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const items = await csRepo().createQueryBuilder('cs')
      .leftJoinAndSelect('cs.servicio', 'sv')
      .where('cs.contrato_id = :id', { id: req.params.contratoId })
      .andWhere('cs.habilitado = 1')
      .orderBy('sv.categoria', 'ASC')
      .addOrderBy('sv.codigo_cups', 'ASC')
      .getMany();
    res.json(items);
  } catch { res.status(500).json({ error: 'Error' }); }
});

export default router;
