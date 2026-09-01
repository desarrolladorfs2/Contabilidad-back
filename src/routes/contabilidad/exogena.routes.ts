import { Router, Response } from 'express';
import { AppDataSource } from '../../config/database';
import { LineaAsiento } from '../../entities/contabilidad/LineaAsiento';
import { Factura } from '../../entities/Invoice';
import { FacturaCompra } from '../../entities/FacturaCompra';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import * as XLSX from 'xlsx';

const router = Router();
router.use(authMiddleware);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function buildNitMap(cid: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const [facturas, compras] = await Promise.all([
    AppDataSource.getRepository(Factura)
      .createQueryBuilder('i')
      .select(['i.cliente_nit', 'i.cliente_nombre'])
      .where('i.company_id = :cid', { cid })
      .andWhere("i.cliente_nit IS NOT NULL AND i.cliente_nit != ''")
      .getMany(),
    AppDataSource.getRepository(FacturaCompra)
      .createQueryBuilder('r')
      .select(['r.provider_nit', 'r.provider_name'])
      .where('r.company_id = :cid', { cid })
      .andWhere("r.provider_nit IS NOT NULL AND r.provider_nit != ''")
      .getMany(),
  ]);
  for (const f of facturas) {
    if (f.cliente_nit && !map.has(f.cliente_nit)) map.set(f.cliente_nit, f.cliente_nombre || '');
  }
  for (const c of compras) {
    if (c.provider_nit && !map.has(c.provider_nit)) map.set(c.provider_nit, c.provider_name || '');
  }
  return map;
}

interface RawRow { nit: string; cuenta: string; debito: string; credito: string; }

/**
 * Hallazgo #30: normaliza un NIT para poder agrupar terceros aunque el texto
 * libre `tercero_nit` (campo bridge deprecado) esté escrito con distinto
 * formato ("900123456" vs "900.123.456-1" vs con espacios) — se queda solo
 * con los dígitos antes de cualquier guion (el guion suele preceder el DV).
 */
function normalizeNit(raw: string | null | undefined): string {
  if (!raw) return '';
  const sinDv = raw.split('-')[0];
  return sinDv.replace(/[^0-9]/g, '');
}

async function queryAgrupadoPorNit(
  cid: string,
  anio: string,
  prefijos: string[],
  cutoffDate?: string,
): Promise<RawRow[]> {
  const desde = anio + '-01-01';
  const hasta = anio + '-12-31';
  const qb = AppDataSource.getRepository(LineaAsiento)
    .createQueryBuilder('l')
    .innerJoin('l.asiento', 'a')
    .leftJoin('l.tercero', 't')
    // Hallazgo #30: preferir el tercero_id (FK real) y su NIT canónico en
    // `terceros.nit` sobre el campo de texto libre `tercero_nit`, que puede
    // tener el mismo NIT escrito con formatos distintos y fragmentar el
    // reporte. Cuando no hay tercero_id (dato legado), se agrupa por el
    // texto crudo sin normalizar aquí — se normaliza después en JS.
    .select('COALESCE(l.tercero_id, l.tercero_nit)', 'agrupador')
    .addSelect('COALESCE(t.nit, l.tercero_nit)', 'nit')
    .addSelect('l.cuenta_codigo', 'cuenta')
    .addSelect('SUM(CAST(l.debito AS FLOAT))', 'debito')
    .addSelect('SUM(CAST(l.credito AS FLOAT))', 'credito')
    .where('a.company_id = :cid', { cid })
    .andWhere('a.estado = :e', { e: 'aprobado' });

  if (cutoffDate) {
    qb.andWhere('a.fecha <= :cutoff', { cutoff: cutoffDate });
  } else {
    qb.andWhere('a.fecha BETWEEN :desde AND :hasta', { desde, hasta });
  }

  const orParts: string[] = [];
  const orParams: Record<string, string> = {};
  prefijos.forEach((p, i) => {
    orParts.push(`l.cuenta_codigo LIKE :p${i}`);
    orParams[`p${i}`] = p + '%';
  });
  qb.andWhere(`(${orParts.join(' OR ')})`, orParams)
    .groupBy('agrupador')
    .addGroupBy('nit')
    .addGroupBy('l.cuenta_codigo');

  const rows = await qb.getRawMany<RawRow & { agrupador: string }>();
  // Fusión final en JS: filas con distinto tercero_id/texto crudo pero cuyo
  // NIT normalizado coincide (mismo tercero escrito distinto) se combinan
  // en una sola fila antes de devolver, para no fragmentar el reporte.
  const merged = new Map<string, RawRow>();
  for (const r of rows) {
    const key = normalizeNit(r.nit) || r.agrupador || '';
    const prev = merged.get(key + '|' + r.cuenta);
    if (prev) {
      prev.debito = String((+prev.debito || 0) + (+r.debito || 0));
      prev.credito = String((+prev.credito || 0) + (+r.credito || 0));
    } else {
      merged.set(key + '|' + r.cuenta, { nit: r.nit, cuenta: r.cuenta, debito: r.debito, credito: r.credito });
    }
  }
  return Array.from(merged.values());
}

/**
 * Hallazgo #31: el corte del Formato 1008 usa `<año>-12-31` fijo — si hay
 * asientos aprobados con fecha posterior a ese corte (por digitación
 * incorrecta, ej. año mal tecleado), antes se excluían del reporte sin
 * ningún aviso. Se cuenta cuántos hay para poder advertirlo en la respuesta.
 */
async function contarAsientosFechaFutura(cid: string, cutoffDate: string): Promise<number> {
  const anio = cutoffDate.slice(0, 4);
  const row = await AppDataSource.getRepository(LineaAsiento)
    .createQueryBuilder('l')
    .innerJoin('l.asiento', 'a')
    .select('COUNT(DISTINCT a.id)', 'count')
    .where('a.company_id = :cid', { cid })
    .andWhere('a.estado = :e', { e: 'aprobado' })
    .andWhere('a.fecha > :cutoff', { cutoff: cutoffDate })
    .andWhere('a.fecha < :hastaSiguiente', { hastaSiguiente: `${+anio + 1}-12-31` })
    .getRawOne<{ count: string }>();
  return +(row?.count || 0);
}

interface TerceroRow {
  nit: string;
  nombre: string;
  cuentas: string;
  debito: number;
  credito: number;
  valor: number;
  reportable: boolean;
}

function procesarFilas(
  rows: RawRow[],
  tipo: 'debito' | 'credito' | 'saldo',
  nitMap: Map<string, string>,
  cuantia: number,
): TerceroRow[] {
  const byNit = new Map<string, { nit: string; nombre: string; cuentas: Set<string>; debito: number; credito: number }>();
  for (const r of rows) {
    const nit = r.nit || '';
    if (!byNit.has(nit)) {
      byNit.set(nit, { nit, nombre: nitMap.get(nit) || '', cuentas: new Set(), debito: 0, credito: 0 });
    }
    const entry = byNit.get(nit)!;
    entry.cuentas.add(r.cuenta);
    entry.debito += +r.debito || 0;
    entry.credito += +r.credito || 0;
  }

  return Array.from(byNit.values())
    .map(e => {
      const valor = tipo === 'debito' ? e.debito
                  : tipo === 'credito' ? e.credito
                  : (e.debito - e.credito);
      return {
        nit: e.nit,
        nombre: e.nombre,
        cuentas: Array.from(e.cuentas).sort().join(', '),
        debito: e.debito,
        credito: e.credito,
        valor,
        reportable: cuantia > 0 ? Math.abs(valor) >= cuantia : true,
      };
    })
    .filter(e => Math.abs(e.valor) > 0.009)
    .sort((a, b) => b.valor - a.valor);
}

function buildExcelBuffer(
  titulo: string,
  subtitulo: string,
  headers: string[],
  rowFn: (t: TerceroRow) => any[],
  terceros: TerceroRow[],
  sheetName: string,
): Buffer {
  const wb = XLSX.utils.book_new();
  const data: any[][] = [
    [titulo],
    [subtitulo],
    [],
    headers,
    ...terceros.map(rowFn),
    [],
    ['TOTAL', '', '',...headers.slice(3).map((_h, i) => i === 0 ? terceros.reduce((s, t) => s + t.valor, 0) : '')],
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 18 }, { wch: 40 }, { wch: 22 }, { wch: 16 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ── Formato 1001: Pagos o abonos en cuenta (cuentas 5xxx y 6xxx) ──────────────

router.get('/1001', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const anio = (req.query.anio as string) || new Date().getFullYear().toString();
    const cuantia = +(req.query.cuantia || 0);
    const [rows, nitMap] = await Promise.all([
      queryAgrupadoPorNit(cid, anio, ['5', '6']),
      buildNitMap(cid),
    ]);
    const terceros = procesarFilas(rows, 'debito', nitMap, cuantia);
    const reportables = terceros.filter(t => t.reportable);
    res.json({
      anio, cuantia, terceros,
      total: terceros.reduce((s, t) => s + t.valor, 0),
      total_reportables: reportables.length,
      total_reportable: reportables.reduce((s, t) => s + t.valor, 0),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error generando Formato 1001' });
  }
});

router.get('/1001/export-excel', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const anio = (req.query.anio as string) || new Date().getFullYear().toString();
    const cuantia = +(req.query.cuantia || 0);
    const [rows, nitMap] = await Promise.all([
      queryAgrupadoPorNit(cid, anio, ['5', '6']),
      buildNitMap(cid),
    ]);
    const terceros = procesarFilas(rows, 'debito', nitMap, cuantia).filter(t => t.reportable);
    const buf = buildExcelBuffer(
      'FORMATO 1001 - PAGOS O ABONOS EN CUENTA Y RETENCIONES PRACTICADAS',
      `Año gravable: ${anio} | Cuantía mínima: ${cuantia.toLocaleString('es-CO')}`,
      ['NIT/Documento', 'Razón Social / Nombre', 'Cuentas PUC', 'Valor Pagado', 'Ret. Fuente (0)'],
      t => [t.nit || 'SIN NIT', t.nombre || '', t.cuentas, t.valor, 0],
      terceros,
      'Formato 1001',
    );
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="exogena-1001-${anio}.xlsx"`);
    res.send(buf);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error exportando Formato 1001' });
  }
});

// ── Formato 1007: Ingresos recibidos (cuentas 4xxx) ───────────────────────────

router.get('/1007', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const anio = (req.query.anio as string) || new Date().getFullYear().toString();
    const cuantia = +(req.query.cuantia || 0);
    const [rows, nitMap] = await Promise.all([
      queryAgrupadoPorNit(cid, anio, ['4']),
      buildNitMap(cid),
    ]);
    const terceros = procesarFilas(rows, 'credito', nitMap, cuantia);
    const reportables = terceros.filter(t => t.reportable);
    res.json({
      anio, cuantia, terceros,
      total: terceros.reduce((s, t) => s + t.valor, 0),
      total_reportables: reportables.length,
      total_reportable: reportables.reduce((s, t) => s + t.valor, 0),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error generando Formato 1007' });
  }
});

router.get('/1007/export-excel', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const anio = (req.query.anio as string) || new Date().getFullYear().toString();
    const cuantia = +(req.query.cuantia || 0);
    const [rows, nitMap] = await Promise.all([
      queryAgrupadoPorNit(cid, anio, ['4']),
      buildNitMap(cid),
    ]);
    const terceros = procesarFilas(rows, 'credito', nitMap, cuantia).filter(t => t.reportable);
    const buf = buildExcelBuffer(
      'FORMATO 1007 - INGRESOS RECIBIDOS',
      `Año gravable: ${anio} | Cuantía mínima: ${cuantia.toLocaleString('es-CO')}`,
      ['NIT/Documento', 'Razón Social / Nombre', 'Cuentas PUC', 'Valor Ingreso'],
      t => [t.nit || 'SIN NIT', t.nombre || '', t.cuentas, t.valor],
      terceros,
      'Formato 1007',
    );
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="exogena-1007-${anio}.xlsx"`);
    res.send(buf);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error exportando Formato 1007' });
  }
});

// ── Formato 1008: Saldos de cuentas por cobrar (cuentas 13xx, al 31-dic) ──────

router.get('/1008', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const anio = (req.query.anio as string) || new Date().getFullYear().toString();
    const cuantia = +(req.query.cuantia || 0);
    const cutoffDate = anio + '-12-31';
    const [rows, nitMap] = await Promise.all([
      queryAgrupadoPorNit(cid, anio, ['13'], cutoffDate),
      buildNitMap(cid),
    ]);
    const terceros = procesarFilas(rows, 'saldo', nitMap, cuantia).filter(t => t.valor > 0);
    const reportables = terceros.filter(t => t.reportable);
    const asientosFechaFutura = await contarAsientosFechaFutura(cid, cutoffDate);
    res.json({
      anio, cuantia, terceros,
      total: terceros.reduce((s, t) => s + t.valor, 0),
      total_reportables: reportables.length,
      total_reportable: reportables.reduce((s, t) => s + t.valor, 0),
      advertencia_asientos_fecha_futura: asientosFechaFutura,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error generando Formato 1008' });
  }
});

router.get('/1008/export-excel', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const anio = (req.query.anio as string) || new Date().getFullYear().toString();
    const cuantia = +(req.query.cuantia || 0);
    const cutoffDate = anio + '-12-31';
    const [rows, nitMap] = await Promise.all([
      queryAgrupadoPorNit(cid, anio, ['13'], cutoffDate),
      buildNitMap(cid),
    ]);
    const terceros = procesarFilas(rows, 'saldo', nitMap, cuantia).filter(t => t.valor > 0 && t.reportable);
    const buf = buildExcelBuffer(
      'FORMATO 1008 - SALDOS DE CUENTAS POR COBRAR',
      `Año gravable: ${anio} (saldo a 31 de diciembre) | Cuantía mínima: ${cuantia.toLocaleString('es-CO')}`,
      ['NIT/Documento', 'Razón Social / Nombre', 'Cuentas PUC', 'Saldo Cartera'],
      t => [t.nit || 'SIN NIT', t.nombre || '', t.cuentas, t.valor],
      terceros,
      'Formato 1008',
    );
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="exogena-1008-${anio}.xlsx"`);
    res.send(buf);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error exportando Formato 1008' });
  }
});

export default router;
