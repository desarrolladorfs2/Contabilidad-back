/**
 * /api/admin/usuarios  — Gestión de usuarios (solo superadmin y admin)
 * /api/admin/modulos   — Lista de módulos disponibles
 * /api/admin/empresas  — Lista de empresas (solo superadmin)
 */
import { Router, Response } from 'express';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import multer from 'multer';
import XLSX from 'xlsx';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const XS = require('xlsx-js-style');

import { AppDataSource } from '../config/database';
import { User } from '../entities/User';
import { Modulo } from '../entities/Modulo';
import { UsuarioModulo } from '../entities/UsuarioModulo';
import { Company } from '../entities/Company';
import { authMiddleware, requireRole, AuthRequest } from '../middleware/auth.middleware';
import { MODULOS_DEF } from '../seeds/modulos.seed';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.use(authMiddleware, requireRole('superadmin', 'admin'));

// ── Layout de la plantilla ────────────────────────────────────────────────────
// 12 columnas fijas (última = Empresa NIT, solo relevante para superadmin)

const FIXED_COLS = [
  { header: 'Correo electrónico *', key: 'email',            width: 30, example: 'juan.perez@empresa.com' },
  { header: 'Tipo Documento',       key: 'tipo_documento',   width: 14, example: 'CC'                     },
  { header: 'Número Documento *',   key: 'numero_documento', width: 18, example: '1012345678'             },
  { header: 'Primer Nombre *',      key: 'primer_nombre',    width: 16, example: 'Juan'                   },
  { header: 'Segundo Nombre',       key: 'segundo_nombre',   width: 16, example: 'Carlos'                 },
  { header: 'Primer Apellido *',    key: 'primer_apellido',  width: 16, example: 'Pérez'                  },
  { header: 'Segundo Apellido',     key: 'segundo_apellido', width: 16, example: 'García'                 },
  { header: 'Teléfono',             key: 'telefono',         width: 14, example: '3001234567'             },
  { header: 'Acceso desde',         key: 'fecha_inicio',     width: 14, example: ''                       },
  { header: 'Vence el',             key: 'fecha_fin',        width: 14, example: ''                       },
  { header: 'Acción',               key: 'accion',           width: 14, example: 'crear'                  },
  { header: 'Empresa (NIT o nombre)', key: 'empresa_nit',     width: 22, example: ''                       },
  { header: 'Contraseña (opcional)', key: 'password',        width: 20, example: ''                       },
  { header: 'Forzar cambio clave (SI/NO)', key: 'forzar_cambio', width: 16, example: ''                   },
];

// Índices de columnas fijas
const COL_EMAIL   = 0;
const COL_TIPODOC = 1;
const COL_NUMDOC  = 2;
const COL_PNOM    = 3;
const COL_SNOM    = 4;
const COL_PAPEL   = 5;
const COL_SAPEL   = 6;
const COL_TEL     = 7;
const COL_INICIO  = 8;
const COL_FIN     = 9;
const COL_ACCION  = 10;
const COL_EMPRESA = 11;
const COL_PASSWORD = 12;
const COL_FORZAR_CAMBIO = 13;
const FIXED_COUNT = 14;

const GROUP_COLORS: Record<string, [string, string]> = {
  comercial:    ['1D4ED8', 'DBEAFE'],
  compras:      ['6D28D9', 'EDE9FE'],
  salud:        ['DC2626', 'FEE2E2'],
  contabilidad: ['047857', 'D1FAE5'],
  tesoreria:    ['B45309', 'FEF3C7'],
  impuestos:    ['0369A1', 'E0F2FE'],
  reportes:     ['4B5563', 'F3F4F6'],
  configuracion:['374151', 'E5E7EB'],
};

// Columnas de submódulos en el orden de la plantilla
const SUBMODULE_COLS = MODULOS_DEF.flatMap(m =>
  (m.submodulos ?? []).map(s => ({
    codigo: s.codigo,
    nombre: s.nombre,
    padre:  m.codigo,
    color:  GROUP_COLORS[m.codigo] ?? ['374151', 'F3F4F6'] as [string, string],
  }))
);

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeDate(val: unknown): string | undefined {
  if (!val) return undefined;
  const d = new Date(val as string);
  return isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

function buildFullName(p1 = '', p2 = '', a1 = '', a2 = ''): string {
  return [p1, p2, a1, a2].filter(Boolean).join(' ').trim();
}

// Mapa estático codigo-submodulo → codigo-padre, derivado de MODULOS_DEF.
// Se usa como fuente de verdad porque algunos registros históricos en BD
// tienen modulo_padre_id = NULL (insertados antes de que el seed guardara el FK).
const SUBMOD_TO_PADRE: Map<string, string> = new Map(
  MODULOS_DEF.flatMap(p => (p.submodulos ?? []).map(s => [s.codigo, p.codigo]))
);

// ── GET /api/admin/modulos ────────────────────────────────────────────────────
router.get('/modulos', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const repo    = AppDataSource.getRepository(Modulo);
    const modulos = await repo.find({ where: { activo: true }, order: { orden: 'ASC' } });
    res.json(modulos.map(m => ({
      ...m,
      // Derivar el codigo del padre desde MODULOS_DEF para evitar depender del FK en BD
      modulo_padre_codigo: SUBMOD_TO_PADRE.get(m.codigo) ?? null,
    })));
  } catch { res.status(500).json({ error: 'Error obteniendo módulos' }); }
});

// ── GET /api/admin/empresas (solo superadmin) ─────────────────────────────────
router.get('/empresas', async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user!.role !== 'superadmin') {
    res.status(403).json({ error: 'Acceso restringido a superadmin' }); return;
  }
  try {
    const repo = AppDataSource.getRepository(Company);
    const empresas = await repo.find({ where: { activo: true }, order: { name: 'ASC' } });
    res.json(empresas.map(c => ({ id: c.id, nit: c.nit, name: c.name })));
  } catch {
    res.status(500).json({ error: 'Error obteniendo empresas' });
  }
});

// ── GET /api/admin/usuarios/plantilla-excel ──────────────────────────────────
router.get('/usuarios/plantilla-excel', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const wb = XS.utils.book_new();
    const ec = (r: number, c: number): string => XS.utils.encode_cell({ r, c });

    const TOTAL_COLS = FIXED_COLS.length + SUBMODULE_COLS.length;
    const DATA_ROWS  = 30;
    const LAST_ROW   = 2 + DATA_ROWS;

    const ws: Record<string, unknown> = {};
    ws['!ref'] = XS.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: LAST_ROW, c: TOTAL_COLS - 1 } });

    const st = (bg: string, fg = 'FFFFFF', bold = true, sz = 10, wrap = false) => ({
      fill: { fgColor: { rgb: bg } },
      font: { bold, color: { rgb: fg }, sz, name: 'Calibri' },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: wrap },
      border: {
        top:    { style: 'thin', color: { rgb: 'CCCCCC' } },
        bottom: { style: 'thin', color: { rgb: 'CCCCCC' } },
        left:   { style: 'thin', color: { rgb: 'CCCCCC' } },
        right:  { style: 'thin', color: { rgb: 'CCCCCC' } },
      },
    });

    // FILA 0: encabezados de grupo
    const stDatos = st('1E3A5F', 'FFFFFF', true, 11);
    ws[ec(0, 0)] = { v: 'DATOS DEL USUARIO', t: 's', s: stDatos };
    for (let c = 1; c < FIXED_COLS.length; c++) ws[ec(0, c)] = { v: '', t: 's', s: stDatos };

    let colCursor = FIXED_COLS.length;
    for (const m of MODULOS_DEF) {
      const subs = m.submodulos ?? [];
      if (!subs.length) continue;
      const [bg] = GROUP_COLORS[m.codigo] ?? ['374151', 'F3F4F6'];
      const stG  = st(bg, 'FFFFFF', true, 11);
      ws[ec(0, colCursor)] = { v: m.nombre.toUpperCase(), t: 's', s: stG };
      for (let i = 1; i < subs.length; i++) ws[ec(0, colCursor + i)] = { v: '', t: 's', s: stG };
      colCursor += subs.length;
    }

    // FILA 1: nombres de columna
    const stFH = st('2C4A7C', 'FFFFFF', true, 10, true);
    FIXED_COLS.forEach((col, i) => { ws[ec(1, i)] = { v: col.header, t: 's', s: stFH }; });

    SUBMODULE_COLS.forEach((sub, i) => {
      const [bg] = sub.color;
      ws[ec(1, FIXED_COLS.length + i)] = { v: sub.nombre, t: 's', s: st(bg, 'FFFFFF', true, 9, true) };
    });

    // FILA 2: ejemplo
    const stEx = {
      fill: { fgColor: { rgb: 'F1F5F9' } },
      font: { color: { rgb: '94A3B8' }, italic: true, sz: 10, name: 'Calibri' },
      alignment: { horizontal: 'left', vertical: 'center' },
    };
    FIXED_COLS.forEach((col, i) => {
      ws[ec(2, i)] = { v: i === 0 ? `← EJEMPLO — ${col.example}` : col.example, t: 's', s: stEx };
    });
    SUBMODULE_COLS.forEach((sub, i) => {
      const [, lt] = sub.color;
      ws[ec(2, FIXED_COLS.length + i)] = {
        v: i < 3 ? 'SI' : '',
        t: 's',
        s: { fill: { fgColor: { rgb: lt } }, font: { color: { rgb: '94A3B8' }, italic: true, sz: 10, name: 'Calibri' }, alignment: { horizontal: 'center', vertical: 'center' } },
      };
    });

    // FILAS 3+: filas vacías
    for (let r = 3; r <= LAST_ROW; r++) {
      const even = r % 2 === 0;
      FIXED_COLS.forEach((_, i) => {
        ws[ec(r, i)] = {
          v: '', t: 's',
          s: {
            fill: { fgColor: { rgb: even ? 'FFFFFF' : 'F8FAFC' } },
            font: { sz: 10, name: 'Calibri' },
            alignment: { horizontal: i === 0 ? 'left' : 'center', vertical: 'center' },
            border: { bottom: { style: 'hair', color: { rgb: 'E2E8F0' } }, right: { style: 'hair', color: { rgb: 'E2E8F0' } } },
          },
        };
      });
      SUBMODULE_COLS.forEach((sub, i) => {
        const [, lt] = sub.color;
        ws[ec(r, FIXED_COLS.length + i)] = {
          v: '', t: 's',
          s: {
            fill: { fgColor: { rgb: even ? 'FAFAFA' : lt } },
            font: { sz: 10, name: 'Calibri' },
            alignment: { horizontal: 'center', vertical: 'center' },
            border: { bottom: { style: 'hair', color: { rgb: 'E2E8F0' } }, right: { style: 'hair', color: { rgb: 'E2E8F0' } } },
          },
        };
      });
    }

    // Merges
    const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];
    merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: FIXED_COLS.length - 1 } });
    let mStart = FIXED_COLS.length;
    for (const m of MODULOS_DEF) {
      const len = (m.submodulos ?? []).length;
      if (!len) continue;
      if (len > 1) merges.push({ s: { r: 0, c: mStart }, e: { r: 0, c: mStart + len - 1 } });
      mStart += len;
    }
    ws['!merges'] = merges;

    ws['!cols']      = [...FIXED_COLS.map(c => ({ wch: c.width })), ...SUBMODULE_COLS.map(() => ({ wch: 13 }))];
    ws['!rows']      = [{ hpt: 22 }, { hpt: 40 }, { hpt: 16 }];
    ws['!sheetViews'] = [{ state: 'frozen', xSplit: 1, ySplit: 2, topLeftCell: 'B3' }];

    const accionCol       = XS.utils.encode_col(COL_ACCION);
    const tipoDocCol      = XS.utils.encode_col(COL_TIPODOC);
    const forzarCambioCol = XS.utils.encode_col(COL_FORZAR_CAMBIO);
    ws['!dataValidation'] = [
      {
        type: 'list',
        sqref: `${accionCol}3:${accionCol}${LAST_ROW + 1}`,
        formula1: '"crear,actualizar,inactivar,eliminar"',
        showDropDown: false,
        showErrorMessage: true,
        error: 'Use: crear, actualizar, inactivar o eliminar',
        errorTitle: 'Acción no válida',
        errorStyle: 'stop',
        showInputMessage: true,
        promptTitle: 'Acción',
        prompt: 'Seleccione la acción a realizar con este usuario',
      },
      {
        type: 'list',
        sqref: `${tipoDocCol}3:${tipoDocCol}${LAST_ROW + 1}`,
        formula1: '"CC,CE,PP,NIT,TI,RC,PEP,DE"',
        showDropDown: false,
        showErrorMessage: false,
      },
      {
        type: 'list',
        sqref: `${forzarCambioCol}3:${forzarCambioCol}${LAST_ROW + 1}`,
        formula1: '"SI,NO"',
        showDropDown: false,
        showErrorMessage: false,
        showInputMessage: true,
        promptTitle: 'Forzar cambio de clave',
        prompt: 'SI (o vacío) = el usuario debe cambiar la clave en su primer ingreso. NO = puede seguir usando la clave indicada aquí.',
      },
    ];

    XS.utils.book_append_sheet(wb, ws, 'Usuarios');

    // Hoja Referencia
    const wsRef: Record<string, unknown> = {};
    const refRows: [string, string][] = [
      ['GUÍA PARA DILIGENCIAR LA PLANTILLA', ''],
      ['', ''],
      ['📋 CAMPOS OBLIGATORIOS', ''],
      ['Correo electrónico', 'Debe ser único. Ejemplo: juan.perez@empresa.com'],
      ['Número Documento', 'Número de identificación del usuario'],
      ['Primer Nombre', 'Primer nombre del usuario'],
      ['Primer Apellido', 'Primer apellido del usuario'],
      ['', ''],
      ['📋 EMPRESA (NIT o nombre)', ''],
      ['Empresa (NIT o nombre)', 'Solo aplica si quien sube el archivo es superadministrador — un admin normal siempre crea los usuarios en su propia empresa, sin importar lo que diga esta columna (por seguridad). Puede escribirse el NIT o el nombre exacto de la empresa. Si el NIT le pertenece a más de una empresa (puede pasar, ej. una empresa de pruebas y otra de producción con el mismo NIT), escriba el NOMBRE exacto en vez del NIT para no equivocarse de empresa. Dejar vacío = empresa propia del administrador que sube el archivo.'],
      ['', ''],
      ['📋 TIPO DE DOCUMENTO — opciones válidas', ''],
      ['CC',  'Cédula de Ciudadanía'],
      ['CE',  'Cédula de Extranjería'],
      ['PP',  'Pasaporte'],
      ['NIT', 'NIT (empresas o personas jurídicas)'],
      ['TI',  'Tarjeta de Identidad'],
      ['RC',  'Registro Civil'],
      ['PEP', 'Permiso Especial de Permanencia'],
      ['DE',  'Documento Extranjero'],
      ['', ''],
      ['📋 COLUMNA ACCIÓN — opciones válidas', ''],
      ['crear',      'Crea un usuario nuevo. Se generará contraseña temporal desde el sistema.'],
      ['actualizar', 'Actualiza los datos de un usuario ya existente (lo busca por correo).'],
      ['inactivar',  'Desactiva temporalmente el usuario. Puede reactivarse desde el sistema.'],
      ['eliminar',   'Elimina definitivamente al usuario. Esta acción no se puede deshacer.'],
      ['', ''],
      ['📋 FECHAS — Acceso desde / Vence el', ''],
      ['Acceso desde', 'Fecha a partir de la cual el usuario puede ingresar (dejar vacío = inmediato). Formato: DD/MM/AAAA'],
      ['Vence el',     'Fecha en que el acceso expira automáticamente (dejar vacío = sin vencimiento). Formato: DD/MM/AAAA'],
      ['', ''],
      ['📋 CONTRASEÑA (opcional)', ''],
      ['Contraseña (opcional)', 'Solo aplica con acción "crear" o "actualizar". Si se deja vacía en "crear", el sistema genera una clave aleatoria (se muestra en el resultado del cargue). Si se llena, esa es la clave que queda para el usuario — úsela con cuidado, queda visible en este archivo.'],
      ['Forzar cambio clave (SI/NO)', 'SI o vacío (por defecto) = el usuario debe cambiar la clave la primera vez que ingrese. NO = puede seguir usando la clave indicada sin que se lo pida.'],
      ['', ''],
      ['📋 MÓDULOS DEL SISTEMA', ''],
      ['Escribe SI en la columna del módulo para habilitarlo.', 'Si no marcas ninguno, se habilitarán todos por defecto.'],
      ['', ''],
    ];
    for (const m of MODULOS_DEF) {
      refRows.push([`◆ ${m.nombre}`, m.descripcion ?? '']);
      for (const s of m.submodulos ?? []) {
        refRows.push([`    ${s.nombre}`, s.descripcion ?? '']);
      }
      refRows.push(['', '']);
    }

    const ecRef = (r: number, c: number) => XS.utils.encode_cell({ r, c });
    refRows.forEach(([a, b], r) => {
      const isMainTitle = r === 0;
      const isSection   = a.startsWith('📋');
      const isGroup     = a.startsWith('◆');
      const isEmpty     = !a && !b;
      const bgColor = isMainTitle ? '1E3A5F' : isSection ? '2C4A7C' : isGroup ? 'E8EEF7' : isEmpty ? 'FFFFFF' : r % 2 === 0 ? 'F8FAFC' : 'FFFFFF';
      const fgColor = (isMainTitle || isSection) ? 'FFFFFF' : '1E293B';
      const bold = isMainTitle || isSection || isGroup;
      const cellStyle = {
        fill: { fgColor: { rgb: bgColor } },
        font: { bold, color: { rgb: fgColor }, sz: 10, name: 'Calibri' },
        alignment: { vertical: 'center', wrapText: true, horizontal: 'left' },
      };
      wsRef[ecRef(r, 0)] = { v: a, t: 's', s: cellStyle };
      wsRef[ecRef(r, 1)] = { v: b, t: 's', s: { ...cellStyle, font: { ...cellStyle.font, bold: false } } };
    });
    wsRef['!ref']    = XS.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: refRows.length - 1, c: 1 } });
    wsRef['!cols']   = [{ wch: 36 }, { wch: 60 }];
    wsRef['!rows']   = refRows.map((_, i) => ({ hpt: i === 0 ? 22 : 16 }));
    wsRef['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
    XS.utils.book_append_sheet(wb, wsRef, 'Referencia');

    const buf = XS.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="Plantilla_Usuarios.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e: any) {
    console.error('[plantilla-excel]', e);
    res.status(500).json({ error: 'Error generando plantilla' });
  }
});

// ── POST /api/admin/usuarios/import-excel ────────────────────────────────────
router.post('/usuarios/import-excel', upload.single('file'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) { res.status(400).json({ error: 'Archivo requerido' }); return; }

    const wb  = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
    const ws  = wb.Sheets['Usuarios'] ?? wb.Sheets[wb.SheetNames[0]];
    const allRows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' });
    const dataRows = allRows.slice(2);

    const userRepo    = AppDataSource.getRepository(User);
    const modRepo     = AppDataSource.getRepository(Modulo);
    const umRepo      = AppDataSource.getRepository(UsuarioModulo);
    const companyRepo = AppDataSource.getRepository(Company);
    const allMods     = await modRepo.find({ where: { activo: true } });
    const modsMap     = new Map(allMods.map(m => [m.codigo, m]));
    const cid         = req.user!.companyId;
    const isSA        = req.user!.role === 'superadmin';
    // Contraseña temporal ALEATORIA por usuario (no una sola compartida entre
    // todos los usuarios de todas las instalaciones) — se fuerza su cambio en
    // el primer login vía debe_cambiar_password.
    const randomPassword = (): string => crypto.randomBytes(9).toString('base64').replace(/[/+=]/g, 'x') + 'Aa1!';

    const ACTIONS = new Set(['crear', 'actualizar', 'inactivar', 'eliminar']);
    const str    = (v: unknown) => String(v ?? '').trim();
    const strLow = (v: unknown) => str(v).toLowerCase();

    let ok = 0, errors = 0;
    const resultados: { fila: number; email: string; accion: string; resultado: string; password_temporal?: string }[] = [];

    for (let i = 0; i < dataRows.length; i++) {
      const row  = dataRows[i] as unknown[];
      const email = strLow(row[COL_EMAIL]);
      if (!email) continue;

      let accion = strLow(row[COL_ACCION]);
      if (!ACTIONS.has(accion)) {
        for (let c = 0; c < FIXED_COUNT; c++) {
          if (ACTIONS.has(strLow(row[c]))) { accion = strLow(row[c]); break; }
        }
      }
      if (!accion) accion = 'crear';

      // Resolver empresa: superadmin puede especificar NIT o nombre de empresa.
      // Ojo: el NIT NO es unico en la tabla companies (hay casos reales con
      // dos empresas activas compartiendo el mismo NIT, ej. una de pruebas y
      // una de produccion) — buscar solo por NIT en ese caso es ambiguo y
      // puede traer la empresa equivocada. Por eso, si el valor de la celda
      // coincide por NIT con mas de una empresa, se exige que tambien
      // coincida EXACTO (sin distinguir mayusculas) con el nombre de una de
      // ellas para desempatar.
      let targetCid = cid;
      if (isSA) {
        const empresaValor = str(row[COL_EMPRESA]);
        if (empresaValor) {
          const candidatas = await companyRepo.find({ where: { nit: empresaValor } });
          let empresa = candidatas.length === 1 ? candidatas[0] : undefined;
          if (!empresa) {
            const porNombre = candidatas.find(c => c.name.trim().toLowerCase() === empresaValor.trim().toLowerCase());
            empresa = porNombre ?? (await companyRepo.findOne({ where: { name: empresaValor } })) ?? undefined;
          }
          if (empresa) targetCid = empresa.id;
          else if (candidatas.length > 1) {
            resultados.push({ fila: i + 3, email, accion, resultado: `NIT ${empresaValor} tiene ${candidatas.length} empresas — escriba el NOMBRE exacto de la empresa en esa columna en vez del NIT` });
            errors++;
            continue;
          } else {
            resultados.push({ fila: i + 3, email, accion, resultado: `empresa "${empresaValor}" no encontrada (por NIT ni por nombre)` });
            errors++;
            continue;
          }
        }
      }

      const modulosCodigos: string[] = [];
      SUBMODULE_COLS.forEach((sub, idx) => {
        const val = strLow(row[FIXED_COUNT + idx]);
        if (val === 'si' || val === 'sí' || val === '1' || val === 'x') modulosCodigos.push(sub.codigo);
      });

      const fila = i + 3;
      try {
        if (accion === 'crear') {
          // Unicidad por empresa (multi-tenant) — no global.
          const exists = await userRepo.findOne({ where: { email, company_id: targetCid } });
          if (exists) { resultados.push({ fila, email, accion, resultado: 'omitido — ya existe en esta empresa' }); continue; }
          const primer_nombre    = str(row[COL_PNOM]);
          const segundo_nombre   = str(row[COL_SNOM]);
          const primer_apellido  = str(row[COL_PAPEL]);
          const segundo_apellido = str(row[COL_SAPEL]);
          const nombre = buildFullName(primer_nombre, segundo_nombre, primer_apellido, segundo_apellido) || email;
          // Contraseña: si la plantilla trae una en la columna "Contraseña
          // (opcional)" se usa esa (util para cargues masivos donde ya se
          // define una regla propia, ej. numero de documento); si se deja
          // vacia, se sigue generando una aleatoria como hasta ahora.
          const passwordCol      = str(row[COL_PASSWORD]);
          const passwordTemporal = passwordCol || randomPassword();
          const password_hash    = await bcrypt.hash(passwordTemporal, 10);
          // Forzar cambio de clave en el primer login: por defecto SI (igual
          // que antes), salvo que la fila diga explicitamente "no".
          const forzarCambioVal   = strLow(row[COL_FORZAR_CAMBIO]);
          const debeCambiarPass   = !(forzarCambioVal === 'no' || forzarCambioVal === 'n' || forzarCambioVal === '0');
          const user = userRepo.create({
            email, password_hash, name: nombre, role: 'operator', company_id: targetCid,
            tipo_documento:   str(row[COL_TIPODOC]) || undefined,
            numero_documento: str(row[COL_NUMDOC])  || undefined,
            primer_nombre:    primer_nombre  || undefined,
            segundo_nombre:   segundo_nombre || undefined,
            primer_apellido:  primer_apellido || undefined,
            segundo_apellido: segundo_apellido || undefined,
            telefono:         str(row[COL_TEL])    || undefined,
            fecha_inicio:     safeDate(row[COL_INICIO]),
            fecha_fin:        safeDate(row[COL_FIN]),
            is_active:        true,
            debe_cambiar_password: debeCambiarPass,
          });
          await userRepo.save(user);
          if (modulosCodigos.length > 0) {
            const umRows = modulosCodigos.filter(c => modsMap.has(c)).map(c =>
              umRepo.create({ user_id: user.id, modulo_id: modsMap.get(c)!.id, activo: true, asignado_por: req.user!.email })
            );
            if (umRows.length) await umRepo.save(umRows);
          }
          resultados.push({ fila, email, accion, resultado: 'creado OK', password_temporal: passwordCol ? undefined : passwordTemporal }); ok++;

        } else if (accion === 'actualizar') {
          const user = await userRepo.findOne({ where: { email, company_id: targetCid } });
          if (!user) { resultados.push({ fila, email, accion, resultado: 'no encontrado' }); errors++; continue; }
          const pn = str(row[COL_PNOM]); const sn = str(row[COL_SNOM]);
          const pa = str(row[COL_PAPEL]); const sa = str(row[COL_SAPEL]);
          if (pn) { user.primer_nombre = pn; user.segundo_nombre = sn || undefined; }
          if (pa) { user.primer_apellido = pa; user.segundo_apellido = sa || undefined; }
          if (str(row[COL_TIPODOC])) user.tipo_documento   = str(row[COL_TIPODOC]);
          if (str(row[COL_NUMDOC]))  user.numero_documento = str(row[COL_NUMDOC]);
          if (str(row[COL_TEL]))     user.telefono         = str(row[COL_TEL]);
          if (pn || pa) user.name = buildFullName(user.primer_nombre, user.segundo_nombre, user.primer_apellido, user.segundo_apellido);
          const fi = safeDate(row[COL_INICIO]); if (fi) user.fecha_inicio = fi;
          const ff = safeDate(row[COL_FIN]);    if (ff) user.fecha_fin    = ff;
          // Contraseña / forzar cambio: solo se tocan si la fila trae algo —
          // dejarlas vacias en "actualizar" no cambia lo que el usuario ya tiene.
          const passwordColUpd = str(row[COL_PASSWORD]);
          if (passwordColUpd) user.password_hash = await bcrypt.hash(passwordColUpd, 10);
          const forzarCambioValUpd = strLow(row[COL_FORZAR_CAMBIO]);
          if (forzarCambioValUpd === 'si' || forzarCambioValUpd === 'sí' || forzarCambioValUpd === '1') user.debe_cambiar_password = true;
          else if (forzarCambioValUpd === 'no' || forzarCambioValUpd === 'n' || forzarCambioValUpd === '0') user.debe_cambiar_password = false;
          await userRepo.save(user);
          if (modulosCodigos.length > 0) {
            await umRepo.delete({ user_id: user.id });
            const umRows = modulosCodigos.filter(c => modsMap.has(c)).map(c =>
              umRepo.create({ user_id: user.id, modulo_id: modsMap.get(c)!.id, activo: true, asignado_por: req.user!.email })
            );
            if (umRows.length) await umRepo.save(umRows);
          }
          resultados.push({ fila, email, accion, resultado: 'actualizado OK' }); ok++;

        } else if (accion === 'inactivar') {
          const user = await userRepo.findOne({ where: { email, company_id: targetCid } });
          if (!user) { resultados.push({ fila, email, accion, resultado: 'no encontrado' }); errors++; continue; }
          user.is_active = false;
          await userRepo.save(user);
          resultados.push({ fila, email, accion, resultado: 'inactivado OK' }); ok++;

        } else if (accion === 'eliminar') {
          const user = await userRepo.findOne({ where: { email, company_id: targetCid } });
          if (!user) { resultados.push({ fila, email, accion, resultado: 'no encontrado' }); errors++; continue; }
          await umRepo.delete({ user_id: user.id });
          await userRepo.remove(user);
          resultados.push({ fila, email, accion, resultado: 'eliminado OK' }); ok++;
        }
      } catch (e: any) {
        resultados.push({ fila, email, accion, resultado: `error: ${e?.message ?? 'desconocido'}` });
        errors++;
      }
    }

    res.json({ total: ok + errors, ok, error: errors, resultados });
  } catch (e: any) {
    console.error('[import-excel]', e);
    res.status(500).json({ error: 'Error procesando Excel', detail: e?.message });
  }
});

// ── GET /api/admin/usuarios ───────────────────────────────────────────────────
router.get('/usuarios', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const isSA   = req.user!.role === 'superadmin';
    const userRepo = AppDataSource.getRepository(User);
    const umRepo   = AppDataSource.getRepository(UsuarioModulo);

    // Superadmin ve todos; admin solo ve su empresa
    const qb = userRepo.createQueryBuilder('u')
      .leftJoinAndSelect('u.company', 'company')
      .orderBy('u.name', 'ASC');
    if (!isSA) qb.where('u.company_id = :cid', { cid: req.user!.companyId });

    const users = await qb.getMany();

    const result = await Promise.all(users.map(async u => {
      const ums = await umRepo.find({ where: { user_id: u.id, activo: true }, relations: ['modulo'] });
      return {
        id: u.id, email: u.email, name: u.name, role: u.role,
        is_active: u.is_active,
        company_id:   u.company_id,
        company_nit:  u.company?.nit  ?? '',
        company_name: u.company?.name ?? '',
        tipo_documento: u.tipo_documento, numero_documento: u.numero_documento,
        primer_nombre: u.primer_nombre, segundo_nombre: u.segundo_nombre,
        primer_apellido: u.primer_apellido, segundo_apellido: u.segundo_apellido,
        cargo: u.cargo, telefono: u.telefono, fecha_inicio: u.fecha_inicio, fecha_fin: u.fecha_fin,
        debe_cambiar_password: u.debe_cambiar_password, ultimo_login: u.ultimo_login,
        modulos: ums.filter(m => m.modulo?.codigo).map(m => m.modulo!.codigo),
      };
    }));

    res.json(result);
  } catch (e) {
    console.error('[GET /usuarios]', e);
    res.status(500).json({ error: 'Error listando usuarios' });
  }
});

// ── POST /api/admin/usuarios ──────────────────────────────────────────────────
router.post('/usuarios', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const isSA = req.user!.role === 'superadmin';
    const {
      email, password, name, role,
      tipo_documento, numero_documento,
      primer_nombre, segundo_nombre, primer_apellido, segundo_apellido,
      cargo, telefono, notas, fecha_inicio, fecha_fin,
      is_active = true, modulos: modulosCodigos = [],
      company_id: reqCompanyId,
    } = req.body as Record<string, any>;

    if (!email || !password) {
      res.status(400).json({ error: 'Email y contraseña son obligatorios' }); return;
    }

    // Superadmin puede crear usuarios en cualquier empresa; admin solo en la suya
    const company_id = isSA && reqCompanyId ? reqCompanyId : req.user!.companyId;

    // El rol 'superadmin' solo puede ser asignado por otro superadmin —
    // un admin normal no puede autoescalarse ni escalar a otros usuarios.
    if (role === 'superadmin' && !isSA) {
      res.status(403).json({ error: 'No tienes permisos para asignar el rol superadmin' }); return;
    }

    const userRepo = AppDataSource.getRepository(User);
    // Unicidad de email por empresa (multi-tenant): el mismo correo puede existir
    // en empresas distintas, pero no dos veces dentro de la misma empresa.
    const exists   = await userRepo.findOne({ where: { email, company_id } });
    if (exists) { res.status(409).json({ error: 'Ya existe un usuario con ese correo en esta empresa' }); return; }

    const password_hash = await bcrypt.hash(password, 10);
    const user = userRepo.create({
      email, password_hash, name: name || email,
      role: role || 'operator',
      company_id,
      tipo_documento, numero_documento,
      primer_nombre, segundo_nombre, primer_apellido, segundo_apellido,
      cargo, telefono, notas, fecha_inicio, fecha_fin,
      is_active,
      debe_cambiar_password: true,
    });
    await userRepo.save(user);

    if (Array.isArray(modulosCodigos) && modulosCodigos.length > 0) {
      const modRepo  = AppDataSource.getRepository(Modulo);
      const umRepo   = AppDataSource.getRepository(UsuarioModulo);
      const allMods  = await modRepo.find({ where: { activo: true } });
      const modsMap  = new Map(allMods.map(m => [m.codigo, m]));
      const umRows   = (modulosCodigos as string[])
        .filter(c => modsMap.has(c))
        .map(c => umRepo.create({ user_id: user.id, modulo_id: modsMap.get(c)!.id, activo: true, asignado_por: req.user!.email }));
      if (umRows.length) await umRepo.save(umRows);
    }

    res.status(201).json({ id: user.id, email: user.email, name: user.name, role: user.role });
  } catch (e: any) {
    console.error('[POST /usuarios]', e);
    res.status(500).json({ error: 'Error creando usuario', detail: e?.message });
  }
});

// ── PUT /api/admin/usuarios/:id ───────────────────────────────────────────────
router.put('/usuarios/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const isSA = req.user!.role === 'superadmin';
    const userRepo = AppDataSource.getRepository(User);
    const user     = await userRepo.findOne({ where: { id: req.params.id } });
    if (!user) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }

    // Admin solo puede editar usuarios de su empresa
    if (!isSA && user.company_id !== req.user!.companyId) {
      res.status(403).json({ error: 'Sin acceso a este usuario' }); return;
    }

    const {
      email, password, name, role,
      tipo_documento, numero_documento,
      primer_nombre, segundo_nombre, primer_apellido, segundo_apellido,
      cargo, telefono, notas, fecha_inicio, fecha_fin,
      is_active, modulos: modulosCodigos, company_id: newCompanyId,
    } = req.body as Record<string, any>;

    // El rol 'superadmin' solo puede ser asignado (o quitado) por otro superadmin.
    if (role !== undefined && (role === 'superadmin' || user.role === 'superadmin') && !isSA) {
      res.status(403).json({ error: 'No tienes permisos para asignar o modificar el rol superadmin' }); return;
    }

    if (email !== undefined) user.email          = email;
    if (name  !== undefined) user.name           = name;
    if (role  !== undefined) user.role           = role;
    if (is_active !== undefined) user.is_active  = is_active;
    if (isSA && newCompanyId !== undefined) user.company_id = newCompanyId;
    if (tipo_documento  !== undefined) user.tipo_documento  = tipo_documento;
    if (numero_documento !== undefined) user.numero_documento = numero_documento;
    if (primer_nombre   !== undefined) user.primer_nombre   = primer_nombre;
    if (segundo_nombre  !== undefined) user.segundo_nombre  = segundo_nombre;
    if (primer_apellido !== undefined) user.primer_apellido = primer_apellido;
    if (segundo_apellido !== undefined) user.segundo_apellido = segundo_apellido;
    if (cargo      !== undefined) user.cargo     = cargo;
    if (telefono   !== undefined) user.telefono  = telefono;
    if (notas      !== undefined) user.notas     = notas;
    if (fecha_inicio !== undefined) user.fecha_inicio = fecha_inicio;
    if (fecha_fin    !== undefined) user.fecha_fin    = fecha_fin;
    if (password) user.password_hash = await bcrypt.hash(password, 10);

    await userRepo.save(user);

    if (Array.isArray(modulosCodigos)) {
      const modRepo = AppDataSource.getRepository(Modulo);
      const umRepo  = AppDataSource.getRepository(UsuarioModulo);
      await umRepo.delete({ user_id: user.id });
      if (modulosCodigos.length > 0) {
        const allMods = await modRepo.find({ where: { activo: true } });
        const modsMap = new Map(allMods.map(m => [m.codigo, m]));
        const umRows  = (modulosCodigos as string[])
          .filter(c => modsMap.has(c))
          .map(c => umRepo.create({ user_id: user.id, modulo_id: modsMap.get(c)!.id, activo: true, asignado_por: req.user!.email }));
        if (umRows.length) await umRepo.save(umRows);
      }
    }

    res.json({ id: user.id, email: user.email, name: user.name, role: user.role });
  } catch (e: any) {
    console.error('[PUT /usuarios/:id]', e);
    res.status(500).json({ error: 'Error actualizando usuario', detail: e?.message });
  }
});

// ── DELETE /api/admin/usuarios/:id (inactivar — soft delete) ─────────────────
router.delete('/usuarios/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const isSA = req.user!.role === 'superadmin';
    const repo = AppDataSource.getRepository(User);
    const user = await repo.findOne({ where: { id: req.params.id } });
    if (!user) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }
    if (!isSA && user.company_id !== req.user!.companyId) {
      res.status(403).json({ error: 'Sin acceso a este usuario' }); return;
    }
    user.is_active = false;
    await repo.save(user);
    res.json({ ok: true, accion: 'inactivado' });
  } catch (e: any) {
    res.status(500).json({ error: 'Error inactivando usuario', detail: e?.message });
  }
});

// ── DELETE /api/admin/usuarios/:id/eliminar (hard delete — borrado físico) ───
router.delete('/usuarios/:id/eliminar', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const isSA     = req.user!.role === 'superadmin';
    const userRepo = AppDataSource.getRepository(User);
    const umRepo   = AppDataSource.getRepository(UsuarioModulo);
    const user     = await userRepo.findOne({ where: { id: req.params.id } });
    if (!user) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }
    if (!isSA && user.company_id !== req.user!.companyId) {
      res.status(403).json({ error: 'Sin acceso a este usuario' }); return;
    }
    await umRepo.delete({ user_id: user.id });
    await userRepo.remove(user);
    res.json({ ok: true, accion: 'eliminado' });
  } catch (e: any) {
    console.error('[DELETE /usuarios/:id/eliminar]', e);
    res.status(500).json({ error: 'Error eliminando usuario', detail: e?.message });
  }
});

// ── PATCH /api/admin/usuarios/:id/activate ───────────────────────────────────
router.patch('/usuarios/:id/activate', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const isSA = req.user!.role === 'superadmin';
    const repo = AppDataSource.getRepository(User);
    const user = await repo.findOne({ where: { id: req.params.id } });
    if (!user) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }
    if (!isSA && user.company_id !== req.user!.companyId) {
      res.status(403).json({ error: 'Sin acceso a este usuario' }); return;
    }
    user.is_active = true;
    await repo.save(user);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: 'Error activando usuario', detail: e?.message });
  }
});

export default router;
