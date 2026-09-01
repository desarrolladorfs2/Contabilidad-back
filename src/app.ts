import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import * as path from 'path';
import { initDatabase } from './config/database';
import { authMiddleware, requireJwtSecret } from './middleware/auth.middleware';

// Falla rápido y explícito si falta configuración de seguridad crítica,
// en vez de arrancar y depender de un fallback hardcodeado en el código.
requireJwtSecret();
if (!process.env.CERT_ENCRYPTION_KEY) {
  throw new Error('CERT_ENCRYPTION_KEY no está configurado. Defínelo en el archivo .env antes de arrancar el servidor.');
}

import authRoutes        from './routes/auth.routes';
import companiesRoutes   from './routes/companies.routes';
import settingsRoutes    from './routes/settings.routes';
import invoicesRoutes    from './routes/invoices.routes';
import creditNotesRoutes from './routes/credit-notes.routes';
import debitNotesRoutes  from './routes/debit-notes.routes';
import receivedRoutes    from './routes/received.routes';
import tercerosRoutes   from './routes/terceros.routes';
import dashboardRoutes  from './routes/dashboard.routes';
import ventasRoutes     from './routes/ventas.routes';
import saludEpsRoutes         from './routes/salud/eps.routes';
import saludContratosRoutes   from './routes/salud/contratos-salud.routes';
import saludServiciosRoutes   from './routes/salud/servicios-salud.routes';
import saludFacturasRoutes    from './routes/salud/facturas-salud.routes';
import saludNCRoutes          from './routes/salud/notas-credito-salud.routes';
import saludNDRoutes          from './routes/salud/notas-debito-salud.routes';
import saludCargueRoutes      from './routes/salud/cargue-registros.routes';
import contabPucRoutes          from './routes/contabilidad/puc.routes';
import contabAsientosRoutes     from './routes/contabilidad/asientos.routes';
import contabReportesRoutes     from './routes/contabilidad/reportes-contab.routes';
import contabCentrosCostoRoutes from './routes/contabilidad/centros-costo.routes';
import contabCierresRoutes      from './routes/contabilidad/cierres.routes';
import contabSedesRoutes        from './routes/contabilidad/sedes.routes';
import contabPresupuestosRoutes from './routes/contabilidad/presupuestos-cc.routes';
import contabExogenaRoutes      from './routes/contabilidad/exogena.routes';
import contabFlujoRoutes        from './routes/contabilidad/flujo-efectivo.routes';
import contabConfigRoutes       from './routes/contabilidad/config-contable.routes';
import tesoreriaCuentasRoutes        from './routes/tesoreria/cuentas.routes';
import tesorerriaMovimientosRoutes   from './routes/tesoreria/movimientos.routes';
import tesoreriaConciliacionesRoutes from './routes/tesoreria/conciliaciones.routes';
import impuestosRoutes from './routes/impuestos/impuestos.routes';
import impuestosConfigRoutes from './routes/impuestos/impuestos-config.routes';
import reportesRoutes from './routes/reportes/reportes.routes';
import llmProxyRoutes  from './routes/llm-proxy.routes';
import adminUsuariosRoutes from './routes/admin-usuarios.routes';
import catalogosRoutes    from './routes/catalogos.routes';
import productosRoutes    from './routes/productos.routes';
import listasPrecioRoutes from './routes/listas-precio.routes';
import cotizacionesRoutes       from './routes/cotizaciones.routes';
import facturasCompraRoutes     from './routes/facturas-compra.routes';
import documentosSoporteRoutes  from './routes/compras/documentos-soporte.routes';
import notasAjusteDsRoutes      from './routes/compras/notas-ajuste-ds.routes';
import comprasCarteraRoutes     from './routes/compras/compras-cartera.routes';
import documentosRecibidosRoutes from './routes/compras/documentos-recibidos.routes';
import novedadesRoutes           from './routes/novedades.routes';

const app = express();

app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:4200',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// Los archivos de /uploads (certificados .pfx, logos, adjuntos) requieren sesión válida.
// authMiddleware acepta el token tanto en el header Authorization como en ?token=
// (usado por <img src> y descargas directas <a href> que no pueden enviar headers).
app.use('/uploads', authMiddleware, express.static(path.resolve(process.env.UPLOADS_DIR || './uploads')));

app.use('/api/auth',         authRoutes);
app.use('/api/companies',    companiesRoutes);
app.use('/api/settings',     settingsRoutes);
app.use('/api/facturas',      invoicesRoutes);
app.use('/api/notas-credito', creditNotesRoutes);
app.use('/api/notas-debito',  debitNotesRoutes);
app.use('/api/received',     receivedRoutes);
app.use('/api/terceros',     tercerosRoutes);
app.use('/api/dashboard',   dashboardRoutes);
app.use('/api/ventas',      ventasRoutes);
app.use('/api/salud/eps',           saludEpsRoutes);
app.use('/api/salud/contratos',     saludContratosRoutes);
app.use('/api/salud/servicios',     saludServiciosRoutes);
app.use('/api/salud/facturas',      saludFacturasRoutes);
app.use('/api/salud/notas-credito', saludNCRoutes);
app.use('/api/salud/notas-debito',  saludNDRoutes);
app.use('/api/salud/cargue',        saludCargueRoutes);
app.use('/api/contabilidad/puc',           contabPucRoutes);
app.use('/api/contabilidad/asientos',      contabAsientosRoutes);
app.use('/api/contabilidad/reportes',      contabReportesRoutes);
app.use('/api/contabilidad/centros-costo', contabCentrosCostoRoutes);
app.use('/api/contabilidad/cierres',       contabCierresRoutes);
app.use('/api/contabilidad/sedes',         contabSedesRoutes);
app.use('/api/contabilidad/presupuestos-cc', contabPresupuestosRoutes);
app.use('/api/contabilidad/exogena',        contabExogenaRoutes);
app.use('/api/contabilidad/flujo-efectivo', contabFlujoRoutes);
app.use('/api/contabilidad/config',         contabConfigRoutes);
app.use('/api/tesoreria/cuentas',        tesoreriaCuentasRoutes);
app.use('/api/tesoreria/movimientos',    tesorerriaMovimientosRoutes);
app.use('/api/tesoreria/conciliaciones', tesoreriaConciliacionesRoutes);
app.use('/api/impuestos', impuestosRoutes);
app.use('/api/impuestos/config', impuestosConfigRoutes);
app.use('/api/reportes',  reportesRoutes);
app.use('/api/llm-proxy',  llmProxyRoutes);
app.use('/api/admin',      adminUsuariosRoutes);
app.use('/api/catalogos',    catalogosRoutes);
app.use('/api/productos',    productosRoutes);
app.use('/api/listas-precio', listasPrecioRoutes);
app.use('/api/cotizaciones',    cotizacionesRoutes);
app.use('/api/facturas-compra', facturasCompraRoutes);
app.use('/api/compras/documentos-soporte', documentosSoporteRoutes);
app.use('/api/compras/notas-ajuste-ds',    notasAjusteDsRoutes);
app.use('/api/compras/documentos-recibidos', documentosRecibidosRoutes);
app.use('/api/compras', comprasCarteraRoutes);
app.use('/api/novedades', novedadesRoutes);

app.get('/health', (_req: express.Request, res: express.Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((_req: express.Request, res: express.Response) => {
  res.status(404).json({ message: 'Ruta no encontrada' });
});


app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: err.message || 'Error interno del servidor' });
});

export { app };

initDatabase().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`[SERVER] Escuchando en http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('[DB] Error inicializando base de datos:', err);
  process.exit(1);
});
