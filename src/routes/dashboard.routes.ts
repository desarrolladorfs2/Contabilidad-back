import { Router, Response } from 'express';
import { AppDataSource } from '../config/database';
import { Factura } from '../entities/Invoice';
import { NotaCredito } from '../entities/CreditNote';
import { NotaDebito } from '../entities/DebitNote';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';

const router = Router();
router.use(authMiddleware);

/**
 * GET /api/dashboard/stats
 * Devuelve métricas agregadas para el dashboard de la empresa.
 */
router.get('/stats', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const repo   = AppDataSource.getRepository(Factura);
    const repoCN = AppDataSource.getRepository(NotaCredito);
    const repoDN = AppDataSource.getRepository(NotaDebito);
    const APROBADAS = ['aprobada', 'aceptada'];

    // ── Fechas ─────────────────────────────────────────────────────────────
    const now = new Date();

    let y: number;
    let m: number; // 0-indexed
    const monthParam = req.query['month'] as string | undefined;
    if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
      const [py, pm] = monthParam.split('-').map(Number);
      y = py;
      m = pm - 1;
    } else {
      y = now.getFullYear();
      m = now.getMonth();
    }

    const mesStart    = new Date(y, m, 1)    .toISOString().slice(0, 10);
    const mesEnd      = new Date(y, m + 1, 0).toISOString().slice(0, 10);
    const mesAntStart = new Date(y, m - 1, 1).toISOString().slice(0, 10);
    const mesAntEnd   = new Date(y, m, 0)    .toISOString().slice(0, 10);
    const today       = now.toISOString().slice(0, 10);
    const semanas8    = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 56).toISOString().slice(0, 10);

    // ── Ingresos mes actual ────────────────────────────────────────────────
    const rowMes = await repo
      .createQueryBuilder('inv')
      .select('COALESCE(SUM(CAST(inv.total AS FLOAT)), 0)', 'ingresos_mes')
      .where('inv.company_id = :cid', { cid })
      .andWhere('inv.estado IN (:...st)', { st: APROBADAS })
      .andWhere('inv.fecha_emision BETWEEN :s AND :e', { s: mesStart, e: mesEnd })
      .getRawOne<{ ingresos_mes: string }>();
    const ingresos_mes = rowMes?.ingresos_mes ?? '0';

    // ── Ingresos mes anterior ──────────────────────────────────────────────
    const rowAnt = await repo
      .createQueryBuilder('inv')
      .select('COALESCE(SUM(CAST(inv.total AS FLOAT)), 0)', 'ingresos_mes_ant')
      .where('inv.company_id = :cid', { cid })
      .andWhere('inv.estado IN (:...st)', { st: APROBADAS })
      .andWhere('inv.fecha_emision BETWEEN :s AND :e', { s: mesAntStart, e: mesAntEnd })
      .getRawOne<{ ingresos_mes_ant: string }>();
    const ingresos_mes_ant = rowAnt?.ingresos_mes_ant ?? '0';

    // ── Conteo por estado ──────────────────────────────────────────────────
    // Hallazgo #68: a diferencia de las demás métricas (que sí filtran por
    // rango de fechas + estado aprobado), esta es deliberadamente un conteo
    // histórico completo por estado — el objetivo es mostrar la distribución
    // de TODAS las facturas de la empresa (cuántas en borrador/rechazadas/
    // aprobadas a lo largo del tiempo), no solo las del mes. Filtrarla igual
    // que las demás rompería su propósito, así que se deja así a propósito.
    const estadosRaw = await repo
      .createQueryBuilder('inv')
      .select('inv.estado', 'estado')
      .addSelect('COUNT(*)', 'count')
      .where('inv.company_id = :cid', { cid })
      .groupBy('inv.estado')
      .getRawMany<{ estado: string; count: string }>();

    const por_estado: Record<string, number> = {};
    for (const r of estadosRaw) por_estado[r.estado] = +r.count;
    const total_facturas = estadosRaw.reduce((s, r) => s + +r.count, 0);

    // ── Facturas emitidas en el mes ────────────────────────────────────────
    // Hallazgo #68: también deliberadamente sin filtro de estado — es una
    // métrica de "actividad" (cuántas facturas se generaron este mes, sin
    // importar si terminaron aprobadas o rechazadas), distinta de
    // `ingresos_mes` que sí solo cuenta las aprobadas/aceptadas.
    const rowFacturasMes = await repo
      .createQueryBuilder('inv')
      .select('COUNT(*)', 'count')
      .where('inv.company_id = :cid', { cid })
      .andWhere('inv.fecha_emision BETWEEN :s AND :e', { s: mesStart, e: mesEnd })
      .getRawOne<{ count: string }>();
    const facturas_mes = +(rowFacturasMes?.count ?? 0);

    // ── Pendientes de cobro ────────────────────────────────────────────────
    const pendientesRaw = await repo
      .createQueryBuilder('inv')
      .select('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(CAST(inv.total AS FLOAT)), 0)', 'total')
      .where('inv.company_id = :cid', { cid })
      .andWhere('inv.estado IN (:...st)', { st: APROBADAS })
      .andWhere('inv.estado_pago IN (:...ps)', { ps: ['pendiente', 'parcial'] })
      .getRawOne<{ count: string; total: string }>();
    const pendientes_count = +(pendientesRaw?.count ?? 0);
    const pendientes_total = +(pendientesRaw?.total ?? 0) || 0;

    // ── Vencidas ───────────────────────────────────────────────────────────
    // Hallazgo #55: antes no filtraba por estado 'aprobado'/'aceptada', así que
    // una factura en borrador/rechazada con fecha de vencimiento pasada
    // también contaba como "vencida" — ahora solo cuentan facturas realmente
    // aprobadas/emitidas ante la DIAN.
    const vencidasRaw = await repo
      .createQueryBuilder('inv')
      .select('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(CAST(inv.total AS FLOAT)), 0)', 'total')
      .where('inv.company_id = :cid', { cid })
      .andWhere('inv.estado IN (:...st)', { st: APROBADAS })
      .andWhere('inv.fecha_vencimiento < :today', { today })
      .andWhere('inv.estado_pago != :ps', { ps: 'pagada' })
      .getRawOne<{ count: string; total: string }>();
    const vencidas_count = +(vencidasRaw?.count ?? 0);
    const vencidas_total = +(vencidasRaw?.total ?? 0) || 0;

    // ── Notas Crédito del mes ──────────────────────────────────────────────
    // Hallazgo #68: se agrega el filtro de estado aprobado, igual que
    // `ingresos_mes`/`vencidas`/`pendientes` — antes contaba también
    // borradores/rechazadas, inflando la cifra frente al resto del dashboard.
    const rowNC = await repoCN
      .createQueryBuilder('cn')
      .select('COUNT(*)', 'count')
      .where('cn.company_id = :cid', { cid })
      .andWhere('cn.estado IN (:...st)', { st: APROBADAS })
      .andWhere('cn.fecha_emision BETWEEN :s AND :e', { s: mesStart, e: mesEnd })
      .getRawOne<{ count: string }>();
    const nc_count = +(rowNC?.count ?? 0);

    // ── Notas Débito del mes ───────────────────────────────────────────────
    const rowND = await repoDN
      .createQueryBuilder('dn')
      .select('COUNT(*)', 'count')
      .where('dn.company_id = :cid', { cid })
      .andWhere('dn.estado IN (:...st)', { st: APROBADAS })
      .andWhere('dn.fecha_emision BETWEEN :s AND :e', { s: mesStart, e: mesEnd })
      .getRawOne<{ count: string }>();
    const nd_count = +(rowND?.count ?? 0);

    // ── Top 5 clientes ─────────────────────────────────────────────────────
    const top_clientes = await repo
      .createQueryBuilder('inv')
      .select('inv.cliente_nombre', 'nombre')
      .addSelect('inv.cliente_nit', 'nit')
      .addSelect('COALESCE(SUM(CAST(inv.total AS FLOAT)), 0)', 'total')
      .addSelect('COUNT(*)', 'facturas')
      .where('inv.company_id = :cid', { cid })
      .andWhere('inv.estado IN (:...st)', { st: APROBADAS })
      .andWhere('inv.fecha_emision BETWEEN :s AND :e', { s: mesStart, e: mesEnd })
      .groupBy('inv.cliente_nombre')
      .addGroupBy('inv.cliente_nit')
      .orderBy('total', 'DESC')
      .limit(5)
      .getRawMany<{ nombre: string; nit: string; total: string; facturas: string }>();

    // ── Facturación por semana (últimas 8 semanas) ─────────────────────────
    const factsRecientes = await repo
      .createQueryBuilder('inv')
      .select(['inv.fecha_emision', 'inv.total'])
      .where('inv.company_id = :cid', { cid })
      .andWhere('inv.estado IN (:...st)', { st: APROBADAS })
      .andWhere('inv.fecha_emision >= :s', { s: semanas8 })
      .getMany();

    // Generar etiquetas de las últimas 8 semanas
    const semanaMap = new Map<string, number>();
    for (let i = 7; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i * 7);
      const lunes = new Date(d);
      lunes.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const key = lunes.toISOString().slice(0, 10);
      semanaMap.set(key, 0);
    }

    for (const f of factsRecientes) {
      const d = new Date(f.fecha_emision);
      const lunes = new Date(d);
      lunes.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const key = lunes.toISOString().slice(0, 10);
      if (semanaMap.has(key)) {
        semanaMap.set(key, (semanaMap.get(key) ?? 0) + +f.total);
      } else {
        for (const [k] of semanaMap) {
          if (key >= k) { semanaMap.set(k, (semanaMap.get(k) ?? 0) + +f.total); break; }
        }
      }
    }

    const por_semana = Array.from(semanaMap.entries()).map(([fecha_lunes, total]) => ({
      fecha_lunes,
      label: formatSemana(fecha_lunes),
      total,
    }));

    res.json({
      ingresos_mes:     +ingresos_mes     || 0,
      ingresos_mes_ant: +ingresos_mes_ant || 0,
      mes_label:        formatMes(mesStart),
      por_estado,
      total_facturas,
      facturas_mes,
      pendientes_count,
      pendientes_total,
      vencidas_count,
      vencidas_total,
      nc_count,
      nd_count,
      top_clientes: top_clientes.map(c => ({ ...c, total: +c.total, facturas: +c.facturas })),
      por_semana,
    });
  } catch (e) {
    console.error('Dashboard error:', e);
    res.status(500).json({ error: 'Error obteniendo métricas' });
  }
});

function formatMes(iso: string): string {
  const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                 'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const [y, m] = iso.split('-');
  return `${meses[+m - 1]} ${y}`;
}

function formatSemana(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

export default router;
