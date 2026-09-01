import { Router, Response } from 'express';
import { AppDataSource } from '../../config/database';
import { LineaAsiento } from '../../entities/contabilidad/LineaAsiento';
import { CompanySettings } from '../../entities/CompanySettings';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';

/** Hallazgo #33: prefijos de efectivo estándar, usados solo si la empresa no
 * configuró los suyos propios en CompanySettings.flujo_efectivo_cuentas_caja. */
const CASH_DEFAULT = ['1105', '1110', '1115', '1120', '1125'];

async function getCuentasCaja(cid: string): Promise<string[]> {
  const settings = await AppDataSource.getRepository(CompanySettings).findOne({ where: { company_id: cid } });
  const custom = settings?.flujo_efectivo_cuentas_caja;
  if (custom && custom.trim()) {
    const list = custom.split(',').map(s => s.trim()).filter(Boolean);
    if (list.length) return list;
  }
  return CASH_DEFAULT;
}

const router = Router();
router.use(authMiddleware);

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPrefijoCond(prefijos: string[], alias: string, paramBase: string) {
  const parts: string[] = [];
  const params: Record<string, string> = {};
  prefijos.forEach((p, i) => { parts.push(`${alias}.cuenta_codigo LIKE :${paramBase}${i}`); params[`${paramBase}${i}`] = p + '%'; });
  return { cond: `(${parts.join(' OR ')})`, params };
}

function buildExcludeCond(excluir: string[], alias: string, paramBase: string) {
  if (!excluir.length) return null;
  const parts: string[] = [];
  const params: Record<string, string> = {};
  excluir.forEach((p, i) => { parts.push(`${alias}.cuenta_codigo NOT LIKE :${paramBase}${i}`); params[`${paramBase}${i}`] = p + '%'; });
  return { cond: `(${parts.join(' AND ')})`, params };
}

/** Saldo acumulado (debito - credito) de cuentas hasta fecha (exclusive o inclusive) */
async function getSaldo(
  cid: string, prefijos: string[], hasta: string,
  exclusive = false, excluir: string[] = [],
): Promise<number> {
  const qb = AppDataSource.getRepository(LineaAsiento)
    .createQueryBuilder('l')
    .innerJoin('l.asiento', 'a')
    .select('SUM(CAST(l.debito AS FLOAT)) - SUM(CAST(l.credito AS FLOAT))', 'saldo')
    .where('a.company_id = :cid', { cid })
    .andWhere('a.estado = :e', { e: 'aprobado' });

  exclusive
    ? qb.andWhere('a.fecha < :hasta', { hasta })
    : qb.andWhere('a.fecha <= :hasta', { hasta });

  const inc = buildPrefijoCond(prefijos, 'l', 'ip');
  qb.andWhere(inc.cond, inc.params);

  const exc = buildExcludeCond(excluir, 'l', 'ep');
  if (exc) qb.andWhere(exc.cond, exc.params);

  const r = await qb.getRawOne<{ saldo: string }>();
  return +(r?.saldo || 0);
}

/** Movimientos (debito, credito) de cuentas en un período */
async function getMovs(
  cid: string, prefijos: string[], desde: string, hasta: string,
  excluir: string[] = [],
): Promise<{ d: number; c: number }> {
  const qb = AppDataSource.getRepository(LineaAsiento)
    .createQueryBuilder('l')
    .innerJoin('l.asiento', 'a')
    .select('SUM(CAST(l.debito AS FLOAT))', 'd')
    .addSelect('SUM(CAST(l.credito AS FLOAT))', 'c')
    .where('a.company_id = :cid', { cid })
    .andWhere('a.estado = :e', { e: 'aprobado' })
    .andWhere('a.fecha BETWEEN :desde AND :hasta', { desde, hasta });

  const inc = buildPrefijoCond(prefijos, 'l', 'mp');
  qb.andWhere(inc.cond, inc.params);

  const exc = buildExcludeCond(excluir, 'l', 'me');
  if (exc) qb.andWhere(exc.cond, exc.params);

  const r = await qb.getRawOne<{ d: string; c: string }>();
  return { d: +(r?.d || 0), c: +(r?.c || 0) };
}

// ── Cálculo del flujo (extraído a función para reusar en pantalla y export) ────
// Hallazgo #32: antes export-excel hacía un fetch HTTP a localhost:PORT en vez de
// llamar esta lógica directamente — frágil detrás de un proxy/balanceador y con
// latencia/punto de fallo innecesarios.

async function calcularFlujoEfectivo(cid: string, fd: string, fh: string) {
    // Cuentas de efectivo y equivalentes — configurables por empresa (#33)
    const CASH = await getCuentasCaja(cid);

    // ── UTILIDAD NETA ─────────────────────────────────────────────────────────
    const ing  = await getMovs(cid, ['4'], fd, fh);
    const gast = await getMovs(cid, ['5', '6'], fd, fh);
    const utilidadNeta = (ing.c - ing.d) - (gast.d - gast.c);

    // ── DEPRECIACIONES Y AMORTIZACIONES ───────────────────────────────────────
    // Créditos en 1592 (depr acum PPE) y 1680/1682 (amort acum intangibles)
    const depr = await getMovs(cid, ['1592', '1680', '1682'], fd, fh);
    const depreciaciones = depr.c - depr.d;   // aumento en depr acum = gasto no efectivo

    // ── VARIACIONES CAPITAL DE TRABAJO ────────────────────────────────────────
    // Para activos: -(saldo_fin - saldo_ini) → aumento activos = menos efectivo
    // Para pasivos: -(saldo_fin - saldo_ini) → aumento pasivos = más efectivo
    // getSaldo retorna (debito - credito):
    //   activos: positivo    pasivos: negativo
    //   delta positivo activos = más activos = −cash
    //   delta negativo pasivos = más pasivos = +cash  →  negamos en ambos casos

    async function delta(prefijos: string[], excluir: string[] = []): Promise<number> {
      const ini = await getSaldo(cid, prefijos, fd, true,  excluir);
      const fin = await getSaldo(cid, prefijos, fh, false, excluir);
      return -(fin - ini);
    }

    const varCxC          = await delta(['13']);
    const varInventarios  = await delta(['14']);
    const varOtrosActivos = await delta(['17', '18']);
    const varProveedores  = await delta(['22', '23']);
    const varImpuestos    = await delta(['24']);
    const varLaboral      = await delta(['25']);
    const varOtrosPasivos = await delta(['26', '27', '28', '29']);

    const totalOperacion = utilidadNeta + depreciaciones
      + varCxC + varInventarios + varOtrosActivos
      + varProveedores + varImpuestos + varLaboral + varOtrosPasivos;

    // ── ACTIVIDADES DE INVERSIÓN ──────────────────────────────────────────────
    // Neto (créditos − débitos) = ventas − compras
    const ppeM  = await getMovs(cid, ['15'], fd, fh, ['1592', '1596']);
    const intM  = await getMovs(cid, ['16'], fd, fh, ['1680', '1682']);
    const invLPM = await getMovs(cid, ['12'], fd, fh);

    const varPPE        = ppeM.c - ppeM.d;
    const varIntangibles= intM.c - intM.d;
    const varInvLP      = invLPM.c - invLPM.d;
    const totalInversion = varPPE + varIntangibles + varInvLP;

    // ── ACTIVIDADES DE FINANCIACIÓN ───────────────────────────────────────────
    const oblM = await getMovs(cid, ['21'], fd, fh);
    const varObligaciones = oblM.c - oblM.d;   // nuevos préstamos − pagos

    // Aportes de capital: prefijo '31' (CAPITAL SOCIAL), excluyendo '36' (resultados
    // del ejercicio, que ya está reflejado en la utilidad neta). Antes filtraba por
    // '311' pero el PUC base sembrado (puc.routes.ts) solo define el grupo '31' sin
    // ninguna subcuenta '311x', así que esto siempre daba cero — hallazgo #34.
    const capM = await getMovs(cid, ['31'], fd, fh);
    const varCapital = capM.c - capM.d;

    const totalFinanciacion = varObligaciones + varCapital;

    // ── EFECTIVO ──────────────────────────────────────────────────────────────
    const efectivoInicio = await getSaldo(cid, CASH, fd, true);
    const efectivoFin    = await getSaldo(cid, CASH, fh, false);
    const variacionEfectivo   = efectivoFin - efectivoInicio;
    const variacionCalculada  = totalOperacion + totalInversion + totalFinanciacion;
    const diferencia          = variacionEfectivo - variacionCalculada;

    return {
      fecha_desde: fd,
      fecha_hasta: fh,
      actividades_operacion: {
        utilidad_neta: utilidadNeta,
        ajustes: [
          { concepto: 'Depreciaciones y amortizaciones del período', valor: depreciaciones },
        ],
        variaciones_capital_trabajo: [
          { concepto: 'Variación en cuentas por cobrar (13xx)', valor: varCxC },
          { concepto: 'Variación en inventarios (14xx)', valor: varInventarios },
          { concepto: 'Variación en otros activos corrientes (17xx-18xx)', valor: varOtrosActivos },
          { concepto: 'Variación en proveedores y cuentas por pagar (22xx-23xx)', valor: varProveedores },
          { concepto: 'Variación en impuestos por pagar (24xx)', valor: varImpuestos },
          { concepto: 'Variación en obligaciones laborales (25xx)', valor: varLaboral },
          { concepto: 'Variación en otros pasivos corrientes (26xx-29xx)', valor: varOtrosPasivos },
        ],
        total: totalOperacion,
      },
      actividades_inversion: {
        items: [
          { concepto: 'Compra/venta neta propiedad, planta y equipo (15xx)', valor: varPPE },
          { concepto: 'Compra/venta neta intangibles (16xx)', valor: varIntangibles },
          { concepto: 'Variación inversiones de largo plazo (12xx)', valor: varInvLP },
        ],
        total: totalInversion,
      },
      actividades_financiacion: {
        items: [
          { concepto: 'Variación obligaciones financieras (21xx)', valor: varObligaciones },
          { concepto: 'Aportes de capital recibidos (31xx)', valor: varCapital },
        ],
        total: totalFinanciacion,
      },
      efectivo_inicio: efectivoInicio,
      efectivo_fin: efectivoFin,
      variacion_neta: variacionCalculada,
      diferencia_no_clasificada: diferencia,
      cuadra: Math.abs(diferencia) < 1,
    };
}

// ── Endpoint principal ────────────────────────────────────────────────────────

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid     = req.user!.companyId;
    const anio    = new Date().getFullYear();
    const fd      = (req.query.fecha_desde as string) || `${anio}-01-01`;
    const fh      = (req.query.fecha_hasta as string) || `${anio}-12-31`;
    res.json(await calcularFlujoEfectivo(cid, fd, fh));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error generando Estado de Flujos de Efectivo' });
  }
});

// GET /api/contabilidad/flujo-efectivo/export-excel
router.get('/export-excel', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { fecha_desde, fecha_hasta } = req.query as Record<string, string>;
    const year = new Date().getFullYear();
    const desde = fecha_desde || `${year}-01-01`;
    const hasta = fecha_hasta || `${year}-12-31`;

    // Llama la lógica de cálculo directamente — antes hacía un fetch HTTP a
    // localhost:PORT reenviando el token, frágil detrás de un proxy/balanceador
    // y con latencia/punto de fallo innecesarios (hallazgo #32).
    const d: any = await calcularFlujoEfectivo(cid, desde, hasta);

    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const rows: any[][] = [
      [`Estado de Flujos de Efectivo — ${desde} al ${hasta}`], [],
      ['Concepto', 'Valor'],
      ['ACTIVIDADES DE OPERACIÓN', ''],
      ['Utilidad neta del período', d.actividades_operacion.utilidad_neta],
      ...d.actividades_operacion.ajustes.filter((a: any) => a.valor !== 0).map((a: any) => ['  ' + a.concepto, a.valor]),
      ...d.actividades_operacion.variaciones_capital_trabajo.filter((v: any) => v.valor !== 0).map((v: any) => ['  ' + v.concepto, v.valor]),
      ['Efectivo neto de operación', d.actividades_operacion.total],
      [],
      ['ACTIVIDADES DE INVERSIÓN', ''],
      ...d.actividades_inversion.items.filter((i: any) => i.valor !== 0).map((i: any) => ['  ' + i.concepto, i.valor]),
      ['Efectivo neto de inversión', d.actividades_inversion.total],
      [],
      ['ACTIVIDADES DE FINANCIACIÓN', ''],
      ...d.actividades_financiacion.items.filter((i: any) => i.valor !== 0).map((i: any) => ['  ' + i.concepto, i.valor]),
      ['Efectivo neto de financiación', d.actividades_financiacion.total],
      [],
      ['Variación neta del efectivo', d.variacion_neta],
      ['Efectivo al inicio del período', d.efectivo_inicio],
      ['Efectivo al final del período', d.efectivo_fin],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 48 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Flujo de Efectivo');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="flujo-efectivo-${desde}-${hasta}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error exportando flujo de efectivo' }); }
});

export default router;
