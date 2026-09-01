import { Router, Response } from 'express';
import { AppDataSource } from '../config/database';
import { Tercero, normalizarNit } from '../entities/Tercero';
import { TipoDocumentoIdentidad } from '../entities/catalogo/TipoDocumentoIdentidad';
import { CentroCosto } from '../entities/contabilidad/CentroCosto';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { Like } from 'typeorm';
import * as XLSX from 'xlsx';
import { registrarAuditoria, AUDITORIA_ACCION, AUDITORIA_ENTIDAD } from '../services/auditoria.service';

const router = Router();
router.use(authMiddleware);

const repo = () => AppDataSource.getRepository(Tercero);

// ── GET /api/terceros?page=1&limit=20&q=&rol=cliente|proveedor ────────────────
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { page = '1', limit = '20', q = '', rol } = req.query as Record<string, string>;
    const cid = req.user!.companyId;

    const qb = repo()
      .createQueryBuilder('t')
      .leftJoinAndSelect('t.centro_costo', 'centro_costo')
      .where('t.company_id = :cid', { cid })
      .orderBy('t.nombre', 'ASC')
      .skip((+page - 1) * +limit)
      .take(+limit);

    if (q) {
      qb.andWhere('(t.nombre LIKE :q OR t.nit LIKE :q OR t.nombre_comercial LIKE :q)', { q: `%${q}%` });
    }
    if (rol === 'cliente')    qb.andWhere('t.es_cliente = 1');
    if (rol === 'proveedor')  qb.andWhere('t.es_proveedor = 1');

    const [items, total] = await qb.getManyAndCount();
    res.json({ items, total, page: +page, limit: +limit });
  } catch (e) {
    res.status(500).json({ error: 'Error listando terceros' });
  }
});

// ── GET /api/terceros/export ──────────────────────────────────────────────────
// Mismas columnas y mismo orden que la plantilla (GET /plantilla) desde la
// Entrega 44 — antes el export traía un juego de columnas más viejo y corto
// (sin dígito de verificación, sin nombre desglosado, sin país), así que
// exportar, editar en Excel y volver a importar perdía esos datos en
// silencio para cualquier tercero que sí los tuviera. Ahora exportar +
// importar son un viaje de ida y vuelta real.
router.get('/export', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const items = await repo().find({
      where: { company_id: cid },
      order: { nombre: 'ASC' },
      relations: ['centro_costo'],
    });

    const rows = items.map(t => ({
      NIT:                            t.nit,
      'Díg. Verif. (solo NIT)':       t.nit_dv || '',
      'Tipo ID':                      t.tipo_id,
      Nombre:                         t.nombre,
      'Nombre comercial':             t.nombre_comercial || '',
      'Primer Nombre':                t.primer_nombre || '',
      'Segundo Nombre':               t.segundo_nombre || '',
      'Primer Apellido':              t.primer_apellido || '',
      'Segundo Apellido':             t.segundo_apellido || '',
      Email:                          t.email || '',
      Teléfono:                       t.telefono || '',
      Dirección:                      t.direccion || '',
      'Código ciudad':                t.ciudad_codigo || '',
      'Ciudad':                       t.ciudad_nombre || '',
      'Cód. departamento':            t.departamento_codigo || '',
      'Departamento':                 t.departamento_nombre || '',
      'País (código)':                t.pais_codigo || '',
      'País':                         t.pais_nombre || '',
      'Nivel tributario':             t.nivel_tributario,
      'Es cliente':                   t.es_cliente  ? 'SI' : 'NO',
      'Es proveedor':                 t.es_proveedor ? 'SI' : 'NO',
      Activo:                         t.activo ? 'SI' : 'NO',
      'Centro de costo':              t.centro_costo?.codigo || '',
      'Centro de costo (nombre)':     t.centro_costo?.nombre || '',
      Notas:                          t.notas || '',
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [
      {wch:14},{wch:18},{wch:8},{wch:30},{wch:22},
      {wch:14},{wch:14},{wch:14},{wch:14},
      {wch:28},{wch:14},{wch:30},
      {wch:12},{wch:16},{wch:14},{wch:16},
      {wch:12},{wch:14},
      {wch:16},{wch:10},{wch:12},
      {wch:16},{wch:30},
      {wch:30},
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Terceros');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="terceros.xlsx"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: 'Error exportando terceros' });
  }
});

// ── GET /api/terceros/plantilla ───────────────────────────────────────────────
// Plantilla actualizada (Entrega 43) con los campos que se necesitaron para
// cargar la base real de terceros de SIESA de Neurum AP: dígito de
// verificación del NIT, nombre desglosado en partes para persona natural
// (lo pide el XML de la DIAN — cac:Person), y país. También agrega una
// segunda hoja con los tipos de documento válidos (el mismo catálogo que ya
// usa el resto de la app) para que quien llena la plantilla sepa qué
// escribir en "Tipo ID" sin adivinar.
router.get('/plantilla', async (req: AuthRequest, res: Response): Promise<void> => {
  const sample = [
    {
      NIT: '900123456', 'Díg. Verif. (solo NIT)': '7', 'Tipo ID': 'NIT',
      Nombre: 'Empresa Ejemplo S.A.S.', 'Nombre comercial': 'Ejemplo',
      'Primer Nombre': '', 'Segundo Nombre': '', 'Primer Apellido': '', 'Segundo Apellido': '',
      Email: 'contacto@empresa.com', Teléfono: '6011234567', Dirección: 'Calle 1 # 2-3',
      'Código ciudad': '11001', Ciudad: 'Bogotá',
      'Cód. departamento': '11', Departamento: 'Bogotá D.C.',
      'País (código)': 'CO', 'País': 'Colombia',
      'Nivel tributario': 'R-99-PN', 'Es cliente': 'SI',
      'Es proveedor': 'NO', Activo: 'SI', 'Centro de costo': '', Notas: '',
    },
    {
      NIT: '1000000000', 'Díg. Verif. (solo NIT)': '', 'Tipo ID': 'CC',
      Nombre: 'Pérez Gómez Juan Carlos', 'Nombre comercial': '',
      'Primer Nombre': 'Juan', 'Segundo Nombre': 'Carlos', 'Primer Apellido': 'Pérez', 'Segundo Apellido': 'Gómez',
      Email: '', Teléfono: '3001234567', Dirección: 'Cra 45 # 10-20',
      'Código ciudad': '05001', Ciudad: 'Medellín',
      'Cód. departamento': '05', Departamento: 'Antioquia',
      'País (código)': 'CO', 'País': 'Colombia',
      'Nivel tributario': 'R-99-PN', 'Es cliente': 'SI',
      'Es proveedor': 'NO', Activo: 'SI', 'Centro de costo': '', Notas: '',
    },
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(sample);
  ws['!cols'] = [
    {wch:14},{wch:18},{wch:8},{wch:30},{wch:22},
    {wch:14},{wch:14},{wch:14},{wch:14},
    {wch:28},{wch:14},{wch:30},
    {wch:12},{wch:16},{wch:14},{wch:16},
    {wch:12},{wch:14},
    {wch:16},{wch:10},{wch:12},
    {wch:16},{wch:30},
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Plantilla');

  try {
    const tipos = await AppDataSource.getRepository(TipoDocumentoIdentidad).find({
      where: { activo: true }, order: { orden: 'ASC' },
    });
    const wsTipos = XLSX.utils.json_to_sheet(
      tipos.map(t => ({ 'Tipo ID (escribir así)': t.codigo, Nombre: t.nombre }))
    );
    wsTipos['!cols'] = [{ wch: 22 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, wsTipos, 'Tipos de documento válidos');
  } catch {
    // Si por algún motivo el catálogo no responde, la plantilla igual se descarga
    // sin la hoja de referencia — no debe bloquear la descarga.
  }

  try {
    const centrosCosto = await AppDataSource.getRepository(CentroCosto).find({
      where: { company_id: req.user!.companyId, activo: true },
      order: { codigo: 'ASC' },
    });
    const wsCentros = XLSX.utils.json_to_sheet(
      centrosCosto.map(c => ({ 'Centro de costo (escribir así)': c.codigo, Nombre: c.nombre }))
    );
    wsCentros['!cols'] = [{ wch: 22 }, { wch: 55 }];
    XLSX.utils.book_append_sheet(wb, wsCentros, 'Centros de costo válidos');
  } catch {
    // Igual que arriba: si el catálogo no responde, la plantilla se descarga
    // sin esta hoja de referencia, no debe bloquear la descarga.
  }

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla_terceros.xlsx"');
  res.send(buf);
});

// ── GET /api/terceros/:id ─────────────────────────────────────────────────────
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const t = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId }, relations: ['centro_costo'] });
    if (!t) { res.status(404).json({ error: 'Tercero no encontrado' }); return; }
    res.json(t);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo tercero' });
  }
});

// ── POST /api/terceros ────────────────────────────────────────────────────────
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { nit, nombre, nombre_comercial, tipo_id, email, telefono, direccion,
            ciudad_codigo, ciudad_nombre, departamento_codigo, departamento_nombre,
            nivel_tributario, es_cliente, es_proveedor, activo, notas,
            tiene_retencion, tarifa_retencion, concepto_retencion } = req.body;

    if (!nit || !nombre) { res.status(400).json({ error: 'NIT y nombre son obligatorios' }); return; }

    // La normalización de nit/email/nombre ya la hace el hook @BeforeInsert de la
    // entidad Tercero (normalizarDatos()) — ver hallazgo #15 — así que aquí ya no hace
    // falta duplicarla: cualquier valor crudo que llegue se limpia automáticamente al
    // guardar, sin importar la ruta (creación, edición, importación masiva).
    const t = repo().create({
      company_id: cid, nit, nombre, nombre_comercial, tipo_id: tipo_id || 'NIT',
      email, telefono, direccion, ciudad_codigo, ciudad_nombre,
      departamento_codigo, departamento_nombre,
      nivel_tributario: nivel_tributario || 'R-99-PN',
      es_cliente:  es_cliente  !== false,
      es_proveedor: !!es_proveedor,
      activo: activo !== false,
      notas,
      tiene_retencion: !!tiene_retencion,
      tarifa_retencion: Number(tarifa_retencion ?? 0),
      concepto_retencion: concepto_retencion || undefined,
      primer_nombre:    req.body.primer_nombre    || undefined,
      segundo_nombre:   req.body.segundo_nombre   || undefined,
      primer_apellido:  req.body.primer_apellido  || undefined,
      segundo_apellido: req.body.segundo_apellido || undefined,
      created_by_user_id: req.user!.id,
      created_by_name:    req.user!.name,
    });
    await repo().save(t);
    await registrarAuditoria({ req, accion: AUDITORIA_ACCION.CREAR, entidad: AUDITORIA_ENTIDAD.TERCERO, entidadId: t.id, datosNuevos: { nit: t.nit, nombre: t.nombre } });
    res.status(201).json(t);
  } catch (e) {
    res.status(500).json({ error: 'Error creando tercero' });
  }
});

// ── PUT /api/terceros/:id ─────────────────────────────────────────────────────
router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const t = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!t) { res.status(404).json({ error: 'Tercero no encontrado' }); return; }
    const allowed = ['nit','nombre','nombre_comercial','tipo_id','email','telefono','direccion',
                     'ciudad_codigo','ciudad_nombre','departamento_codigo','departamento_nombre',
                     'nivel_tributario','es_cliente','es_proveedor','activo','notas',
                     'tiene_retencion','tarifa_retencion','concepto_retencion',
                     'primer_nombre','segundo_nombre','primer_apellido','segundo_apellido'];
    allowed.forEach(k => { if (req.body[k] !== undefined) (t as never as Record<string,unknown>)[k] = req.body[k]; });
    // La normalización de nit/email/nombre ya la hace el hook @BeforeUpdate de la
    // entidad Tercero (normalizarDatos()) al guardar — ver hallazgo #15.
    await repo().save(t);
    res.json(t);
  } catch (e) {
    res.status(500).json({ error: 'Error actualizando tercero' });
  }
});

// ── DELETE /api/terceros/:id ──────────────────────────────────────────────────
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const t = await repo().findOne({ where: { id: req.params.id, company_id: req.user!.companyId } });
    if (!t) { res.status(404).json({ error: 'Tercero no encontrado' }); return; }
    await repo().remove(t);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando tercero' });
  }
});

// ── POST /api/terceros/import ─────────────────────────────────────────────────
// Actualizado en la Entrega 43 junto con la plantilla: ahora sí lee todos los
// campos que la plantilla anuncia (antes "Es cliente" / "Es proveedor" /
// "Activo" / "Notas" aparecían en la plantilla de ejemplo pero la importación
// los ignoraba en silencio), además de los campos nuevos (dígito de
// verificación, nombre desglosado para persona natural, país). El "Tipo ID"
// se valida contra el catálogo real (cat_tipos_documento) en vez de aceptar
// cualquier texto — si no coincide con ningún código conocido, la fila se
// omite y se informa en el detalle en vez de guardarse con un tipo inválido.
router.post('/import', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const cid = req.user!.companyId;
    const { base64 } = req.body;
    if (!base64) { res.status(400).json({ error: 'Se requiere base64 del archivo' }); return; }

    const buf  = Buffer.from(base64, 'base64');
    const wb   = XLSX.read(buf, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: '' });

    const tiposValidos = new Set(
      (await AppDataSource.getRepository(TipoDocumentoIdentidad).find({ where: { activo: true } }))
        .map(t => t.codigo)
    );

    // Mapa código -> id del catálogo de centros de costo de ESTA empresa (el
    // código no es único en todo el sistema, solo dentro de cada empresa —
    // ver @Index(['company_id','codigo']) en CentroCosto.ts).
    const centrosCostoPorCodigo = new Map(
      (await AppDataSource.getRepository(CentroCosto).find({ where: { company_id: cid, activo: true } }))
        .map(c => [c.codigo, c.id])
    );

    const bool = (v: unknown, def: boolean): boolean => {
      const s = String(v ?? '').trim().toUpperCase();
      if (!s) return def;
      return s === 'SI' || s === 'SÍ' || s === 'TRUE' || s === '1' || s === 'X';
    };
    const str = (v: unknown): string | undefined => {
      const s = String(v ?? '').trim();
      return s || undefined;
    };

    let created = 0, skipped = 0;
    const errors: string[] = [];

    for (const row of rows) {
      const nombre  = String(row['Nombre'] || '').trim();
      const nitCrudo = String(row['NIT'] || '').trim();
      if (!nitCrudo || !nombre) { skipped++; continue; }

      const tipoIdCrudo = String(row['Tipo ID'] || 'NIT').trim().toUpperCase();
      if (!tiposValidos.has(tipoIdCrudo)) {
        skipped++;
        errors.push(`Fila "${nombre}" (NIT ${nitCrudo}): tipo de documento "${tipoIdCrudo}" no es válido, se omitió. Revisa la hoja "Tipos de documento válidos" de la plantilla.`);
        continue;
      }

      const nit = normalizarNit(nitCrudo, tipoIdCrudo);

      // "Centro de costo" es opcional. Si viene vacío no se asigna nada
      // (igual que hoy para la mayoría de terceros). Si viene con algo que
      // no existe en el catálogo de esta empresa, se avisa y se omite la
      // fila en vez de guardarla con un centro de costo inventado o
      // apuntando a uno que ya no existe.
      const centroCostoCrudo = String(row['Centro de costo'] || '').trim();
      let centroCostoId: string | undefined;
      if (centroCostoCrudo) {
        const match = centrosCostoPorCodigo.get(centroCostoCrudo);
        if (!match) {
          skipped++;
          errors.push(`Fila "${nombre}" (NIT ${nitCrudo}): centro de costo "${centroCostoCrudo}" no existe, se omitió. Revisa la hoja "Centros de costo válidos" de la plantilla.`);
          continue;
        }
        centroCostoId = match;
      }

      try {
        const existing = await repo().findOne({ where: { nit, company_id: cid } });
        if (existing) { skipped++; continue; }

        const t = repo().create({
          company_id:          cid,
          nit,
          nit_dv:              str(row['Díg. Verif. (solo NIT)'] || row['Digito Verificacion'] || row['DV']),
          nombre,
          nombre_comercial:    str(row['Nombre comercial']),
          tipo_id:             tipoIdCrudo,
          primer_nombre:       str(row['Primer Nombre']),
          segundo_nombre:      str(row['Segundo Nombre']),
          primer_apellido:     str(row['Primer Apellido']),
          segundo_apellido:    str(row['Segundo Apellido']),
          email:               String(row['Email'] || '').trim().toLowerCase() || undefined,
          telefono:            str(row['Teléfono'] || row['Telefono']),
          ciudad_codigo:       str(row['Código ciudad'] || row['Codigo ciudad']),
          ciudad_nombre:       str(row['Ciudad']),
          departamento_codigo: str(row['Cód. departamento'] || row['Cod. departamento'] || row['Codigo departamento']),
          departamento_nombre: str(row['Departamento']),
          pais_codigo:         str(row['País (código)'] || row['Pais (codigo)']) || 'CO',
          pais_nombre:         str(row['País'] || row['Pais']) || 'Colombia',
          direccion:           str(row['Dirección'] || row['Direccion']),
          nivel_tributario:    String(row['Nivel tributario'] || 'R-99-PN').trim(),
          es_cliente:          bool(row['Es cliente'], true),
          es_proveedor:        bool(row['Es proveedor'], false),
          activo:              bool(row['Activo'], true),
          centro_costo_id:     centroCostoId,
          notas:               str(row['Notas']),
        });
        await repo().save(t);
        created++;
      } catch (rowErr) {
        errors.push(`Fila NIT ${nitCrudo}: ${(rowErr as Error).message}`);
      }
    }

    res.json({ created, skipped, errors: errors.slice(0, 20) });
  } catch (e: unknown) {
    res.status(500).json({ error: 'Error importando terceros', detail: (e as Error).message });
  }
});

export default router;
