import { Router, Response } from 'express';
import { AppDataSource } from '../config/database';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { MedioPago }    from '../entities/catalogo/MedioPago';
import { UnidadMedida } from '../entities/catalogo/UnidadMedida';
import { Moneda }       from '../entities/catalogo/Moneda';
import { TipoPersona }  from '../entities/catalogo/TipoPersona';
import { TipoTributo }  from '../entities/catalogo/TipoTributo';
import { Municipio }    from '../entities/catalogo/Municipio';
import { Departamento } from '../entities/catalogo/Departamento';
import { CodigoUnspsc } from '../entities/catalogo/CodigoUnspsc';
import { TipoDocumentoIdentidad } from '../entities/catalogo/TipoDocumentoIdentidad';
import { CodigoCie10 } from '../entities/catalogo/CodigoCie10';
import { MODULOS_DEF } from '../seeds/modulos.seed';

const router = Router();
router.use(authMiddleware);

// GET /api/catalogos/modulos-arbol
// Mapa modulo padre -> codigos de sus submodulos, derivado en vivo de
// MODULOS_DEF (backend/src/seeds/modulos.seed.ts) — la MISMA fuente de
// verdad que ya usa el seed y la pantalla de Gestion de Usuarios.
//
// Por que existe: varias pantallas del frontend necesitan saber "¿este
// usuario tiene acceso al modulo padre X?", lo cual debe ser cierto si
// tiene asignado CUALQUIERA de los submodulos de X (ej. un usuario con
// solo 'salud-facturas-clientes' debe poder entrar a /salud). Antes cada
// pantalla (el guard de rutas, el Hub principal, etc.) tenia su PROPIA
// copia de esta lista escrita a mano, y se iban desactualizando cada vez
// que se agregaba un submodulo nuevo — de ahi salieron varios bugs donde
// un usuario con permiso real igual se quedaba sin acceso al padre.
// Este endpoint es la unica fuente para ese calculo: no requiere rol de
// admin (cualquier usuario logueado lo puede consultar), porque saber
// que existe una jerarquia de modulos no es informacion sensible.
router.get('/modulos-arbol', (_req: AuthRequest, res: Response): void => {
  const arbol: Record<string, string[]> = {};
  for (const m of MODULOS_DEF) {
    arbol[m.codigo] = (m.submodulos ?? []).map(s => s.codigo);
  }
  res.json(arbol);
});

router.get('/medios-pago', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const items = await AppDataSource.getRepository(MedioPago).find({
      where: { activo: true }, order: { orden: 'ASC' },
    });
    res.json(items);
  } catch { res.status(500).json({ error: 'Error obteniendo medios de pago' }); }
});

// GET /api/catalogos/tipos-documento
// Catálogo de tipos de documento de identidad (CC, NIT, CE, PP, TI, RC, DE,
// PEP, NUIP, TE, PT, SIN...). Antes el formulario de Terceros traía una
// lista fija escrita a mano en el frontend (con solo 5 opciones, y con
// 'PAS' para pasaporte en vez del código real 'PP' que usa esta tabla) —
// esta ruta la reemplaza para que el formulario siempre muestre el mismo
// catálogo que ya usa el resto de la app.
router.get('/tipos-documento', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const items = await AppDataSource.getRepository(TipoDocumentoIdentidad).find({
      where: { activo: true }, order: { orden: 'ASC' },
    });
    res.json(items);
  } catch { res.status(500).json({ error: 'Error obteniendo tipos de documento' }); }
});

router.get('/unidades-medida', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const items = await AppDataSource.getRepository(UnidadMedida).find({
      where: { activo: true }, order: { orden: 'ASC' } as any,
    });
    res.json(items);
  } catch { res.status(500).json({ error: 'Error obteniendo unidades de medida' }); }
});

router.get('/monedas', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const items = await AppDataSource.getRepository(Moneda).find({ where: { activo: true } });
    res.json(items);
  } catch { res.status(500).json({ error: 'Error obteniendo monedas' }); }
});

router.get('/tipos-persona', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const items = await AppDataSource.getRepository(TipoPersona).find({ where: { activo: true } });
    res.json(items);
  } catch { res.status(500).json({ error: 'Error obteniendo tipos de persona' }); }
});

router.get('/tipos-tributo', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const items = await AppDataSource.getRepository(TipoTributo).find({
      where: { activo: true }, order: { orden: 'ASC' } as any,
    });
    res.json(items);
  } catch { res.status(500).json({ error: 'Error obteniendo tipos de tributo' }); }
});


// GET /api/catalogos/departamentos
router.get('/departamentos', async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const items = await AppDataSource.getRepository(Departamento).find({
      where: { activo: true }, order: { nombre: 'ASC' },
    });
    res.json(items);
  } catch { res.status(500).json({ error: 'Error obteniendo departamentos' }); }
});

// GET /api/catalogos/municipios?q=bogota&dep=11
router.get('/municipios', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const q   = ((req.query['q']   as string) || '').trim();
    const dep = ((req.query['dep'] as string) || '').trim();

    const repo = AppDataSource.getRepository(Municipio);
    const qb = repo.createQueryBuilder('m')
      .leftJoinAndSelect('m.departamento', 'd')
      .where('m.activo = :a', { a: true });

    if (dep) {
      qb.andWhere('d.codigo_dane = :dep', { dep });
    }
    if (q) {
      // Busca por nombre o codigo_dane
      qb.andWhere('(LOWER(m.nombre) LIKE :q OR m.codigo_dane LIKE :qe)', {
        q: `%${q.toLowerCase()}%`,
        qe: `${q}%`,
      });
    }

    const items = await qb.orderBy('m.nombre', 'ASC').limit(30).getMany();

    res.json(items.map(m => ({
      id:                   m.id,
      codigo_dane:          m.codigo_dane,
      nombre:               m.nombre,
      departamento_codigo:  m.departamento?.codigo_dane ?? '',
      departamento_nombre:  m.departamento?.nombre ?? '',
    })));
  } catch { res.status(500).json({ error: 'Error obteniendo municipios' }); }
});

// GET /api/catalogos/unspsc?q=aseo&limit=8
// Búsqueda de códigos UNSPSC por nombre de producto o por código — mismo
// patrón que /municipios (buscar-y-seleccionar), pero aquí SIEMPRE se
// requiere un texto de búsqueda de al menos 2 caracteres: son ~49.000
// códigos, y devolver los "primeros N" sin filtro no tendría sentido para
// el usuario ni sería útil como sugerencia.
router.get('/unspsc', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const q     = ((req.query['q'] as string) || '').trim();
    const limit = Math.min(30, Math.max(1, parseInt((req.query['limit'] as string) || '10', 10) || 10));

    if (q.length < 2) { res.json([]); return; }

    const repo = AppDataSource.getRepository(CodigoUnspsc);
    const qb = repo.createQueryBuilder('u')
      .where('u.activo = :a', { a: true })
      .andWhere('(LOWER(u.nombre) LIKE :q OR u.codigo LIKE :qe)', {
        q:  `%${q.toLowerCase()}%`,
        qe: `${q}%`,
      });

    const items = await qb.orderBy('u.nombre', 'ASC').limit(limit).getMany();

    res.json(items.map(u => ({
      id:               u.id,
      codigo:           u.codigo,
      nombre:           u.nombre,
      segmento_nombre:  u.segmento_nombre,
      familia_nombre:   u.familia_nombre,
      clase_nombre:     u.clase_nombre,
    })));
  } catch { res.status(500).json({ error: 'Error obteniendo códigos UNSPSC' }); }
});

// GET /api/catalogos/cie10?q=diabetes&limit=8
// Búsqueda de códigos CIE-10 (diagnósticos) por nombre, categoría o código —
// mismo patrón que /municipios y /unspsc (buscar-y-seleccionar), y también
// requiere un texto de búsqueda de al menos 2 caracteres: son ~12.600
// códigos, no tendría sentido devolver los "primeros N" sin filtro.
router.get('/cie10', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const q     = ((req.query['q'] as string) || '').trim();
    const limit = Math.min(30, Math.max(1, parseInt((req.query['limit'] as string) || '10', 10) || 10));

    if (q.length < 2) { res.json([]); return; }

    const repo = AppDataSource.getRepository(CodigoCie10);
    const qb = repo.createQueryBuilder('c')
      .where('c.activo = :a', { a: true })
      .andWhere('(LOWER(c.nombre) LIKE :q OR LOWER(c.descripcion) LIKE :q OR c.codigo LIKE :qe)', {
        q:  `%${q.toLowerCase()}%`,
        qe: `${q.toUpperCase()}%`,
      });

    const items = await qb.orderBy('c.codigo', 'ASC').limit(limit).getMany();

    res.json(items.map(c => ({
      id:          c.id,
      codigo:      c.codigo,
      nombre:      c.nombre,
      descripcion: c.descripcion,
    })));
  } catch { res.status(500).json({ error: 'Error obteniendo códigos CIE-10' }); }
});


export default router;
