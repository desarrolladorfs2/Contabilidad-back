import { Router, Response } from 'express';
import { AppDataSource } from '../../config/database';
import { AsientoContable } from '../../entities/contabilidad/AsientoContable';
import { CierrePeriodo } from '../../entities/contabilidad/CierrePeriodo';
import { LineaAsiento } from '../../entities/contabilidad/LineaAsiento';
import { CuentaPUC } from '../../entities/contabilidad/CuentaPUC';
import { CentroCosto } from '../../entities/contabilidad/CentroCosto';
import { Sede } from '../../entities/contabilidad/Sede';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import * as XLSX from 'xlsx';

const router = Router();
router.use(authMiddleware);

// ─── helpers ─────────────────────────────────────────────────────────────────

async function queryEstadoResultados(cid: string, fecha_desde: string, fecha_hasta: string, centro_costo_id?: string) {
  const qb = AppDataSource.getRepository(LineaAsiento)
    .createQueryBuilder('l')
    .innerJoin('l.asiento', 'a')
    .select('l.cuenta_codigo', 'codigo')
    .addSelect('l.cuenta_nombre', 'nombre')
    .addSelect('SUM(CAST(l.debito AS FLOAT))', 'total_debito')
    .addSelect('SUM(CAST(l.credito AS FLOAT))', 'total_credito')
    .where('a.company_id = :cid', { cid })
    .andWhere('a.estado = :e', { e: 'aprobado' })
    .andWhere('a.fecha BETWEEN :s AND :e2', { s: fecha_desde, e2: fecha_hasta })
    .groupBy('l.cuenta_codigo')
    .addGroupBy('l.cuenta_nombre')
    .orderBy('l.cuenta_codigo', 'ASC');
  if (centro_costo_id) qb.andWhere('l.centro_costo_id = :ccid', { ccid: centro_costo_id });
  const lineas = await qb.getRawMany<{ codigo: string; nombre: string; total_debito: string; total_credito: string }>();

  const cuentasMap = await AppDataSource.getRepository(CuentaPUC)
    .createQueryBuilder('c').where('c.company_id = :cid', { cid }).getMany();
  const tipoMap = Object.fromEntries(cuentasMap.map(c => [c.codigo, { tipo: c.tipo, naturaleza: c.naturaleza, nombre: c.nombre }]));

  const ingresos: { codigo: string; nombre: string; valor: number }[] = [];
  const gastos: { codigo: string; nombre: string; valor: number }[] = [];
  const costos: { codigo: string; nombre: string; valor: number }[] = [];
  // Hallazgo #38: antes, cuando una cuenta no estaba en el PUC de la empresa,
  // se "adivinaba" el tipo por el primer dígito del código sin dejar ningún
  // rastro visible. Ahora se registra qué códigos se clasificaron así, para
  // que el frontend pueda mostrar una advertencia en vez de fallar en
  // silencio.
  const cuentasSinClasificar = new Set<string>();

  for (const l of lineas) {
    const info = tipoMap[l.codigo];
    if (!info) cuentasSinClasificar.add(l.codigo);
    const tipo = info?.tipo || (l.codigo.startsWith('4') ? 'ingreso' : l.codigo.startsWith('5') ? 'gasto' : l.codigo.startsWith('6') ? 'costo' : null);
    if (!tipo || !['ingreso', 'gasto', 'costo'].includes(tipo)) continue;
    const nat = info?.naturaleza || (tipo === 'ingreso' ? 'credito' : 'debito');
    const valor = nat === 'credito' ? (+l.total_credito - +l.total_debito) : (+l.total_debito - +l.total_credito);
    const row = { codigo: l.codigo, nombre: l.nombre || info?.nombre || '', valor };
    if (tipo === 'ingreso') ingresos.push(row);
    else if (tipo === 'gasto') gastos.push(row);
    else costos.push(row);
  }

  const sum = (arr: { valor: number }[]) => arr.reduce((s, r) => s + r.valor, 0);
  const totalIngresos = sum(ingresos);
  const totalGastos = sum(gastos);
  const totalCostos = sum(costos);
  const utilidadBruta = totalIngresos - totalCostos;
  const utilidadNeta = utilidadBruta - totalGastos;
  return {
    ingresos, gastos, costos, totalIngresos, totalGastos, totalCostos, utilidadBruta, utilidadNeta,
    cuentas_sin_clasificar: Array.from(cuentasSinClasificar),
  };
}

async function queryPorCentroCosto(cid: string, fecha_desde: string, fecha_hasta: string) {
  const lineas = await AppDataSource.getRepository(LineaAsiento)
    .createQueryBuilder('l')
    .innerJoin('l.asiento', 'a')
    .select('l.centro_costo_id', 'centro_costo_id')
    .addSelect('l.cuenta_codigo', 'codigo')
    .addSelect('SUM(CAST(l.debito AS FLOAT))', 'total_debito')
    .addSelect('SUM(CAST(l.credito AS FLOAT))', 'total_credito')
    .where('a.company_id = :cid', { cid })
    .andWhere('a.estado = :e', { e: 'aprobado' })
    .andWhere('a.fecha BETWEEN :s AND :e2', { s: fecha_desde, e2: fecha_hasta })
    .groupBy('l.centro_costo_id')
    .addGroupBy('l.cuenta_codigo')
    .orderBy('l.centro_costo_id', 'ASC')
    .addOrderBy('l.cuenta_codigo', 'ASC')
    .getRawMany<{ centro_costo_id: string | null; codigo: string; total_debito: string; total_credito: string }>();

  const cuentasMap = await AppDataSource.getRepository(CuentaPUC)
    .createQueryBuilder('c').where('c.company_id = :cid', { cid }).getMany();
  const tipoMap = Object.fromEntries(cuentasMap.map(c => [c.codigo, { tipo: c.tipo, naturaleza: c.naturaleza }]));

  const centrosCC = await AppDataSource.getRepository(CentroCosto).find({ where: { company_id: cid } });
  const ccMap = Object.fromEntries(centrosCC.map(c => [c.id, {
    id: c.id, codigo: c.codigo, nombre: c.nombre,
  }]));

  const groups: Record<string, { ingresos: number; costos: number; gastos: number }> = {};
  for (const l of lineas) {
    const key = l.centro_costo_id || '__sin_asignar__';
    if (!groups[key]) groups[key] = { ingresos: 0, costos: 0, gastos: 0 };
    const info = tipoMap[l.codigo];
    const tipo = info?.tipo || (l.codigo.startsWith('4') ? 'ingreso' : l.codigo.startsWith('5') ? 'gasto' : l.codigo.startsWith('6') ? 'costo' : null);
    if (!tipo || !['ingreso', 'gasto', 'costo'].includes(tipo)) continue;
    const nat = info?.naturaleza || (tipo === 'ingreso' ? 'credito' : 'debito');
    const valor = nat === 'credito' ? (+l.total_credito - +l.total_debito) : (+l.total_debito - +l.total_credito);
    if (tipo === 'ingreso') groups[key].ingresos += valor;
    else if (tipo === 'costo') groups[key].costos += valor;
    else groups[key].gastos += valor;
  }

  const centros = Object.entries(groups).map(([key, totales]) => {
    const cc = key === '__sin_asignar__' ? null : ccMap[key];
    return {
      centro_costo_id: key === '__sin_asignar__' ? null : key,
      codigo: cc?.codigo || null,
      nombre: cc?.nombre || 'Sin centro de costo',
      total_ingresos: totales.ingresos,
      total_costos: totales.costos,
      total_gastos: totales.gastos,
      utilidad_bruta: totales.ingresos - totales.costos,
      utilidad_neta: totales.ingresos - totales.costos - totales.gastos,
    };
  }).sort((a, b) => (a.codigo || 'ZZZ').localeCompare(b.codigo || 'ZZZ'));

  const totalAll = centros.reduce((acc, c) => ({
    ingresos: acc.ingresos + c.total_ingresos,
    costos: acc.costos + c.total_costos,
    gastos: acc.gastos + c.total_gastos,
    utilidad_neta: acc.utilidad_neta + c.utilidad_neta,
  }), { ingresos: 0, costos: 0, gastos: 0, utilidad_neta: 0 });

  return { centros, totalAll };
}

// ─── routes ──────────────────────────────────────────────────────────────────

// GET /api/contabilidad/reportes/libro-mayor/export-excel
router.get('/libro-mayor/export-excel', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { cuenta_codigo, fecha_desde, fecha_hasta } = req.query as Record<string, string>;
    const qb = AppDataSource.getRepository(LineaAsiento)
      .createQueryBuilder('l')
      .innerJoinAndSelect('l.asiento', 'a')
      .where('a.company_id = :cid', { cid })
      .andWhere('a.estado = :e', { e: 'aprobado' })
      .orderBy('l.cuenta_codigo', 'ASC')
      .addOrderBy('a.fecha', 'ASC')
      .addOrderBy('a.numero', 'ASC')
      .addOrderBy('l.orden', 'ASC');
    if (cuenta_codigo) qb.andWhere('l.cuenta_codigo LIKE :cc', { cc: cuenta_codigo + '%' });
    if (fecha_desde) qb.andWhere('a.fecha >= :fd', { fd: fecha_desde });
    if (fecha_hasta) qb.andWhere('a.fecha <= :fh', { fh: fecha_hasta });
    const lineas = await qb.getMany();
    const cuentasMap = new Map<string, { nombre: string; rows: any[][] }>();
    const saldos = new Map<string, number>();
    for (const l of lineas) {
      const cod = l.cuenta_codigo || l.cuenta?.codigo || '';
      if (!cod) continue;
      if (!cuentasMap.has(cod)) { cuentasMap.set(cod, { nombre: l.cuenta_nombre || l.cuenta?.nombre || '', rows: [] }); saldos.set(cod, 0); }
      const s = (saldos.get(cod) || 0) + (+l.debito - +l.credito);
      saldos.set(cod, s);
      cuentasMap.get(cod)!.rows.push([l.asiento.fecha, l.asiento.numero, l.asiento.descripcion, l.concepto || '', +l.debito || '', +l.credito || '', s]);
    }
    // Hallazgo #39: Excel soporta hasta 255 hojas por archivo — se deja margen
    // (240) para la hoja de resumen. Antes se cortaba en 50 y las cuentas
    // restantes se omitían sin ningún aviso; ahora, si hay que truncar, se
    // agrega una hoja "OMITIDAS" que lista explícitamente qué cuentas quedaron
    // fuera del archivo, en vez de desaparecer silenciosamente.
    const LIMITE_HOJAS = 240;
    const wb = XLSX.utils.book_new();
    let idx = 0;
    const omitidas: string[] = [];
    for (const [codigo, data] of cuentasMap) {
      if (idx >= LIMITE_HOJAS) { omitidas.push(`${codigo} ${data.nombre}`); continue; }
      const sheetData: any[][] = [
        [`LIBRO MAYOR - ${codigo} ${data.nombre}`],
        [`Periodo: ${fecha_desde || ''} al ${fecha_hasta || ''}`],
        [],
        ['Fecha', 'Asiento #', 'Descripcion', 'Concepto', 'Debito', 'Credito', 'Saldo'],
        ...data.rows,
      ];
      const ws = XLSX.utils.aoa_to_sheet(sheetData);
      ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 40 }, { wch: 30 }, { wch: 16 }, { wch: 16 }, { wch: 16 }];
      XLSX.utils.book_append_sheet(wb, ws, (codigo + ' ' + data.nombre).slice(0, 31));
      idx++;
    }
    if (idx === 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Sin movimientos']]), 'Sin datos');
    if (omitidas.length) {
      const wsOmitidas = XLSX.utils.aoa_to_sheet([
        ['ADVERTENCIA: este reporte excede el máximo de hojas por archivo Excel'],
        [`Se incluyeron ${idx} cuentas. Las siguientes ${omitidas.length} cuentas NO están en este archivo:`],
        [],
        ['Cuenta'],
        ...omitidas.map(c => [c]),
      ]);
      XLSX.utils.book_append_sheet(wb, wsOmitidas, 'OMITIDAS');
    }
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="libro-mayor-${fecha_desde || 'todo'}.xlsx"`);
    res.send(buf);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error exportando libro mayor' }); }
});

// GET /api/contabilidad/reportes/libro-mayor
router.get('/libro-mayor', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { cuenta_codigo, fecha_desde, fecha_hasta } = req.query as Record<string, string>;
    const qb = AppDataSource.getRepository(LineaAsiento)
      .createQueryBuilder('l')
      .innerJoinAndSelect('l.asiento', 'a')
      .where('a.company_id = :cid', { cid })
      .andWhere('a.estado = :e', { e: 'aprobado' })
      .orderBy('l.cuenta_codigo', 'ASC')
      .addOrderBy('a.fecha', 'ASC')
      .addOrderBy('a.numero', 'ASC')
      .addOrderBy('l.orden', 'ASC');
    if (cuenta_codigo) qb.andWhere('l.cuenta_codigo LIKE :cc', { cc: cuenta_codigo + '%' });
    if (fecha_desde) qb.andWhere('a.fecha >= :fd', { fd: fecha_desde });
    if (fecha_hasta) qb.andWhere('a.fecha <= :fh', { fh: fecha_hasta });
    const lineas = await qb.getMany();
    const cuentasMap = new Map<string, { codigo: string; nombre: string; movimientos: any[]; total_debito: number; total_credito: number }>();
    const saldos = new Map<string, number>();
    for (const l of lineas) {
      const cod = l.cuenta_codigo || l.cuenta?.codigo || '';
      if (!cod) continue;
      const nomCuenta = l.cuenta_nombre || l.cuenta?.nombre || '';
      if (!cuentasMap.has(cod)) {
        cuentasMap.set(cod, { codigo: cod, nombre: nomCuenta, movimientos: [], total_debito: 0, total_credito: 0 });
        saldos.set(cod, 0);
      }
      const cuenta = cuentasMap.get(cod)!;
      cuenta.total_debito += +l.debito;
      cuenta.total_credito += +l.credito;
      const s = (saldos.get(cod) || 0) + (+l.debito - +l.credito);
      saldos.set(cod, s);
      cuenta.movimientos.push({
        fecha: l.asiento.fecha, numero: l.asiento.numero,
        descripcion: l.asiento.descripcion, concepto: l.concepto,
        referencia: l.asiento.referencia_id, tercero_nit: l.tercero_nit,
        debito: +l.debito, credito: +l.credito, saldo: s,
      });
    }
    const cuentas = Array.from(cuentasMap.values()).map(c => ({ ...c, saldo_final: saldos.get(c.codigo) || 0 }));
    res.json({ cuenta_codigo: cuenta_codigo || null, fecha_desde, fecha_hasta, cuentas });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error generando libro mayor' }); }
});

/**
 * Hallazgo #40: el Balance General por fecha de corte no detectaba si, para
 * algún período ya cerrado dentro del rango del corte, se registró después
 * un asiento de ajuste (`origen: 'ajuste'`) con fecha dentro de ese período
 * pero creado (`created_at`) DESPUÉS de la fecha de cierre — es decir, el
 * balance para una fecha de corte "cerrada" pudo cambiar retroactivamente
 * sin que el sistema lo advirtiera. No se bloquea (los ajustes post-cierre
 * son en ocasiones legítimos), pero se reporta explícitamente.
 */
async function detectarAjustesPostCierre(cid: string, cutoff: string) {
  const cierres = await AppDataSource.getRepository(CierrePeriodo)
    .createQueryBuilder('c')
    .where('c.company_id = :cid', { cid })
    .andWhere('c.periodo <= :cutoffMes', { cutoffMes: cutoff.slice(0, 7) })
    .andWhere('c.reabierto_por_id IS NULL')
    .getMany();
  if (!cierres.length) return [];

  const advertencias: { periodo: string; fecha_cierre: string; asientos: { numero?: number; fecha: string; descripcion: string }[] }[] = [];
  for (const cierre of cierres) {
    const [y, m] = cierre.periodo.split('-').map(Number);
    const desdeMes = `${cierre.periodo}-01`;
    const hastaMes = new Date(y, m, 0).toISOString().slice(0, 10);
    const asientosPost = await AppDataSource.getRepository(AsientoContable)
      .createQueryBuilder('a')
      .where('a.company_id = :cid', { cid })
      .andWhere('a.origen = :o', { o: 'ajuste' })
      .andWhere('a.fecha BETWEEN :d AND :h', { d: desdeMes, h: hastaMes })
      .andWhere('a.created_at > :fc', { fc: cierre.fecha_cierre })
      .getMany();
    if (asientosPost.length) {
      advertencias.push({
        periodo: cierre.periodo,
        fecha_cierre: cierre.fecha_cierre,
        asientos: asientosPost.map(a => ({ numero: a.numero, fecha: a.fecha, descripcion: a.descripcion || '' })),
      });
    }
  }
  return advertencias;
}

// GET /api/contabilidad/reportes/balance
router.get('/balance', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { fecha } = req.query as Record<string, string>;
    const cutoff = fecha || new Date().toISOString().slice(0, 10);
    const lineas = await AppDataSource.getRepository(LineaAsiento)
      .createQueryBuilder('l')
      .innerJoin('l.asiento', 'a')
      .select('l.cuenta_codigo', 'codigo')
      .addSelect('l.cuenta_nombre', 'nombre')
      .addSelect('SUM(CAST(l.debito AS FLOAT))', 'total_debito')
      .addSelect('SUM(CAST(l.credito AS FLOAT))', 'total_credito')
      .where('a.company_id = :cid', { cid })
      .andWhere('a.estado = :e', { e: 'aprobado' })
      .andWhere('a.fecha <= :cutoff', { cutoff })
      .groupBy('l.cuenta_codigo')
      .addGroupBy('l.cuenta_nombre')
      .orderBy('l.cuenta_codigo', 'ASC')
      .getRawMany<{ codigo: string; nombre: string; total_debito: string; total_credito: string }>();
    const cuentasMap = await AppDataSource.getRepository(CuentaPUC)
      .createQueryBuilder('c').where('c.company_id = :cid', { cid }).getMany();
    const tipoMap = Object.fromEntries(cuentasMap.map(c => [c.codigo, { tipo: c.tipo, naturaleza: c.naturaleza, nombre: c.nombre }]));
    const activos: any[] = []; const pasivos: any[] = [];
    const patrimonio: any[] = []; const ingresos: any[] = [];
    const gastos: any[] = []; const costos: any[] = [];
    // Hallazgo #38: igual que en Estado de Resultados, se registran los
    // códigos que no estaban en el PUC de la empresa y se clasificaron por
    // heurística de prefijo, para poder advertirlo en vez de fallar en
    // silencio.
    const cuentasSinClasificar = new Set<string>();
    for (const l of lineas) {
      const info = tipoMap[l.codigo];
      if (!info) cuentasSinClasificar.add(l.codigo);
      const tipo = info?.tipo || (l.codigo.startsWith('1') ? 'activo' : l.codigo.startsWith('2') ? 'pasivo' : l.codigo.startsWith('3') ? 'patrimonio' : l.codigo.startsWith('4') ? 'ingreso' : 'gasto');
      const nat = info?.naturaleza || (tipo === 'activo' || tipo === 'gasto' || tipo === 'costo' ? 'debito' : 'credito');
      const saldo = nat === 'debito' ? (+l.total_debito - +l.total_credito) : (+l.total_credito - +l.total_debito);
      const row = { codigo: l.codigo, nombre: l.nombre || info?.nombre || '', saldo };
      if (tipo === 'activo') activos.push(row);
      else if (tipo === 'pasivo') pasivos.push(row);
      else if (tipo === 'patrimonio') patrimonio.push(row);
      else if (tipo === 'ingreso') ingresos.push(row);
      else if (tipo === 'gasto') gastos.push(row);
      else costos.push(row);
    }
    const sumS = (arr: any[]) => arr.reduce((s, r) => s + r.saldo, 0);
    const utilidad = sumS(ingresos) - sumS(gastos) - sumS(costos);
    const ajustesPostCierre = await detectarAjustesPostCierre(cid, cutoff);
    res.json({
      fecha: cutoff,
      activos, total_activos: sumS(activos),
      pasivos, total_pasivos: sumS(pasivos),
      patrimonio, total_patrimonio: sumS(patrimonio),
      ingresos, total_ingresos: sumS(ingresos),
      gastos, total_gastos: sumS(gastos),
      costos, total_costos: sumS(costos),
      utilidad_neta: utilidad,
      cuentas_sin_clasificar: Array.from(cuentasSinClasificar),
      advertencia_ajustes_post_cierre: ajustesPostCierre,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error generando balance' });
  }
});

// GET /api/contabilidad/reportes/balance/export-excel
router.get('/balance/export-excel', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { fecha } = req.query as Record<string, string>;
    const cutoff = fecha || new Date().toISOString().slice(0, 10);
    const lineas = await AppDataSource.getRepository(LineaAsiento)
      .createQueryBuilder('l')
      .innerJoin('l.asiento', 'a')
      .select('l.cuenta_codigo', 'codigo')
      .addSelect('l.cuenta_nombre', 'nombre')
      .addSelect('SUM(CAST(l.debito AS FLOAT))', 'total_debito')
      .addSelect('SUM(CAST(l.credito AS FLOAT))', 'total_credito')
      .where('a.company_id = :cid', { cid })
      .andWhere('a.estado = :e', { e: 'aprobado' })
      .andWhere('a.fecha <= :cutoff', { cutoff })
      .groupBy('l.cuenta_codigo').addGroupBy('l.cuenta_nombre')
      .orderBy('l.cuenta_codigo', 'ASC')
      .getRawMany<{ codigo: string; nombre: string; total_debito: string; total_credito: string }>();
    const cuentasMap = await AppDataSource.getRepository(CuentaPUC)
      .createQueryBuilder('c').where('c.company_id = :cid', { cid }).getMany();
    const tipoMap = Object.fromEntries(cuentasMap.map(c => [c.codigo, { tipo: c.tipo, naturaleza: c.naturaleza }]));
    const grupos: Record<string, { filas: any[]; total: number }> = {
      Activos: { filas: [], total: 0 }, Pasivos: { filas: [], total: 0 },
      Patrimonio: { filas: [], total: 0 }, Ingresos: { filas: [], total: 0 },
      Gastos: { filas: [], total: 0 }, Costos: { filas: [], total: 0 },
    };
    const tipoToGrupo: Record<string, string> = { activo: 'Activos', pasivo: 'Pasivos', patrimonio: 'Patrimonio', ingreso: 'Ingresos', gasto: 'Gastos', costo: 'Costos' };
    for (const l of lineas) {
      const info = tipoMap[l.codigo];
      const tipo = info?.tipo || (l.codigo.startsWith('1') ? 'activo' : l.codigo.startsWith('2') ? 'pasivo' : l.codigo.startsWith('3') ? 'patrimonio' : l.codigo.startsWith('4') ? 'ingreso' : 'gasto');
      const nat = info?.naturaleza || (tipo === 'activo' || tipo === 'gasto' || tipo === 'costo' ? 'debito' : 'credito');
      const saldo = nat === 'debito' ? (+l.total_debito - +l.total_credito) : (+l.total_credito - +l.total_debito);
      const g = tipoToGrupo[tipo] || 'Activos';
      grupos[g].filas.push({ codigo: l.codigo, nombre: l.nombre || '', saldo });
      grupos[g].total += saldo;
    }
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const ws_data: any[][] = [['Balance General — Corte al ' + cutoff], [], ['Grupo', 'Código', 'Cuenta', 'Saldo']];
    for (const [grupo, { filas, total }] of Object.entries(grupos)) {
      if (!filas.length) continue;
      ws_data.push([grupo, '', '', '']);
      filas.forEach(f => ws_data.push(['', f.codigo, f.nombre, f.saldo]));
      ws_data.push(['', '', 'Total ' + grupo, total]);
      ws_data.push([]);
    }
    const ws = XLSX.utils.aoa_to_sheet(ws_data);
    ws['!cols'] = [{ wch: 14 }, { wch: 10 }, { wch: 45 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Balance General');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="balance-general-${cutoff}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error exportando balance' }); }
});

// GET /api/contabilidad/reportes/estado-resultados
router.get('/estado-resultados', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const now = new Date();
    const defaultDesde = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const defaultHasta = now.toISOString().slice(0, 10);
    const { fecha_desde = defaultDesde, fecha_hasta = defaultHasta, centro_costo_id } = req.query as Record<string, string>;
    const data = await queryEstadoResultados(cid, fecha_desde, fecha_hasta, centro_costo_id);
    res.json({
      fecha_desde, fecha_hasta, centro_costo_id: centro_costo_id || null,
      ingresos: data.ingresos, total_ingresos: data.totalIngresos,
      costos: data.costos, total_costos: data.totalCostos,
      utilidad_bruta: data.utilidadBruta,
      gastos: data.gastos, total_gastos: data.totalGastos,
      utilidad_operacional: data.utilidadNeta,
      utilidad_neta: data.utilidadNeta,
      cuentas_sin_clasificar: data.cuentas_sin_clasificar,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error generando estado de resultados' });
  }
});

// GET /api/contabilidad/reportes/estado-resultados/export-excel
router.get('/estado-resultados/export-excel', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const now = new Date();
    const defaultDesde = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const defaultHasta = now.toISOString().slice(0, 10);
    const { fecha_desde = defaultDesde, fecha_hasta = defaultHasta, centro_costo_id } = req.query as Record<string, string>;
    const data = await queryEstadoResultados(cid, fecha_desde, fecha_hasta, centro_costo_id);
    const { ingresos, gastos, costos, totalIngresos, totalGastos, totalCostos, utilidadBruta, utilidadNeta } = data;

    const wb = XLSX.utils.book_new();

    // Sheet 1: Resumen P&L
    const resumenRows: any[][] = [
      ['ESTADO DE RESULTADOS'],
      [`Periodo: ${fecha_desde} al ${fecha_hasta}`],
      ...(centro_costo_id ? [[`Centro de Costo ID: ${centro_costo_id}`]] : []),
      [],
      ['Concepto', 'Valor (COP)'],
      ['Ingresos Operacionales', totalIngresos],
      ['(-) Costo de Ventas', totalCostos],
      ['Utilidad Bruta', utilidadBruta],
      ['(-) Gastos Operacionales', totalGastos],
      ['UTILIDAD NETA', utilidadNeta],
    ];
    const ws1 = XLSX.utils.aoa_to_sheet(resumenRows);
    ws1['!cols'] = [{ wch: 35 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, ws1, 'Resumen P&L');

    // Sheet 2: Ingresos
    const ingresosRows: any[][] = [
      ['Codigo', 'Cuenta', 'Valor (COP)'],
      ...ingresos.map(r => [r.codigo, r.nombre, r.valor]),
      [],
      ['', 'TOTAL INGRESOS', totalIngresos],
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(ingresosRows);
    ws2['!cols'] = [{ wch: 12 }, { wch: 45 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, ws2, 'Ingresos');

    // Sheet 3: Costos y Gastos
    const costosRows: any[][] = [
      ['Codigo', 'Cuenta', 'Tipo', 'Valor (COP)'],
      ...costos.map(r => [r.codigo, r.nombre, 'Costo de Ventas', r.valor]),
      ...gastos.map(r => [r.codigo, r.nombre, 'Gasto Operacional', r.valor]),
      [],
      ['', 'TOTAL COSTOS', '', totalCostos],
      ['', 'TOTAL GASTOS', '', totalGastos],
    ];
    const ws3 = XLSX.utils.aoa_to_sheet(costosRows);
    ws3['!cols'] = [{ wch: 12 }, { wch: 45 }, { wch: 20 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, ws3, 'Costos y Gastos');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="estado-resultados-${fecha_desde}-${fecha_hasta}.xlsx"`);
    res.send(buf);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error exportando estado de resultados' });
  }
});

// GET /api/contabilidad/reportes/por-centro-costo
router.get('/por-centro-costo', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const now = new Date();
    const defaultDesde = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const defaultHasta = now.toISOString().slice(0, 10);
    const { fecha_desde = defaultDesde, fecha_hasta = defaultHasta } = req.query as Record<string, string>;
    const { centros, totalAll } = await queryPorCentroCosto(cid, fecha_desde, fecha_hasta);
    res.json({ fecha_desde, fecha_hasta, centros, totales: totalAll });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error generando reporte por centro de costo' });
  }
});

// GET /api/contabilidad/reportes/por-centro-costo/export-excel
router.get('/por-centro-costo/export-excel', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const now = new Date();
    const defaultDesde = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const defaultHasta = now.toISOString().slice(0, 10);
    const { fecha_desde = defaultDesde, fecha_hasta = defaultHasta } = req.query as Record<string, string>;
    const { centros, totalAll } = await queryPorCentroCosto(cid, fecha_desde, fecha_hasta);

    const wb = XLSX.utils.book_new();

    const rows: any[][] = [
      ['REPORTE POR CENTRO DE COSTO'],
      [`Periodo: ${fecha_desde} al ${fecha_hasta}`],
      [],
      ['Codigo', 'Centro de Costo', 'Ingresos', 'Costos', 'Gastos', 'Util. Bruta', 'Util. Neta'],
      ...centros.map(c => [
        c.codigo || '—',
        c.nombre,
        c.total_ingresos,
        c.total_costos,
        c.total_gastos,
        c.utilidad_bruta,
        c.utilidad_neta,
      ]),
      [],
      ['', 'TOTALES', totalAll.ingresos, totalAll.costos, totalAll.gastos, totalAll.ingresos - totalAll.costos, totalAll.utilidad_neta],
    ];

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 10 }, { wch: 35 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Por Centro de Costo');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="por-centro-costo-${fecha_desde}-${fecha_hasta}.xlsx"`);
    res.send(buf);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error exportando reporte por centro de costo' });
  }
});

// GET /api/contabilidad/reportes/libro-diario/export-excel
router.get('/libro-diario/export-excel', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const now = new Date();
    const defaultDesde = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const defaultHasta = now.toISOString().slice(0, 10);
    const { fecha_desde = defaultDesde, fecha_hasta = defaultHasta } = req.query as Record<string, string>;
    const asientos = await AppDataSource.getRepository(AsientoContable)
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.lineas', 'l')
      .where('a.company_id = :cid', { cid })
      .andWhere('a.estado = :e', { e: 'aprobado' })
      .andWhere('a.fecha BETWEEN :fd AND :fh', { fd: fecha_desde, fh: fecha_hasta })
      .orderBy('a.fecha', 'ASC')
      .addOrderBy('a.numero', 'ASC')
      .addOrderBy('l.orden', 'ASC')
      .getMany();
    const rows: any[][] = [
      ['LIBRO DIARIO'],
      [`Periodo: ${fecha_desde} al ${fecha_hasta}`],
      [],
      ['Asiento', 'Fecha', 'Descripcion', 'Origen', 'Referencia', 'Cuenta', 'Nombre Cuenta', 'Concepto', 'Tercero NIT', 'Debito', 'Credito'],
    ];
    let totalDeb = 0, totalCre = 0;
    for (const a of asientos) {
      for (const l of (a.lineas || []).sort((x: any, y: any) => x.orden - y.orden)) {
        rows.push([a.numero, a.fecha, a.descripcion, a.origen, a.referencia_id || '', l.cuenta_codigo || l.cuenta?.codigo, l.cuenta_nombre || l.cuenta?.nombre, l.concepto || '', l.tercero_nit || '', +l.debito || '', +l.credito || '']);
        totalDeb += +l.debito || 0; totalCre += +l.credito || 0;
      }
    }
    rows.push([]); rows.push(['', '', '', '', '', '', '', 'TOTALES', '', totalDeb, totalCre]);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 10 }, { wch: 12 }, { wch: 40 }, { wch: 12 }, { wch: 20 }, { wch: 10 }, { wch: 35 }, { wch: 30 }, { wch: 15 }, { wch: 16 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Libro Diario');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="libro-diario-${fecha_desde}-${fecha_hasta}.xlsx"`);
    res.send(buf);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error exportando libro diario' }); }
});

// GET /api/contabilidad/reportes/libro-diario
router.get('/libro-diario', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const now = new Date();
    const defaultDesde = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const defaultHasta = now.toISOString().slice(0, 10);
    const { fecha_desde = defaultDesde, fecha_hasta = defaultHasta } = req.query as Record<string, string>;
    const asientos = await AppDataSource.getRepository(AsientoContable)
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.lineas', 'l')
      .where('a.company_id = :cid', { cid })
      .andWhere('a.estado = :e', { e: 'aprobado' })
      .andWhere('a.fecha BETWEEN :fd AND :fh', { fd: fecha_desde, fh: fecha_hasta })
      .orderBy('a.fecha', 'ASC')
      .addOrderBy('a.numero', 'ASC')
      .addOrderBy('l.orden', 'ASC')
      .getMany();
    const result = asientos.map(a => ({
      id: a.id, numero: a.numero, fecha: a.fecha, descripcion: a.descripcion,
      origen: a.origen, referencia: a.referencia_id,
      total_debito: +a.total_debito, total_credito: +a.total_credito,
      lineas: (a.lineas || []).sort((x: any, y: any) => x.orden - y.orden).map((l: any) => ({
        cuenta_codigo: l.cuenta_codigo, cuenta_nombre: l.cuenta_nombre,
        concepto: l.concepto, tercero_nit: l.tercero_nit,
        debito: +l.debito, credito: +l.credito,
      })),
    }));
    res.json({ fecha_desde, fecha_hasta, asientos: result });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error generando libro diario' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// SALDO GENERAL POR TERCERO (FBK-031)
// Agrega todas las líneas de asiento aprobadas que tengan tercero_nit,
// sin restringir a cuentas CxC/CxP — saldo contable general por NIT.
// GET /api/contabilidad/reportes/saldo-terceros?fecha_desde&fecha_hasta&search
// ─────────────────────────────────────────────────────────────────────────────
router.get('/saldo-terceros', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { fecha_desde, fecha_hasta, search } = req.query as Record<string, string>;
    const cutoff = fecha_hasta || new Date().toISOString().slice(0, 10);

    const qb = AppDataSource.getRepository(LineaAsiento)
      .createQueryBuilder('l')
      .innerJoin('l.asiento', 'a')
      .select('l.tercero_nit', 'tercero_nit')
      .addSelect('l.tercero_nombre', 'tercero_nombre')
      .addSelect('l.cuenta_codigo', 'codigo')
      .addSelect('l.cuenta_nombre', 'nombre')
      .addSelect('SUM(CAST(l.debito AS FLOAT))', 'total_debito')
      .addSelect('SUM(CAST(l.credito AS FLOAT))', 'total_credito')
      .where('a.company_id = :cid', { cid })
      .andWhere('a.estado = :e', { e: 'aprobado' })
      .andWhere("l.tercero_nit IS NOT NULL AND l.tercero_nit != ''")
      .andWhere('a.fecha <= :cutoff', { cutoff })
      .groupBy('l.tercero_nit').addGroupBy('l.tercero_nombre')
      .addGroupBy('l.cuenta_codigo').addGroupBy('l.cuenta_nombre')
      .orderBy('l.tercero_nit', 'ASC').addOrderBy('l.cuenta_codigo', 'ASC');
    if (fecha_desde) qb.andWhere('a.fecha >= :fd', { fd: fecha_desde });
    if (search) qb.andWhere('(l.tercero_nit LIKE :s OR l.tercero_nombre LIKE :s)', { s: `%${search}%` });

    const rows = await qb.getRawMany<{
      tercero_nit: string; tercero_nombre: string; codigo: string; nombre: string;
      total_debito: string; total_credito: string;
    }>();

    const terceros = new Map<string, {
      tercero_nit: string; tercero_nombre: string;
      total_debito: number; total_credito: number; saldo: number;
      cuentas: { codigo: string; nombre: string; debito: number; credito: number; saldo: number }[];
    }>();
    for (const r of rows) {
      if (!terceros.has(r.tercero_nit)) {
        terceros.set(r.tercero_nit, {
          tercero_nit: r.tercero_nit, tercero_nombre: r.tercero_nombre || '',
          total_debito: 0, total_credito: 0, saldo: 0, cuentas: [],
        });
      }
      const t = terceros.get(r.tercero_nit)!;
      const debito = +r.total_debito || 0;
      const credito = +r.total_credito || 0;
      t.total_debito += debito;
      t.total_credito += credito;
      t.saldo += debito - credito;
      t.cuentas.push({ codigo: r.codigo, nombre: r.nombre || '', debito, credito, saldo: debito - credito });
    }

    res.json({
      fecha_desde: fecha_desde || null, fecha_hasta: cutoff,
      terceros: Array.from(terceros.values()).sort((a, b) => a.tercero_nombre.localeCompare(b.tercero_nombre)),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error generando saldo general por tercero' });
  }
});

export default router;
