import { Router, Response } from 'express';
import * as XLSX from 'xlsx';
import { AppDataSource } from '../../config/database';
import { Factura } from '../../entities/Invoice';
import { ReceivedInvoice } from '../../entities/ReceivedInvoice';
import { NotaCredito } from '../../entities/CreditNote';
import { NotaDebito } from '../../entities/DebitNote';
import { Cotizacion } from '../../entities/Cotizacion';
import { Tercero } from '../../entities/Tercero';
import { FacturaSalud } from '../../entities/salud/FacturaSalud';
import { NotaCreditoSalud } from '../../entities/salud/NotaCreditoSalud';
import { NotaDebitoSalud } from '../../entities/salud/NotaDebitoSalud';
import { AsientoContable } from '../../entities/contabilidad/AsientoContable';
import { MovimientoTesoreria } from '../../entities/tesoreria/MovimientoTesoreria';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';

const router = Router();
router.use(authMiddleware);

const APROBADAS = ['aprobada', 'aceptada'];

// GET /api/reportes/ejecutivo?fecha_desde=&fecha_hasta=
router.get('/ejecutivo', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const now = new Date();
    const fecha_desde = (req.query['fecha_desde'] as string) || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const fecha_hasta = (req.query['fecha_hasta'] as string) || now.toISOString().slice(0, 10);

    const invRepo = AppDataSource.getRepository(Factura);
    const recRepo = AppDataSource.getRepository(ReceivedInvoice);

    // Ingresos del período
    const ingresosRaw = await invRepo
      .createQueryBuilder('i')
      .select('COALESCE(SUM(CAST(i.total AS FLOAT)),0)', 'total')
      .addSelect('COALESCE(SUM(CAST(i.subtotal AS FLOAT)),0)', 'subtotal')
      .addSelect('COALESCE(SUM(CAST(i.iva_total AS FLOAT)),0)', 'iva')
      .addSelect('COUNT(*)', 'count')
      .where('i.company_id = :cid', { cid })
      .andWhere('i.estado IN (:...st)', { st: APROBADAS })
      .andWhere('i.fecha_emision BETWEEN :s AND :e', { s: fecha_desde, e: fecha_hasta })
      .getRawOne<{ total: string; subtotal: string; iva: string; count: string }>();

    // Egresos del período (facturas recibidas)
    const egresosRaw = await recRepo
      .createQueryBuilder('r')
      .select('COALESCE(SUM(CAST(r.total AS FLOAT)),0)', 'total')
      .addSelect('COUNT(*)', 'count')
      .where('r.company_id = :cid', { cid })
      .andWhere('r.invoice_date BETWEEN :s AND :e', { s: fecha_desde, e: fecha_hasta })
      .getRawOne<{ total: string; count: string }>();

    const total_ingresos = +(ingresosRaw?.total || 0);
    const total_egresos = +(egresosRaw?.total || 0);
    const utilidad = total_ingresos - total_egresos;
    const margen = total_ingresos > 0 ? (utilidad / total_ingresos) * 100 : 0;

    // Cartera pendiente
    const carteraRaw = await invRepo
      .createQueryBuilder('i')
      .select('COALESCE(SUM(CAST(i.total AS FLOAT)),0)', 'total')
      .addSelect('COUNT(*)', 'count')
      .where('i.company_id = :cid', { cid })
      .andWhere('i.estado IN (:...st)', { st: APROBADAS })
      .andWhere('i.estado_pago IN (:...ps)', { ps: ['pendiente', 'parcial'] })
      .getRawOne<{ total: string; count: string }>();

    // Por estado facturas
    const porEstado = await invRepo
      .createQueryBuilder('i')
      .select('i.estado', 'estado')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(CAST(i.total AS FLOAT)),0)', 'total')
      .where('i.company_id = :cid', { cid })
      .andWhere('i.fecha_emision BETWEEN :s AND :e', { s: fecha_desde, e: fecha_hasta })
      .groupBy('i.estado')
      .getRawMany<{ estado: string; count: string; total: string }>();

    // Top clientes
    const topClientes = await invRepo
      .createQueryBuilder('i')
      .select('i.cliente_nombre', 'nombre')
      .addSelect('i.cliente_nit', 'nit')
      .addSelect('COALESCE(SUM(CAST(i.total AS FLOAT)),0)', 'total')
      .addSelect('COUNT(*)', 'facturas')
      .where('i.company_id = :cid', { cid })
      .andWhere('i.estado IN (:...st)', { st: APROBADAS })
      .andWhere('i.fecha_emision BETWEEN :s AND :e', { s: fecha_desde, e: fecha_hasta })
      .groupBy('i.cliente_nombre').addGroupBy('i.cliente_nit')
      .orderBy('total', 'DESC').limit(10)
      .getRawMany<{ nombre: string; nit: string; total: string; facturas: string }>();

    // Facturación por mes (últimos 12 meses)
    const hace12 = new Date(now); hace12.setMonth(hace12.getMonth() - 11);
    const porMesRaw = await invRepo
      .createQueryBuilder('i')
      .select("SUBSTR(i.fecha_emision, 1, 7)", 'mes')
      .addSelect('COALESCE(SUM(CAST(i.total AS FLOAT)),0)', 'total')
      .addSelect('COUNT(*)', 'count')
      .where('i.company_id = :cid', { cid })
      .andWhere('i.estado IN (:...st)', { st: APROBADAS })
      .andWhere('i.fecha_emision >= :d', { d: hace12.toISOString().slice(0, 10) })
      .groupBy("SUBSTR(i.fecha_emision, 1, 7)")
      .orderBy('mes', 'ASC')
      .getRawMany<{ mes: string; total: string; count: string }>();

    // Tickets promedio, max, min
    const ticketRaw = await invRepo
      .createQueryBuilder('i')
      .select('AVG(CAST(i.total AS FLOAT))', 'promedio')
      .addSelect('MAX(CAST(i.total AS FLOAT))', 'maximo')
      .addSelect('MIN(CAST(i.total AS FLOAT))', 'minimo')
      .where('i.company_id = :cid', { cid })
      .andWhere('i.estado IN (:...st)', { st: APROBADAS })
      .andWhere('i.fecha_emision BETWEEN :s AND :e', { s: fecha_desde, e: fecha_hasta })
      .getRawOne<{ promedio: string; maximo: string; minimo: string }>();

    res.json({
      periodo: { fecha_desde, fecha_hasta },
      resumen: {
        total_ingresos, total_egresos, utilidad, margen_pct: margen,
        total_iva: +(ingresosRaw?.iva || 0),
        cartera_pendiente: +(carteraRaw?.total || 0),
        cartera_facturas: +(carteraRaw?.count || 0),
        facturas_count: +(ingresosRaw?.count || 0),
        compras_count: +(egresosRaw?.count || 0),
      },
      ticket: {
        promedio: +(ticketRaw?.promedio || 0),
        maximo: +(ticketRaw?.maximo || 0),
        minimo: +(ticketRaw?.minimo || 0),
      },
      por_estado: porEstado.map(r => ({ status: r.estado, count: +r.count, total: +r.total })),
      top_clientes: topClientes.map(c => ({ ...c, total: +c.total, facturas: +c.facturas })),
      por_mes: porMesRaw.map(r => ({ mes: r.mes, total: +r.total, count: +r.count })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error generando reporte ejecutivo' });
  }
});

// GET /api/reportes/ventas?fecha_desde=&fecha_hasta=&agrupar=mes|semana|cliente
router.get('/ventas', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const now = new Date();
    const fecha_desde = (req.query['fecha_desde'] as string) || new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10);
    const fecha_hasta = (req.query['fecha_hasta'] as string) || now.toISOString().slice(0, 10);
    const agrupar = (req.query['agrupar'] as string) || 'mes';
    const invRepo = AppDataSource.getRepository(Factura);

    let grupo_expr = "SUBSTR(i.fecha_emision, 1, 7)"; // mes por defecto
    if (agrupar === 'semana') grupo_expr = "SUBSTR(i.fecha_emision, 1, 10)";
    if (agrupar === 'cliente') grupo_expr = 'i.cliente_nombre';

    const agrupado = await invRepo
      .createQueryBuilder('i')
      .select(grupo_expr, 'grupo')
      .addSelect('COALESCE(SUM(CAST(i.subtotal AS FLOAT)),0)', 'subtotal')
      .addSelect('COALESCE(SUM(CAST(i.iva_total AS FLOAT)),0)', 'iva')
      .addSelect('COALESCE(SUM(CAST(i.total AS FLOAT)),0)', 'total')
      .addSelect('COUNT(*)', 'count')
      .where('i.company_id = :cid', { cid })
      .andWhere('i.estado IN (:...st)', { st: APROBADAS })
      .andWhere('i.fecha_emision BETWEEN :s AND :e', { s: fecha_desde, e: fecha_hasta })
      .groupBy(grupo_expr)
      .orderBy('total', 'DESC')
      .getRawMany<{ grupo: string; subtotal: string; iva: string; total: string; count: string }>();

    // Detalle de facturas individuales
    const detalle = await invRepo
      .createQueryBuilder('i')
      .select(['i.numero_factura', 'i.fecha_emision', 'i.cliente_nombre', 'i.cliente_nit',
               'i.subtotal', 'i.iva_total', 'i.inc_total', 'i.total', 'i.estado', 'i.estado_pago'])
      .where('i.company_id = :cid', { cid })
      .andWhere('i.estado IN (:...st)', { st: APROBADAS })
      .andWhere('i.fecha_emision BETWEEN :s AND :e', { s: fecha_desde, e: fecha_hasta })
      .orderBy('i.fecha_emision', 'DESC')
      .limit(500)
      .getRawMany();

    res.json({
      periodo: { fecha_desde, fecha_hasta, agrupar },
      agrupado: agrupado.map(r => ({ grupo: r.grupo, subtotal: +r.subtotal, iva: +r.iva, total: +r.total, count: +r.count })),
      detalle,
      totales: {
        subtotal: agrupado.reduce((s: number, r: any) => s + +r.subtotal, 0),
        iva:      agrupado.reduce((s: number, r: any) => s + +r.iva, 0),
        total:    agrupado.reduce((s: number, r: any) => s + +r.total, 0),
        count:    agrupado.reduce((s: number, r: any) => s + +r.count, 0),
      },
    });
  } catch (e) {
    res.status(500).json({ error: 'Error generando reporte de ventas' });
  }
});

// GET /api/reportes/cartera
router.get('/cartera', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const today = new Date().toISOString().slice(0, 10);
    const invRepo = AppDataSource.getRepository(Factura);

    const pendientes = await invRepo
      .createQueryBuilder('i')
      .where('i.company_id = :cid', { cid })
      .andWhere('i.estado IN (:...st)', { st: APROBADAS })
      .andWhere('i.estado_pago IN (:...ps)', { ps: ['pendiente', 'parcial'] })
      .orderBy('i.fecha_vencimiento', 'ASC')
      .getMany();

    const result = pendientes.map(i => {
      const vencimiento = i.fecha_vencimiento ? new Date(i.fecha_vencimiento) : null;
      const diasVencido = vencimiento ? Math.floor((new Date(today).getTime() - vencimiento.getTime()) / 86400000) : 0;
      let tramo = '0-30';
      if (diasVencido > 90) tramo = '>90';
      else if (diasVencido > 60) tramo = '61-90';
      else if (diasVencido > 30) tramo = '31-60';
      return {
        id: i.id, invoice_number: i.numero_factura, issue_date: i.fecha_emision,
        payment_due_date: i.fecha_vencimiento, customer_name: i.cliente_nombre,
        customer_nit: i.cliente_nit, total: +i.total, total_paid: +(i.total_pagado ?? 0),
        saldo: +i.total - +(i.total_pagado ?? 0), dias_vencido: diasVencido, tramo,
        payment_status: i.estado_pago,
      };
    });

    const por_tramo = { '0-30': 0, '31-60': 0, '61-90': 0, '>90': 0 };
    for (const r of result) { por_tramo[r.tramo as keyof typeof por_tramo] += r.saldo; }

    res.json({
      today,
      pendientes: result,
      total_cartera: result.reduce((s, r) => s + r.saldo, 0),
      por_tramo,
      count: result.length,
    });
  } catch (e) {
    res.status(500).json({ error: 'Error generando reporte de cartera' });
  }
});

// ─── Estadísticas por usuario ────────────────────────────────────────────────

type StatRow = { user_id: string; user_name: string; count: number; total: number };

async function queryStats(
  repo: ReturnType<typeof AppDataSource.getRepository>,
  cid: string,
  desde: string,
  hasta: string,
  dateField = 'created_at',
  totalField: string | null = null,
): Promise<StatRow[]> {
  const qb = repo.createQueryBuilder('e')
    .select('e.created_by_user_id', 'user_id')
    .addSelect('MAX(e.created_by_name)', 'user_name')
    .addSelect('COUNT(*)', 'count')
    .where('e.company_id = :cid', { cid })
    .andWhere(`e.${dateField} >= :desde`, { desde })
    .andWhere(`e.${dateField} <= :hasta`, { hasta })
    .andWhere('e.created_by_user_id IS NOT NULL')
    .groupBy('e.created_by_user_id')
    .orderBy('count', 'DESC');

  if (totalField) qb.addSelect(`COALESCE(SUM(CAST(e.${totalField} AS FLOAT)),0)`, 'total');
  else qb.addSelect('0', 'total');

  const rows = await qb.getRawMany<{ user_id: string; user_name: string; count: string; total: string }>();
  return rows.map(r => ({ user_id: r.user_id, user_name: r.user_name || r.user_id, count: +r.count, total: +r.total }));
}

const STAT_MODULES: Record<string, {
  label: string;
  entity: () => ReturnType<typeof AppDataSource.getRepository>;
  dateField?: string;
  totalField?: string;
}> = {
  'facturas':           { label: 'Facturas Comerciales',   entity: () => AppDataSource.getRepository(Factura),           dateField: 'fecha_emision', totalField: 'total' },
  'notas-credito':      { label: 'Notas Crédito',          entity: () => AppDataSource.getRepository(NotaCredito),        dateField: 'fecha_emision' },
  'notas-debito':       { label: 'Notas Débito',           entity: () => AppDataSource.getRepository(NotaDebito),         dateField: 'fecha_emision' },
  'comercial-cotizaciones': { label: 'Cotizaciones',       entity: () => AppDataSource.getRepository(Cotizacion),        dateField: 'fecha_emision', totalField: 'total' },
  'recibidas':          { label: 'Facturas Recibidas',     entity: () => AppDataSource.getRepository(ReceivedInvoice),   dateField: 'invoice_date', totalField: 'total' },
  'terceros':           { label: 'Terceros',               entity: () => AppDataSource.getRepository(Tercero),           dateField: 'created_at' },
  'salud-facturas':     { label: 'Facturas Salud',         entity: () => AppDataSource.getRepository(FacturaSalud),      dateField: 'issue_date', totalField: 'total' },
  'salud-nc':           { label: 'Notas Crédito Salud',    entity: () => AppDataSource.getRepository(NotaCreditoSalud),  dateField: 'issue_date' },
  'salud-nd':           { label: 'Notas Débito Salud',     entity: () => AppDataSource.getRepository(NotaDebitoSalud),   dateField: 'issue_date' },
  'cont-asientos':      { label: 'Asientos Contables',     entity: () => AppDataSource.getRepository(AsientoContable),   dateField: 'fecha' },
  'tes-movimientos':    { label: 'Movimientos Tesorería',  entity: () => AppDataSource.getRepository(MovimientoTesoreria), dateField: 'created_at' },
};

// GET /api/reportes/estadisticas?modulos=facturas,salud-facturas&desde=&hasta=
router.get('/estadisticas', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const now = new Date().toISOString().slice(0, 10);
    const primeroMes = now.slice(0, 7) + '-01';
    const desde = (req.query['desde'] as string) || primeroMes;
    const hasta  = (req.query['hasta']  as string) || now;
    const modulosParam = (req.query['modulos'] as string) || '';
    const keys = modulosParam ? modulosParam.split(',').filter(k => STAT_MODULES[k]) : Object.keys(STAT_MODULES);

    const result: Record<string, { label: string; rows: StatRow[] }> = {};
    for (const key of keys) {
      const def = STAT_MODULES[key];
      result[key] = {
        label: def.label,
        rows: await queryStats(def.entity(), cid, desde, hasta, def.dateField, def.totalField ?? null),
      };
    }
    res.json({ desde, hasta, modulos: result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error generando estadísticas' });
  }
});

// GET /api/reportes/estadisticas/export?modulos=...&desde=&hasta=
router.get('/estadisticas/export', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const now = new Date().toISOString().slice(0, 10);
    const primeroMes = now.slice(0, 7) + '-01';
    const desde = (req.query['desde'] as string) || primeroMes;
    const hasta  = (req.query['hasta']  as string) || now;
    const modulosParam = (req.query['modulos'] as string) || '';
    const keys = modulosParam ? modulosParam.split(',').filter(k => STAT_MODULES[k]) : Object.keys(STAT_MODULES);

    const wb = XLSX.utils.book_new();

    for (const key of keys) {
      const def = STAT_MODULES[key];
      const rows = await queryStats(def.entity(), cid, desde, hasta, def.dateField, def.totalField ?? null);

      const hasTotal = !!def.totalField;
      const header = hasTotal
        ? ['Usuario', 'Cantidad', 'Total ($)']
        : ['Usuario', 'Cantidad'];

      const data = [header, ...rows.map(r =>
        hasTotal ? [r.user_name, r.count, r.total] : [r.user_name, r.count]
      )];

      const ws = XLSX.utils.aoa_to_sheet(data);
      // Column widths
      ws['!cols'] = hasTotal ? [{ wch: 30 }, { wch: 12 }, { wch: 18 }] : [{ wch: 30 }, { wch: 12 }];
      // Sheet name max 31 chars
      const sheetName = def.label.slice(0, 31);
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    }

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="estadisticas_${desde}_${hasta}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error exportando estadísticas' });
  }
});

export default router;

