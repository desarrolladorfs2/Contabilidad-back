import { Router, Response } from 'express';
import { AppDataSource } from '../../config/database';
import { PresupuestoCentroCosto } from '../../entities/contabilidad/PresupuestoCentroCosto';
import { CentroCosto } from '../../entities/contabilidad/CentroCosto';
import { LineaAsiento } from '../../entities/contabilidad/LineaAsiento';
import { CuentaPUC } from '../../entities/contabilidad/CuentaPUC';
import { authMiddleware, requireRole, AuthRequest } from '../../middleware/auth.middleware';

const router = Router();
router.use(authMiddleware);

const repo = () => AppDataSource.getRepository(PresupuestoCentroCosto);

const MESES_NOMBRES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

// GET /api/contabilidad/presupuestos-cc?anio=&centro_costo_id=&cuenta_puc_id=&aprobado=
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { anio, centro_costo_id, cuenta_puc_id, aprobado } = req.query as Record<string, string>;
    const qb = repo().createQueryBuilder('p')
      .leftJoinAndSelect('p.cuenta_puc', 'cuenta_puc')
      .leftJoinAndSelect('p.aprobado_por', 'aprobado_por')
      .where('p.company_id = :cid', { cid })
      .orderBy('p.anio', 'DESC').addOrderBy('p.mes', 'ASC');
    if (anio) qb.andWhere('p.anio = :a', { a: parseInt(anio) });
    if (centro_costo_id) qb.andWhere('p.centro_costo_id = :ccid', { ccid: centro_costo_id });
    if (cuenta_puc_id) qb.andWhere('p.cuenta_puc_id = :pucid', { pucid: cuenta_puc_id });
    if (aprobado === 'true')  qb.andWhere('p.aprobado = :ap', { ap: true });
    if (aprobado === 'false') qb.andWhere('p.aprobado = :ap', { ap: false });
    res.json(await qb.getMany());
  } catch (e) { res.status(500).json({ error: 'Error listando presupuestos' }); }
});

// POST /api/contabilidad/presupuestos-cc
router.post('/', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { centro_costo_id, cuenta_puc_id, anio, mes, monto, notas } = req.body;
    if (!centro_costo_id || !anio || !monto) { res.status(400).json({ error: 'centro_costo_id, anio y monto son obligatorios' }); return; }
    const cc = await AppDataSource.getRepository(CentroCosto).findOne({ where: { id: centro_costo_id, company_id: cid } });
    if (!cc) { res.status(404).json({ error: 'Centro de costo no encontrado' }); return; }
    if (cuenta_puc_id) {
      const cuenta = await AppDataSource.getRepository(CuentaPUC).findOne({ where: { id: cuenta_puc_id, company_id: cid } });
      if (!cuenta) { res.status(404).json({ error: 'Cuenta PUC no encontrada' }); return; }
    }
    const qb = repo().createQueryBuilder('p')
      .where('p.company_id = :cid AND p.centro_costo_id = :ccid AND p.anio = :anio', { cid, ccid: centro_costo_id, anio });
    if (mes) qb.andWhere('p.mes = :mes', { mes });
    else qb.andWhere('p.mes IS NULL');
    if (cuenta_puc_id) qb.andWhere('p.cuenta_puc_id = :pucid', { pucid: cuenta_puc_id });
    else qb.andWhere('p.cuenta_puc_id IS NULL');
    const existe = await qb.getOne();
    if (existe) { res.status(400).json({ error: 'Ya existe un presupuesto para ese CC, cuenta PUC y periodo' }); return; }
    const item = Object.assign(new PresupuestoCentroCosto(), {
      company_id: cid, centro_costo_id, cuenta_puc_id: cuenta_puc_id || null, anio: parseInt(anio),
      mes: mes ? parseInt(mes) : null, valor_presupuestado: parseFloat(monto), observaciones: notas,
    });
    await repo().save(item);
    res.status(201).json(item);
  } catch (e) { res.status(500).json({ error: 'Error creando presupuesto' }); }
});

// PUT /api/contabilidad/presupuestos-cc/:id
router.put('/:id', requireRole('admin', 'operator'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!item) { res.status(404).json({ error: 'No encontrado' }); return; }
    if (item.aprobado) { res.status(400).json({ error: 'No se puede editar un presupuesto ya aprobado. Rechácelo primero.' }); return; }
    if (req.body.monto !== undefined) item.valor_presupuestado = parseFloat(req.body.monto);
    if (req.body.notas !== undefined) item.observaciones = req.body.notas;
    if (req.body.cuenta_puc_id !== undefined) {
      if (req.body.cuenta_puc_id) {
        const cuenta = await AppDataSource.getRepository(CuentaPUC).findOne({ where: { id: req.body.cuenta_puc_id, company_id: req.user!.companyId } });
        if (!cuenta) { res.status(404).json({ error: 'Cuenta PUC no encontrada' }); return; }
      }
      item.cuenta_puc_id = req.body.cuenta_puc_id || undefined;
    }
    await repo().save(item);
    res.json(item);
  } catch (e) { res.status(500).json({ error: 'Error actualizando presupuesto' }); }
});

// POST /api/contabilidad/presupuestos-cc/:id/aprobar
router.post('/:id/aprobar', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!item) { res.status(404).json({ error: 'No encontrado' }); return; }
    if (item.aprobado) { res.status(400).json({ error: 'El presupuesto ya está aprobado' }); return; }
    item.aprobado = true;
    item.aprobado_por_id = req.user!.id;
    if (req.body?.notas) item.observaciones = req.body.notas;
    await repo().save(item);
    res.json(item);
  } catch (e) { res.status(500).json({ error: 'Error aprobando presupuesto' }); }
});

// POST /api/contabilidad/presupuestos-cc/:id/rechazar
router.post('/:id/rechazar', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!item) { res.status(404).json({ error: 'No encontrado' }); return; }
    item.aprobado = false;
    item.aprobado_por_id = undefined;
    if (req.body?.notas) item.observaciones = req.body.notas;
    await repo().save(item);
    res.json(item);
  } catch (e) { res.status(500).json({ error: 'Error rechazando presupuesto' }); }
});

// DELETE /api/contabilidad/presupuestos-cc/:id
router.delete('/:id', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const item = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!item) { res.status(404).json({ error: 'No encontrado' }); return; }
    await repo().remove(item);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error eliminando presupuesto' }); }
});

// GET /api/contabilidad/presupuestos-cc/vs-ejecutado?anio=&mes=&centro_costo_id=&todo_meses=true
router.get('/vs-ejecutado', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const anio = parseInt((req.query as any).anio) || new Date().getFullYear();
    const mes = (req.query as any).mes ? parseInt((req.query as any).mes) : null;
    const centroCostoId = (req.query as any).centro_costo_id as string | undefined;
    const todoMeses = (req.query as any).todo_meses === 'true';

    // Load all CCs and presupuestos for the year
    let centros = await AppDataSource.getRepository(CentroCosto).find({ where: { company_id: cid } });
    if (centroCostoId) centros = centros.filter(c => c.id === centroCostoId);

    const presupuestos = await repo().createQueryBuilder('p')
      .where('p.company_id = :cid AND p.anio = :anio', { cid, anio })
      .getMany();

    const cuentas = await AppDataSource.getRepository(CuentaPUC).find({ where: { company_id: cid } });
    const tipoMap = Object.fromEntries(cuentas.map(c => [c.codigo, { tipo: c.tipo, naturaleza: c.naturaleza }]));
    // Hallazgo #24: igual que en Estado de Resultados/Balance (#38), se
    // registran los códigos que no estaban en el PUC de la empresa y se
    // clasificaron por heurística de prefijo, para poder advertirlo en vez
    // de fallar en silencio.
    const cuentasSinClasificar = new Set<string>();

    // Helper: sum ejecutado from raw query rows
    function agregaEjecutado(rows: { cc_id: string; codigo: string; td: string; tc: string }[], ccIds?: string[]): Record<string, number> {
      const map: Record<string, number> = {};
      for (const r of rows) {
        if (ccIds && !ccIds.includes(r.cc_id)) continue;
        const info = tipoMap[r.codigo];
        if (!info) cuentasSinClasificar.add(r.codigo);
        const tipo = info?.tipo || (r.codigo.startsWith('5') ? 'gasto' : r.codigo.startsWith('6') ? 'costo' : null);
        if (!tipo || !['gasto','costo'].includes(tipo)) continue;
        const nat = info?.naturaleza || 'debito';
        const val = nat === 'debito' ? (+r.td - +r.tc) : (+r.tc - +r.td);
        map[r.cc_id] = (map[r.cc_id] || 0) + val;
      }
      return map;
    }

    // ── MODO TODO MESES: desglose mensual ─────────────────────────────────
    if (todoMeses) {
      // One query for full year, group by month + cc_id
      const ccIds = centros.map(c => c.id);
      const rawYear = await AppDataSource.getRepository(LineaAsiento)
        .createQueryBuilder('l')
        .innerJoin('l.asiento', 'a')
        .select('l.centro_costo_id', 'cc_id')
        .addSelect('l.cuenta_codigo', 'codigo')
        .addSelect("strftime('%m', a.fecha)", 'mes_str')
        .addSelect('SUM(CAST(l.debito AS FLOAT))', 'td')
        .addSelect('SUM(CAST(l.credito AS FLOAT))', 'tc')
        .where('a.company_id = :cid AND a.estado = :e', { cid, e: 'aprobado' })
        .andWhere(`a.fecha BETWEEN :s AND :eh`, { s: `${anio}-01-01`, eh: `${anio}-12-31` })
        .andWhere('l.centro_costo_id IS NOT NULL')
        .groupBy('l.centro_costo_id')
        .addGroupBy('l.cuenta_codigo')
        .addGroupBy("strftime('%m', a.fecha)")
        .getRawMany<{ cc_id: string; codigo: string; mes_str: string; td: string; tc: string }>();

      // Group ejecutado by mes -> cc_id
      const ejPorMes: Record<number, Record<string, number>> = {};
      for (const r of rawYear) {
        const m = parseInt(r.mes_str);
        if (!ejPorMes[m]) ejPorMes[m] = {};
        const info = tipoMap[r.codigo];
        if (!info) cuentasSinClasificar.add(r.codigo);
        const tipo = info?.tipo || (r.codigo.startsWith('5') ? 'gasto' : r.codigo.startsWith('6') ? 'costo' : null);
        if (!tipo || !['gasto','costo'].includes(tipo)) continue;
        const nat = info?.naturaleza || 'debito';
        const val = nat === 'debito' ? (+r.td - +r.tc) : (+r.tc - +r.td);
        if (ccIds.includes(r.cc_id)) {
          ejPorMes[m] = ejPorMes[m] || {};
          ejPorMes[m][r.cc_id] = (ejPorMes[m][r.cc_id] || 0) + val;
        }
      }

      const mesesResult = Array.from({ length: 12 }, (_, i) => {
        const m = i + 1;
        const ejMap = ejPorMes[m] || {};
        let presupuestado = 0;
        let ejecutado = 0;
        for (const cc of centros) {
          // Monthly override first, then annual/12 — se suman TODAS las filas del
          // periodo (presupuesto general + desglose por cuenta PUC específica).
          const pMesRows = presupuestos.filter(p => p.centro_costo_id === cc.id && p.mes === m);
          const pAnualRows = presupuestos.filter(p => p.centro_costo_id === cc.id && (p.mes === null || p.mes === undefined));
          const pval = pMesRows.length
            ? pMesRows.reduce((s, p) => s + +p.valor_presupuestado, 0)
            : (pAnualRows.length ? pAnualRows.reduce((s, p) => s + +p.valor_presupuestado, 0) / 12 : 0);
          presupuestado += pval;
          ejecutado += ejMap[cc.id] || 0;
        }
        const diferencia = presupuestado - ejecutado;
        const pct = presupuestado > 0 ? Math.round((ejecutado / presupuestado) * 100) : null;
        return { mes: m, mes_nombre: MESES_NOMBRES[i], presupuestado, ejecutado, diferencia, pct_ejecucion: pct };
      });

      const totales = mesesResult.reduce((acc, r) => ({
        presupuestado: acc.presupuestado + r.presupuestado,
        ejecutado: acc.ejecutado + r.ejecutado,
        diferencia: acc.diferencia + r.diferencia,
      }), { presupuestado: 0, ejecutado: 0, diferencia: 0 });

      res.json({ anio, centro_costo_id: centroCostoId || null, meses: mesesResult, totales, cuentas_sin_clasificar: Array.from(cuentasSinClasificar) }); return;
    }

    // ── MODO NORMAL: por CC ───────────────────────────────────────────────
    const fechaDesde = anio + '-' + (mes ? String(mes).padStart(2,'0') : '01') + '-01';
    let fechaHasta: string;
    if (mes) {
      const lastDay = new Date(anio, mes, 0).getDate();
      fechaHasta = anio + '-' + String(mes).padStart(2,'0') + '-' + String(lastDay).padStart(2,'0');
    } else {
      fechaHasta = anio + '-12-31';
    }

    const ejecutadoRaw = await AppDataSource.getRepository(LineaAsiento)
      .createQueryBuilder('l')
      .innerJoin('l.asiento', 'a')
      .select('l.centro_costo_id', 'cc_id')
      .addSelect('l.cuenta_codigo', 'codigo')
      .addSelect('SUM(CAST(l.debito AS FLOAT))', 'td')
      .addSelect('SUM(CAST(l.credito AS FLOAT))', 'tc')
      .where('a.company_id = :cid AND a.estado = :e AND a.fecha BETWEEN :s AND :eh', { cid, e: 'aprobado', s: fechaDesde, eh: fechaHasta })
      .andWhere('l.centro_costo_id IS NOT NULL')
      .groupBy('l.centro_costo_id').addGroupBy('l.cuenta_codigo')
      .getRawMany<{ cc_id: string; codigo: string; td: string; tc: string }>();

    const ejecutadoMap = agregaEjecutado(ejecutadoRaw);

    // Hallazgo #23: hasta ahora un presupuesto con `cuenta_puc_id` (presupuesto de
    // una cuenta PUC específica dentro del CC) se sumaba al total presupuestado del
    // CC, pero se comparaba contra el ejecutado TOTAL del CC (todas las cuentas
    // gasto/costo juntas) — un presupuesto de una cuenta puntual nunca se comparaba
    // contra la ejecución de esa cuenta en particular. Se agrega `ejecutadoPorCuenta`
    // (cc_id + código) para poder desglosar la ejecución cuenta a cuenta.
    const cuentaById = new Map(cuentas.map(c => [c.id, c]));
    const ejecutadoPorCuenta: Record<string, Record<string, number>> = {};
    for (const r of ejecutadoRaw) {
      const info = tipoMap[r.codigo];
      const tipo = info?.tipo || (r.codigo.startsWith('5') ? 'gasto' : r.codigo.startsWith('6') ? 'costo' : null);
      if (!tipo || !['gasto','costo'].includes(tipo)) continue;
      const nat = info?.naturaleza || 'debito';
      const val = nat === 'debito' ? (+r.td - +r.tc) : (+r.tc - +r.td);
      ejecutadoPorCuenta[r.cc_id] = ejecutadoPorCuenta[r.cc_id] || {};
      ejecutadoPorCuenta[r.cc_id][r.codigo] = (ejecutadoPorCuenta[r.cc_id][r.codigo] || 0) + val;
    }

    const resultado = centros.map(cc => {
      // Se suman TODAS las filas del periodo para ese CC (presupuesto general +
      // desglose por cuenta PUC específica), no solo la primera que se encuentre.
      const rowsMes = presupuestos.filter(p => p.centro_costo_id === cc.id && (mes ? p.mes === mes : p.mes === null || p.mes === undefined));
      let presupuestado: number | null = null;
      if (rowsMes.length) {
        presupuestado = rowsMes.reduce((s, p) => s + +p.valor_presupuestado, 0);
      } else if (mes) {
        const anualRows = presupuestos.filter(p => p.centro_costo_id === cc.id && (p.mes === null || p.mes === undefined));
        if (anualRows.length) presupuestado = anualRows.reduce((s, p) => s + +p.valor_presupuestado, 0) / 12;
      }
      const ejecutado = ejecutadoMap[cc.id] || 0;
      const diferencia = presupuestado !== null ? presupuestado - ejecutado : null;
      const pct = presupuestado && presupuestado > 0 ? Math.round((ejecutado / presupuestado) * 100) : null;

      // Desglose por cuenta PUC específica — hallazgo #23. Solo incluye las filas de
      // presupuesto de este CC que sí tienen cuenta_puc_id (el presupuesto general
      // del CC, sin cuenta, sigue comparándose contra el total arriba).
      const rowsCuenta = rowsMes.filter(p => !!p.cuenta_puc_id);
      const desglose_cuentas = rowsCuenta.map(p => {
        const cuenta = cuentaById.get(p.cuenta_puc_id!);
        const ejCuenta = (cuenta && ejecutadoPorCuenta[cc.id]?.[cuenta.codigo]) || 0;
        const presCuenta = +p.valor_presupuestado;
        const difCuenta = presCuenta - ejCuenta;
        const pctCuenta = presCuenta > 0 ? Math.round((ejCuenta / presCuenta) * 100) : null;
        return {
          cuenta_puc_id: p.cuenta_puc_id,
          cuenta_codigo: cuenta?.codigo || null,
          cuenta_nombre: cuenta?.nombre || null,
          presupuestado: presCuenta,
          ejecutado: ejCuenta,
          diferencia: difCuenta,
          pct_ejecucion: pctCuenta,
        };
      });

      return { centro_costo_id: cc.id, codigo: cc.codigo, nombre: cc.nombre, tiene_presupuesto: presupuestado !== null, presupuestado, ejecutado, diferencia, pct_ejecucion: pct, desglose_cuentas };
    }).sort((a, b) => a.codigo.localeCompare(b.codigo));

    const totalPresupuestado = resultado.filter(r => r.presupuestado !== null).reduce((s, r) => s + (r.presupuestado || 0), 0);
    const totalEjecutado = resultado.reduce((s, r) => s + r.ejecutado, 0);

    res.json({ anio, mes, fecha_desde: fechaDesde, fecha_hasta: fechaHasta, centros: resultado, totales: { presupuestado: totalPresupuestado, ejecutado: totalEjecutado, diferencia: totalPresupuestado - totalEjecutado }, cuentas_sin_clasificar: Array.from(cuentasSinClasificar) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error generando reporte vs ejecutado' });
  }
});

export default router;
