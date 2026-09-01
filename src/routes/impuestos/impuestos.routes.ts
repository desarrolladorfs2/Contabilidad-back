import { Router, Response } from 'express';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../../config/database';
import { Factura } from '../../entities/Invoice';
import { ReceivedInvoice } from '../../entities/ReceivedInvoice';
import { ConfiguracionImpuesto } from '../../entities/impuestos/ConfiguracionImpuesto';
import { TarifaRetencion } from '../../entities/impuestos/TarifaRetencion';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';

const router = Router();
router.use(authMiddleware);

// Hallazgo #48: tarifas antes hardcodeadas en el código — ahora se leen de
// `ConfiguracionImpuesto`/`TarifaRetencion` cuando la empresa las configuró,
// y solo si no hay nada configurado se usa el valor por defecto histórico
// (para no romper empresas que aún no han diligenciado su configuración).
const TARIFA_ICA_DEFAULT = 0.0066;
const TARIFA_RETEFUENTE_SERVICIOS_DEFAULT = 0.04;

/** Tarifa de ICA efectiva de la empresa (fracción, ej. 0.0066 = 6.6 x mil). */
async function getTarifaIca(cid: string): Promise<number> {
  const cfg = await AppDataSource.getRepository(ConfiguracionImpuesto)
    .findOne({ where: { company_id: cid, tipo: 'ica' } });
  if (cfg?.tarifa_pct != null) return Number(cfg.tarifa_pct) / 1000; // tarifa_pct se guarda "x mil"
  return TARIFA_ICA_DEFAULT;
}

/** Tarifa de retefuente por servicios efectiva (fracción, ej. 0.04 = 4%). Prioriza
 * la tarifa personalizada de la empresa sobre la tarifa global (company_id null). */
async function getTarifaRetefuenteServicios(cid: string): Promise<number> {
  const repo = AppDataSource.getRepository(TarifaRetencion);
  const propia = await repo.findOne({ where: { company_id: cid, tipo: 'retefuente', concepto_codigo: 'SVC', activa: true } });
  if (propia) return Number(propia.tarifa_pct) / 100;
  const global = await repo.findOne({ where: { company_id: IsNull(), tipo: 'retefuente', concepto_codigo: 'SVC', activa: true } });
  if (global) return Number(global.tarifa_pct) / 100;
  return TARIFA_RETEFUENTE_SERVICIOS_DEFAULT;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function resolveRange(query: Record<string, string>): { start: string; end: string } {
  if (query['desde'] && query['hasta']) {
    return { start: query['desde'], end: query['hasta'] };
  }
  const periodo = query['periodo'] || new Date().toISOString().slice(0, 7);
  const [y, m] = periodo.split('-').map(Number);
  return {
    start: new Date(y, m - 1, 1).toISOString().slice(0, 10),
    end:   new Date(y, m, 0).toISOString().slice(0, 10),
  };
}

// GET /api/impuestos/iva?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
router.get('/iva', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { start, end } = resolveRange(req.query as Record<string, string>);
    const APROBADAS = ['aprobada', 'aceptada'];

    const ventasRaw = await AppDataSource.getRepository(Factura)
      .createQueryBuilder('i')
      .select('COALESCE(SUM(CAST(i.iva_total AS FLOAT)),0)', 'iva')
      .addSelect('COALESCE(SUM(CAST(i.subtotal AS FLOAT)),0)', 'base')
      .addSelect('COUNT(*)', 'count')
      .where('i.company_id = :cid', { cid })
      .andWhere('i.estado IN (:...st)', { st: APROBADAS })
      .andWhere('i.fecha_emision BETWEEN :s AND :e', { s: start, e: end })
      .getRawOne<{ iva: string; base: string; count: string }>();

    const comprasRaw = await AppDataSource.getRepository(ReceivedInvoice)
      .createQueryBuilder('r')
      .select('COALESCE(SUM(CAST(r.total AS FLOAT) * 0.19 / 1.19), 0)', 'iva_descontable')
      .addSelect('COALESCE(SUM(CAST(r.total AS FLOAT)),0)', 'total_compras')
      .addSelect('COUNT(*)', 'count')
      .where('r.company_id = :cid', { cid })
      .andWhere('r.status IN (:...st)', { st: ['aceptada', 'bien_recibido', 'acuse_enviado'] })
      .andWhere('r.invoice_date BETWEEN :s AND :e', { s: start, e: end })
      .getRawOne<{ iva_descontable: string; total_compras: string; count: string }>();

    const iva_generado    = +(ventasRaw?.iva || 0);
    const base_ventas     = +(ventasRaw?.base || 0);
    const iva_descontable = +(comprasRaw?.iva_descontable || 0);
    const saldo           = iva_generado - iva_descontable;

    const facturas = await AppDataSource.getRepository(Factura)
      .createQueryBuilder('i')
      .select(['i.numero_factura', 'i.fecha_emision', 'i.cliente_nombre', 'i.cliente_nit',
               'i.subtotal', 'i.iva_total', 'i.inc_total', 'i.total'])
      .where('i.company_id = :cid', { cid })
      .andWhere('i.estado IN (:...st)', { st: APROBADAS })
      .andWhere('i.fecha_emision BETWEEN :s AND :e', { s: start, e: end })
      .andWhere('CAST(i.iva_total AS FLOAT) > 0')
      .orderBy('i.fecha_emision', 'ASC')
      .getRawMany();

    res.json({
      desde: start, hasta: end,
      resumen: {
        base_ventas, iva_generado, iva_descontable, saldo,
        facturas_ventas:  +(ventasRaw?.count || 0),
        facturas_compras: +(comprasRaw?.count || 0),
      },
      facturas_detalle: facturas,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error calculando IVA' });
  }
});

// GET /api/impuestos/retenciones?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
router.get('/retenciones', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { start, end } = resolveRange(req.query as Record<string, string>);

    const recibidas = await AppDataSource.getRepository(ReceivedInvoice)
      .createQueryBuilder('r')
      .where('r.company_id = :cid', { cid })
      .andWhere('r.invoice_date BETWEEN :s AND :e', { s: start, e: end })
      .orderBy('r.invoice_date', 'ASC')
      .getMany();

    const tarifaServicios = await getTarifaRetefuenteServicios(cid);

    interface RetCategory { base: number; retencion: number; count: number; tarifa: number; }
    const categorias: Record<string, RetCategory> = {
      'Servicios':  { base: 0, retencion: 0, count: 0, tarifa: tarifaServicios },
      'Honorarios': { base: 0, retencion: 0, count: 0, tarifa: 0.11 },
      'Compras':    { base: 0, retencion: 0, count: 0, tarifa: 0.035 },
    };

    let total_retenido = 0;
    const detalle = recibidas.map(r => {
      const base      = +r.total / 1.19;
      const retencion = base * tarifaServicios;
      categorias['Servicios'].base      += base;
      categorias['Servicios'].retencion += retencion;
      categorias['Servicios'].count++;
      total_retenido += retencion;
      return {
        invoice_id: r.invoice_id, invoice_date: r.invoice_date,
        provider_nit: r.provider_nit, provider_name: r.provider_name,
        total: +r.total, base_retencion: Math.round(base * 100) / 100,
        retencion: Math.round(retencion * 100) / 100, tarifa_pct: tarifaServicios * 100,
        concepto: 'Servicios',
      };
    });

    res.json({
      desde: start, hasta: end,
      resumen: {
        total_base: recibidas.reduce((s, r) => s + +r.total, 0),
        total_retenido,
        count: recibidas.length,
      },
      categorias,
      detalle,
    });
  } catch (e) {
    res.status(500).json({ error: 'Error calculando retenciones' });
  }
});

// GET /api/impuestos/ica?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
router.get('/ica', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { start, end } = resolveRange(req.query as Record<string, string>);
    const APROBADAS = ['aprobada', 'aceptada'];

    const ingresos = await AppDataSource.getRepository(Factura)
      .createQueryBuilder('i')
      .select('COALESCE(SUM(CAST(i.subtotal AS FLOAT)),0)', 'base')
      .addSelect('COUNT(*)', 'count')
      .where('i.company_id = :cid', { cid })
      .andWhere('i.estado IN (:...st)', { st: APROBADAS })
      .andWhere('i.fecha_emision BETWEEN :s AND :e', { s: start, e: end })
      .getRawOne<{ base: string; count: string }>();

    const base         = +(ingresos?.base || 0);
    const tarifa_ica   = await getTarifaIca(cid);
    const ica_estimado = base * tarifa_ica;

    res.json({
      desde: start, hasta: end,
      base_gravable:  base,
      tarifa_pct:     tarifa_ica * 1000,
      tarifa_mil:     tarifa_ica,
      ica_estimado,
      facturas_count: +(ingresos?.count || 0),
      nota: 'Tarifa estimada 6.6 x mil. Verificar tarifa según actividad económica y municipio.',
    });
  } catch (e) {
    res.status(500).json({ error: 'Error calculando ICA' });
  }
});

// GET /api/impuestos/resumen?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
router.get('/resumen', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const desde = (req.query['desde'] as string) || `${new Date().getFullYear()}-01-01`;
    const hasta = (req.query['hasta'] as string) || new Date().toISOString().slice(0, 10);
    const APROBADAS = ['aprobada', 'aceptada'];

    // Generar lista de meses en el rango
    const meses: any[] = [];
    const cur = new Date(desde.slice(0, 7) + '-01');
    const endMonth = new Date(hasta.slice(0, 7) + '-01');

    const MESES_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

    // Hallazgo #48: tarifas configurables por empresa, calculadas una sola vez
    // (no cambian mes a mes) en vez de hardcodeadas dentro del loop.
    const [tarifaRetServicios, tarifaIca] = await Promise.all([
      getTarifaRetefuenteServicios(cid),
      getTarifaIca(cid),
    ]);

    while (cur <= endMonth) {
      const y = cur.getFullYear();
      const m = cur.getMonth();
      const mesStr   = `${y}-${String(m + 1).padStart(2, '0')}`;
      const mesStart = new Date(y, m, 1).toISOString().slice(0, 10);
      const mesEnd   = new Date(y, m + 1, 0).toISOString().slice(0, 10);

      // IVA
      const [ventasRaw, comprasRaw] = await Promise.all([
        AppDataSource.getRepository(Factura)
          .createQueryBuilder('i')
          .select('COALESCE(SUM(CAST(i.iva_total AS FLOAT)),0)', 'iva')
          .addSelect('COALESCE(SUM(CAST(i.subtotal AS FLOAT)),0)', 'base')
          .where('i.company_id = :cid', { cid })
          .andWhere('i.estado IN (:...st)', { st: APROBADAS })
          .andWhere('i.fecha_emision BETWEEN :s AND :e', { s: mesStart, e: mesEnd })
          .getRawOne<{ iva: string; base: string }>(),
        AppDataSource.getRepository(ReceivedInvoice)
          .createQueryBuilder('r')
          .select('COALESCE(SUM(CAST(r.total AS FLOAT) * 0.19 / 1.19), 0)', 'iva_desc')
          .addSelect('COALESCE(SUM(CAST(r.total AS FLOAT)),0)', 'total')
          .where('r.company_id = :cid', { cid })
          .andWhere('r.status IN (:...st)', { st: ['aceptada', 'bien_recibido', 'acuse_enviado'] })
          .andWhere('r.invoice_date BETWEEN :s AND :e', { s: mesStart, e: mesEnd })
          .getRawOne<{ iva_desc: string; total: string }>(),
      ]);

      const iva_generado    = +(ventasRaw?.iva || 0);
      const iva_descontable = +(comprasRaw?.iva_desc || 0);
      const iva_saldo       = iva_generado - iva_descontable;

      // Retenciones
      const recibidas = await AppDataSource.getRepository(ReceivedInvoice)
        .createQueryBuilder('r')
        .select('COALESCE(SUM(CAST(r.total AS FLOAT) / 1.19), 0)', 'base')
        .where('r.company_id = :cid', { cid })
        .andWhere('r.invoice_date BETWEEN :s AND :e', { s: mesStart, e: mesEnd })
        .getRawOne<{ base: string }>();
      const retenciones = +(recibidas?.base || 0) * tarifaRetServicios;

      // ICA
      const ingresosRaw = await AppDataSource.getRepository(Factura)
        .createQueryBuilder('i')
        .select('COALESCE(SUM(CAST(i.subtotal AS FLOAT)),0)', 'base')
        .where('i.company_id = :cid', { cid })
        .andWhere('i.estado IN (:...st)', { st: APROBADAS })
        .andWhere('i.fecha_emision BETWEEN :s AND :e', { s: mesStart, e: mesEnd })
        .getRawOne<{ base: string }>();
      const ica = +(ingresosRaw?.base || 0) * tarifaIca;

      const total_obligaciones = Math.max(iva_saldo, 0) + retenciones + ica;

      meses.push({
        mes: mesStr,
        mes_nombre: `${MESES_ES[m]} ${y}`,
        iva: { generado: iva_generado, descontable: iva_descontable, saldo: iva_saldo },
        retenciones,
        ica,
        total_obligaciones,
      });

      cur.setMonth(cur.getMonth() + 1);
    }

    const totales = meses.reduce((acc, m) => ({
      iva_generado:    acc.iva_generado    + m.iva.generado,
      iva_descontable: acc.iva_descontable + m.iva.descontable,
      iva_saldo:       acc.iva_saldo       + m.iva.saldo,
      retenciones:     acc.retenciones     + m.retenciones,
      ica:             acc.ica             + m.ica,
      total:           acc.total           + m.total_obligaciones,
    }), { iva_generado: 0, iva_descontable: 0, iva_saldo: 0, retenciones: 0, ica: 0, total: 0 });

    res.json({ desde, hasta, meses, totales });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error generando resumen de impuestos' });
  }
});

export default router;
