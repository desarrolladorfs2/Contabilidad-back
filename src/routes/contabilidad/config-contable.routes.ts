import { Router, Response } from 'express';
import { AppDataSource } from '../../config/database';
import { ConfiguracionContable, EventoContable } from '../../entities/contabilidad/ConfiguracionContable';
import { CuentaPUC } from '../../entities/contabilidad/CuentaPUC';
import { authMiddleware, requireRole, AuthRequest } from '../../middleware/auth.middleware';

const router = Router();
router.use(authMiddleware);

const EVENTOS_LABELS: Record<EventoContable, string> = {
  venta:                 'Venta (ingreso principal)',
  venta_iva:             'IVA en ventas',
  venta_salud:           'Venta de salud (facturación EPS)',
  cobro_pago_usuario_salud: 'Cobro copago/cuota moderadora al paciente (caja/efectivo)',
  cobro_cliente:         'Cobro a cliente (cartera)',
  compra:                'Compra / gasto',
  compra_iva:            'IVA en compras',
  pago_proveedor:        'Pago a proveedor',
  nota_credito_emitida:  'Nota crédito emitida',
  nota_debito_emitida:   'Nota débito emitida',
  nota_credito_recibida: 'Nota crédito recibida',
  nota_debito_recibida:  'Nota débito recibida',
  ingreso_tesoreria:     'Ingreso de tesorería',
  egreso_tesoreria:      'Egreso de tesorería',
  traslado_tesoreria:    'Traslado entre cuentas',
  ajuste_inventario:     'Ajuste de inventario',
  descuento_venta:       'Descuento en ventas',
};

// GET /api/contabilidad/config — todas las configuraciones de la empresa
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const repo = AppDataSource.getRepository(ConfiguracionContable);

    const rows = await repo.find({
      where: { company_id: cid },
      relations: ['cuenta_debito', 'cuenta_credito'],
      order: { evento: 'ASC' },
    });

    // Devolver todos los eventos posibles, con o sin configuración guardada
    const todos = (Object.keys(EVENTOS_LABELS) as EventoContable[]).map(evento => {
      const saved = rows.find(r => r.evento === evento);
      return {
        evento,
        label: EVENTOS_LABELS[evento],
        id:            saved?.id ?? null,
        cuenta_debito:  saved?.cuenta_debito  ?? null,
        cuenta_credito: saved?.cuenta_credito ?? null,
        descripcion:    saved?.descripcion    ?? null,
      };
    });

    res.json(todos);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al obtener configuración contable' });
  }
});

// PUT /api/contabilidad/config/:evento — crear o actualizar una configuración
router.put('/:evento', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid   = req.user!.companyId;
    const evento = req.params.evento as EventoContable;
    if (!EVENTOS_LABELS[evento]) { res.status(400).json({ error: 'Evento no válido' }); return; }

    const { cuenta_debito_id, cuenta_credito_id, descripcion } = req.body as {
      cuenta_debito_id?:  string | null;
      cuenta_credito_id?: string | null;
      descripcion?:       string;
    };

    const repo  = AppDataSource.getRepository(ConfiguracionContable);
    const pucRp = AppDataSource.getRepository(CuentaPUC);

    let cfg = await repo.findOne({ where: { company_id: cid, evento } });
    if (!cfg) {
      cfg = repo.create({ company_id: cid, evento });
    }

    // Validar que las cuentas pertenecen a la empresa
    if (cuenta_debito_id) {
      const d = await pucRp.findOne({ where: { id: cuenta_debito_id, company_id: cid } });
      if (!d) { res.status(404).json({ error: 'Cuenta débito no encontrada' }); return; }
      cfg.cuenta_debito_id = cuenta_debito_id;
    } else {
      cfg.cuenta_debito_id = undefined;
    }

    if (cuenta_credito_id) {
      const c = await pucRp.findOne({ where: { id: cuenta_credito_id, company_id: cid } });
      if (!c) { res.status(404).json({ error: 'Cuenta crédito no encontrada' }); return; }
      cfg.cuenta_credito_id = cuenta_credito_id;
    } else {
      cfg.cuenta_credito_id = undefined;
    }

    if (descripcion !== undefined) cfg.descripcion = descripcion;

    await repo.save(cfg);
    const saved = await repo.findOne({ where: { id: cfg.id }, relations: ['cuenta_debito', 'cuenta_credito'] });
    res.json(saved);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al guardar configuración contable' });
  }
});

export default router;
