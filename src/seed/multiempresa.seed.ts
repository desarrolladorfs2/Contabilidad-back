/**
 * Seed de multi-empresa para pruebas.
 *
 * Crea 3 empresas nuevas:
 *   - Neurum AP   → copia toda la configuración y datos maestros de Neurum IPS
 *   - Mefesalud AP → NIT 900891534, config genérica
 *   - Mefesalud IPS → NIT 900891534, config genérica
 *
 * Uso (con el backend DETENIDO):
 *   cd SP_Dian_V2/backend
 *   npx ts-node src/seed/multiempresa.seed.ts
 *
 * Re-ejecutable: detecta si las empresas ya existen por nombre y las omite.
 */

import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as bcrypt from 'bcryptjs';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

import { AppDataSource, forceSqljsSave } from '../config/database';
import { Company } from '../entities/Company';
import { CompanySettings } from '../entities/CompanySettings';
import { CompanyResponsabilidad } from '../entities/CompanyResponsabilidad';
import { User } from '../entities/User';
import { Modulo } from '../entities/Modulo';
import { EmpresaModulo } from '../entities/EmpresaModulo';
import { UsuarioModulo } from '../entities/UsuarioModulo';
import { Producto } from '../entities/Producto';
import { ListaPrecio } from '../entities/ListaPrecio';
import { ProductoPrecio } from '../entities/ProductoPrecio';
import { Tercero } from '../entities/Tercero';
import { TerceroContacto } from '../entities/TerceroContacto';
import { TerceroResponsabilidad } from '../entities/TerceroResponsabilidad';
import { Eps } from '../entities/salud/Eps';
import { ContratoSalud } from '../entities/salud/ContratoSalud';
import { ContratoServicio } from '../entities/salud/ContratoServicio';
import { ServicioSalud } from '../entities/salud/ServicioSalud';
import { CuentaPUC } from '../entities/contabilidad/CuentaPUC';
import { ConfiguracionContable } from '../entities/contabilidad/ConfiguracionContable';
import { CentroCosto } from '../entities/contabilidad/CentroCosto';
import { Sede } from '../entities/contabilidad/Sede';
import { CuentaTesoreria } from '../entities/tesoreria/CuentaTesoreria';
import { CategoriaMovimientoTesoreria } from '../entities/tesoreria/CategoriaMovimientoTesoreria';
import { TarifaRetencion } from '../entities/impuestos/TarifaRetencion';

// ─── Módulos excluidos para usuarios operadores ─────────────────────────────
const MODULOS_EXCLUIDOS_OPERATOR = new Set([
  'configuracion',
  'conf-empresa',
  'conf-usuarios',
]);

// ─── Helper: crear empresa + settings vacíos ─────────────────────────────────
async function crearEmpresa(name: string, nit: string): Promise<Company> {
  const companyRepo = AppDataSource.getRepository(Company);
  const settingsRepo = AppDataSource.getRepository(CompanySettings);

  const company = companyRepo.create({ nit, name, activo: true });
  await companyRepo.save(company);

  const settings = settingsRepo.create({ company_id: company.id });
  await settingsRepo.save(settings);

  console.log(`  ✓ Empresa creada: ${name} (${nit}) → id=${company.id}`);
  return company;
}

// ─── Helper: copiar settings de una empresa a otra ───────────────────────────
// IMPORTANTE: crearEmpresa() ya creó una fila vacía para dstId.
// Aquí la cargamos y actualizamos con los valores del origen.
async function copiarSettings(srcId: string, dstId: string): Promise<void> {
  const repo = AppDataSource.getRepository(CompanySettings);
  const src = await repo.findOne({ where: { company_id: srcId } });
  if (!src) return;

  // Cargar la fila existente de destino (creada vacía en crearEmpresa)
  const dst = await repo.findOne({ where: { company_id: dstId } });
  if (!dst) return;

  // Copiar campos del origen, manteniendo id y company_id del destino
  const merged = Object.assign(dst, {
    ...src,
    id:         dst.id,        // conservar el id de destino
    company_id: dstId,         // conservar company_id de destino
    company:    undefined as unknown as Company,
    // Resetear numeración
    next_invoice_number:           1,
    next_credit_note_number:       1,
    next_debit_note_number:        1,
    next_health_invoice_number:    1,
    next_health_credit_note_number: 1,
    next_health_debit_note_number: 1,
    next_payroll_document_number:  1,
    // No copiar cert ni logo (rutas absolutas de la empresa origen)
    cert_path:               undefined,
    cert_data:               undefined,
    cert_password_encrypted: undefined,
    cert_filename:           undefined,
    cert_expires_at:         undefined,
    logo_path:               undefined,
    logo_pdf_path:           undefined,
    logo_app_path:           undefined,
  });
  await repo.save(merged);
  console.log('  ✓ Settings copiados');
}

// ─── Helper: copiar responsabilidades de empresa ─────────────────────────────
async function copiarResponsabilidades(srcId: string, dstId: string): Promise<void> {
  const repo = AppDataSource.getRepository(CompanyResponsabilidad);
  const rows = await repo.find({ where: { company_id: srcId } });
  if (!rows.length) return;
  await repo.save(rows.map(r => repo.create({
    company_id: dstId,
    responsabilidad_codigo: r.responsabilidad_codigo,
  })));
  console.log(`  ✓ Responsabilidades copiadas (${rows.length})`);
}

// ─── Helper: asignar TODOS los módulos del sistema a una empresa ──────────────
async function asignarModulosEmpresa(companyId: string): Promise<void> {
  const moduloRepo = AppDataSource.getRepository(Modulo);
  const emRepo = AppDataSource.getRepository(EmpresaModulo);

  const modulos = await moduloRepo.find();
  const existing = await emRepo.find({ where: { company_id: companyId } });
  const existingIds = new Set(existing.map(e => e.modulo_id));

  const nuevos = modulos.filter(m => !existingIds.has(m.id));
  if (nuevos.length) {
    await emRepo.save(nuevos.map(m => emRepo.create({
      company_id: companyId,
      modulo_id:  m.id,
      activo:     true,
    })));
  }
  console.log(`  ✓ Módulos empresa asignados (${modulos.length})`);
}

// ─── Helper: crear usuario y asignar módulos ─────────────────────────────────
async function crearUsuario(
  companyId: string,
  email: string,
  name: string,
  role: 'admin' | 'operator',
  password: string,
  todosModulos: Modulo[],
): Promise<User> {
  const userRepo = AppDataSource.getRepository(User);
  const umRepo   = AppDataSource.getRepository(UsuarioModulo);

  const hash = await bcrypt.hash(password, 12);
  const user = userRepo.create({
    company_id:            companyId,
    email:                 email.toLowerCase(),
    name,
    password_hash:         hash,
    role,
    is_active:             true,
    debe_cambiar_password: false,
  });
  await userRepo.save(user);

  // Asignar módulos según rol
  const modulosUsuario = role === 'admin'
    ? todosModulos
    : todosModulos.filter(m => !MODULOS_EXCLUIDOS_OPERATOR.has(m.codigo));

  if (modulosUsuario.length) {
    await umRepo.save(modulosUsuario.map(m => umRepo.create({
      user_id:   user.id,
      modulo_id: m.id,
      activo:    true,
    })));
  }
  console.log(`  ✓ Usuario ${email} (${role}, ${modulosUsuario.length} módulos)`);
  return user;
}

// ─── Helper: copiar datos maestros de una empresa a otra ─────────────────────
async function copiarDatosMaestros(srcId: string, dstId: string): Promise<void> {

  // ── Productos ──────────────────────────────────────────────────────────────
  const productoRepo = AppDataSource.getRepository(Producto);
  const srcProductos = await productoRepo.find({ where: { company_id: srcId } });
  const productoIdMap = new Map<string, string>(); // oldId → newId

  if (srcProductos.length) {
    for (const p of srcProductos) {
      const oldId = p.id;
      const newP = Object.assign(new Producto(), {
        ...p,
        id:         undefined,
        company_id: dstId,
        company:    undefined,
        precios:    undefined,
        created_at: undefined,
        updated_at: undefined,
      });
      const saved = await productoRepo.save(newP);
      productoIdMap.set(oldId, (saved as any).id);
    }
    console.log(`  ✓ Productos copiados (${srcProductos.length})`);
  }

  // ── Listas de precio ───────────────────────────────────────────────────────
  const listaRepo = AppDataSource.getRepository(ListaPrecio);
  const srcListas = await listaRepo.find({ where: { company_id: srcId } });
  const listaIdMap = new Map<string, string>();

  if (srcListas.length) {
    for (const l of srcListas) {
      const oldId = l.id;
      const newL = Object.assign(new ListaPrecio(), {
        ...l,
        id:         undefined,
        company_id: dstId,
        company:    undefined,
        precios:    undefined,
        created_at: undefined,
        updated_at: undefined,
      });
      const saved = await listaRepo.save(newL);
      listaIdMap.set(oldId, (saved as any).id);
    }
    console.log(`  ✓ Listas de precio copiadas (${srcListas.length})`);
  }

  // ── Precios por producto/lista ─────────────────────────────────────────────
  const precioRepo = AppDataSource.getRepository(ProductoPrecio);
  if (listaIdMap.size && productoIdMap.size) {
    const srcPrecios = await precioRepo
      .createQueryBuilder('pp')
      .innerJoin(ListaPrecio, 'lp', 'pp.lista_precio_id = lp.id')
      .where('lp.company_id = :srcId', { srcId })
      .getMany();

    const nuevosPrecios = srcPrecios
      .filter(pp => listaIdMap.has(pp.lista_precio_id) && productoIdMap.has(pp.producto_id))
      .map(pp => precioRepo.create({
        lista_precio_id: listaIdMap.get(pp.lista_precio_id)!,
        producto_id:     productoIdMap.get(pp.producto_id)!,
        precio:          pp.precio,
        descuento_pct:   pp.descuento_pct,
      }));

    if (nuevosPrecios.length) {
      await precioRepo.save(nuevosPrecios);
      console.log(`  ✓ Precios producto/lista copiados (${nuevosPrecios.length})`);
    }
  }

  // ── Terceros ───────────────────────────────────────────────────────────────
  const terceroRepo = AppDataSource.getRepository(Tercero);
  const contactoRepo = AppDataSource.getRepository(TerceroContacto);
  const respRepo = AppDataSource.getRepository(TerceroResponsabilidad);

  const srcTerceros = await terceroRepo.find({ where: { company_id: srcId } });
  const terceroIdMap = new Map<string, string>();

  if (srcTerceros.length) {
    for (const t of srcTerceros) {
      const oldId = t.id;
      const newT = Object.assign(new Tercero(), {
        ...t,
        id:                undefined,
        company_id:        dstId,
        company:           undefined,
        contactos:         undefined,
        responsabilidades: undefined,
        created_at:        undefined,
        updated_at:        undefined,
      });
      const saved = await terceroRepo.save(newT);
      terceroIdMap.set(oldId, (saved as any).id);
    }
    console.log(`  ✓ Terceros copiados (${srcTerceros.length})`);

    // Contactos (tienen company_id propio)
    const srcContactos = await contactoRepo.find({ where: { company_id: srcId } });
    if (srcContactos.length) {
      const newContactos = srcContactos
        .filter(c => terceroIdMap.has(c.tercero_id))
        .map(c => Object.assign(new TerceroContacto(), {
          ...c,
          id:         undefined,
          company_id: dstId,
          tercero_id: terceroIdMap.get(c.tercero_id)!,
          company:    undefined,
          tercero:    undefined,
          created_at: undefined,
          updated_at: undefined,
        }));
      await contactoRepo.save(newContactos);
      console.log(`  ✓ Contactos terceros copiados (${newContactos.length})`);
    }

    // Responsabilidades fiscales de terceros (sin company_id — FK solo a tercero_id)
    const oldTerceroIds = srcTerceros.map(t => t.id);
    const srcResps = oldTerceroIds.length
      ? await respRepo.createQueryBuilder('r')
          .where('r.tercero_id IN (:...ids)', { ids: oldTerceroIds })
          .getMany()
      : [];
    if (srcResps.length) {
      const newResps = srcResps
        .filter(r => terceroIdMap.has(r.tercero_id))
        .map(r => respRepo.create({
          tercero_id:             terceroIdMap.get(r.tercero_id)!,
          responsabilidad_codigo: r.responsabilidad_codigo,
        }));
      await respRepo.save(newResps);
      console.log(`  ✓ Responsabilidades terceros copiadas (${newResps.length})`);
    }
  }

  // ── Salud: EPS ─────────────────────────────────────────────────────────────
  const epsRepo = AppDataSource.getRepository(Eps);
  const srcEps = await epsRepo.find({ where: { company_id: srcId } });
  const epsIdMap = new Map<string, string>();

  if (srcEps.length) {
    for (const eps of srcEps) {
      const oldId = eps.id;
      const newEps = Object.assign(new Eps(), {
        ...eps,
        id:         undefined,
        company_id: dstId,
        company:    undefined,
        contratos:  undefined,
        created_at: undefined,
        updated_at: undefined,
      });
      const saved = await epsRepo.save(newEps);
      epsIdMap.set(oldId, (saved as any).id);
    }
    console.log(`  ✓ EPS copiadas (${srcEps.length})`);
  }

  // ── Salud: Servicios CUPS ──────────────────────────────────────────────────
  const servicioRepo = AppDataSource.getRepository(ServicioSalud);
  const srcServicios = await servicioRepo.find({ where: { company_id: srcId } });
  const servicioIdMap = new Map<string, string>();

  if (srcServicios.length) {
    for (const s of srcServicios) {
      const oldId = s.id;
      const newS = Object.assign(new ServicioSalud(), {
        ...s,
        id:         undefined,
        company_id: dstId,
        company:    undefined,
        created_at: undefined,
        updated_at: undefined,
      });
      const saved = await servicioRepo.save(newS);
      servicioIdMap.set(oldId, (saved as any).id);
    }
    console.log(`  ✓ Servicios salud copiados (${srcServicios.length})`);
  }

  // ── Salud: Contratos ───────────────────────────────────────────────────────
  const contratoRepo = AppDataSource.getRepository(ContratoSalud);
  const cSerRepo = AppDataSource.getRepository(ContratoServicio);

  const srcContratos = await contratoRepo.find({ where: { company_id: srcId } });
  const contratoIdMap = new Map<string, string>();

  if (srcContratos.length) {
    for (const c of srcContratos) {
      const oldId = c.id;
      const newEpsId = c.eps_id ? epsIdMap.get(c.eps_id) : undefined;
      const newC = Object.assign(new ContratoSalud(), {
        ...c,
        id:         undefined,
        company_id: dstId,
        eps_id:     newEpsId,
        eps:        undefined,
        servicios:  undefined,
        created_at: undefined,
        updated_at: undefined,
      });
      const saved = await contratoRepo.save(newC);
      contratoIdMap.set(oldId, (saved as any).id);
    }
    console.log(`  ✓ Contratos salud copiados (${srcContratos.length})`);

    // Servicios del contrato
    if (contratoIdMap.size && servicioIdMap.size) {
      const oldContratoIds = srcContratos.map(c => c.id);
      const srcCSers = oldContratoIds.length
        ? await cSerRepo.createQueryBuilder('cs')
            .where('cs.contrato_id IN (:...ids)', { ids: oldContratoIds })
            .getMany()
        : [];
      const newCSers = srcCSers
        .filter(cs => contratoIdMap.has(cs.contrato_id) && servicioIdMap.has(cs.servicio_id))
        .map(cs => cSerRepo.create({
          company_id:     dstId,
          contrato_id:    contratoIdMap.get(cs.contrato_id)!,
          servicio_id:    servicioIdMap.get(cs.servicio_id)!,
          valor_acordado: cs.valor_acordado,
          habilitado:     cs.habilitado,
        }));
      if (newCSers.length) {
        await cSerRepo.save(newCSers);
        console.log(`  ✓ ContratoServicios copiados (${newCSers.length})`);
      }
    }
  }

  // ── Contabilidad: PUC ──────────────────────────────────────────────────────
  const pucRepo = AppDataSource.getRepository(CuentaPUC);
  const srcPuc = await pucRepo.find({ where: { company_id: srcId } });
  if (srcPuc.length) {
    // Copiar en orden por codigo (para respetar parent_id FK)
    const pucIdMap = new Map<string, string>();
    const sorted = srcPuc.sort((a, b) => a.codigo.localeCompare(b.codigo));

    for (const cuenta of sorted) {
      const oldId = cuenta.id;
      const newPadreId = cuenta.padre_id ? pucIdMap.get(cuenta.padre_id) : undefined;
      const newC = Object.assign(new CuentaPUC(), {
        ...cuenta,
        id:         undefined,
        company_id: dstId,
        padre_id:   newPadreId,
        company:    undefined,
        padre:      undefined,
        hijos:      undefined,
        lineas:     undefined,
        created_at: undefined,
        updated_at: undefined,
      });
      const saved = await pucRepo.save(newC);
      pucIdMap.set(oldId, (saved as any).id);
    }
    console.log(`  ✓ Cuentas PUC copiadas (${srcPuc.length})`);
  }

  // ── Contabilidad: Configuración contable ──────────────────────────────────
  const confContRepo = AppDataSource.getRepository(ConfiguracionContable);
  const srcConfCont = await confContRepo.find({ where: { company_id: srcId } });
  if (srcConfCont.length) {
    await confContRepo.save(srcConfCont.map(c => Object.assign(new ConfiguracionContable(), {
      ...c, id: undefined, company_id: dstId, company: undefined, created_at: undefined, updated_at: undefined,
    })));
    console.log(`  ✓ Configuración contable copiada`);
  }

  // ── Contabilidad: Centros de costo ────────────────────────────────────────
  const ccRepo = AppDataSource.getRepository(CentroCosto);
  const srcCC = await ccRepo.find({ where: { company_id: srcId } });
  if (srcCC.length) {
    await ccRepo.save(srcCC.map(c => Object.assign(new CentroCosto(), {
      ...c, id: undefined, company_id: dstId, company: undefined, created_at: undefined, updated_at: undefined,
    })));
    console.log(`  ✓ Centros de costo copiados (${srcCC.length})`);
  }

  // ── Contabilidad: Sedes ───────────────────────────────────────────────────
  const sedeRepo = AppDataSource.getRepository(Sede);
  const srcSedes = await sedeRepo.find({ where: { company_id: srcId } });
  if (srcSedes.length) {
    await sedeRepo.save(srcSedes.map(s => Object.assign(new Sede(), {
      ...s, id: undefined, company_id: dstId, company: undefined, created_at: undefined, updated_at: undefined,
    })));
    console.log(`  ✓ Sedes copiadas (${srcSedes.length})`);
  }

  // ── Tesorería: Cuentas ────────────────────────────────────────────────────
  const ctaRepo = AppDataSource.getRepository(CuentaTesoreria);
  const srcCtas = await ctaRepo.find({ where: { company_id: srcId } });
  if (srcCtas.length) {
    await ctaRepo.save(srcCtas.map(c => Object.assign(new CuentaTesoreria(), {
      ...c, id: undefined, company_id: dstId, company: undefined, created_at: undefined, updated_at: undefined,
    })));
    console.log(`  ✓ Cuentas tesorería copiadas (${srcCtas.length})`);
  }

  // ── Tesorería: Categorías (solo las de la empresa, no las globales) ────────
  const catRepo = AppDataSource.getRepository(CategoriaMovimientoTesoreria);
  const srcCats = await catRepo.find({ where: { company_id: srcId } });
  if (srcCats.length) {
    await catRepo.save(srcCats.map(c => Object.assign(new CategoriaMovimientoTesoreria(), {
      ...c, id: undefined, company_id: dstId, company: undefined, created_at: undefined, updated_at: undefined,
    })));
    console.log(`  ✓ Categorías movimiento copiadas (${srcCats.length})`);
  }

  // ── Impuestos: Tarifas de retención (solo las de la empresa) ──────────────
  const tarifaRepo = AppDataSource.getRepository(TarifaRetencion);
  const srcTarifas = await tarifaRepo.find({ where: { company_id: srcId } });
  if (srcTarifas.length) {
    await tarifaRepo.save(srcTarifas.map(t => Object.assign(new TarifaRetencion(), {
      ...t, id: undefined, company_id: dstId, company: undefined, created_at: undefined, updated_at: undefined,
    })));
    console.log(`  ✓ Tarifas retención copiadas (${srcTarifas.length})`);
  }
}

// ─── Helper: quitar constraints UNIQUE obsoletos en SQLite ───────────────────
// SQLite no soporta ALTER TABLE DROP CONSTRAINT. TypeORM synchronize tampoco
// puede eliminar constraints inline. La única forma es recrear la tabla:
// 1. Leer CREATE TABLE de sqlite_master
// 2. Quitar el UNIQUE del SQL
// 3. Crear tabla temporal, copiar datos, drop original, renombrar
async function dropObsoleteUniqueIndexes(): Promise<void> {
  await AppDataSource.query('PRAGMA foreign_keys = OFF');

  // companies.nit — inline UNIQUE en definición de columna o como CONSTRAINT
  await recreateWithoutUnique('companies', [
    // Inline en columna: "nit" varchar(20) NOT NULL UNIQUE  →  "nit" varchar(20) NOT NULL
    [/"nit"(\s+varchar\(\d+\)[^,)]*?)\s+UNIQUE/gi, '"nit"$1'],
    // Tabla-level: , CONSTRAINT "xxx" UNIQUE ("nit")
    [/,\s*CONSTRAINT\s+"[^"]+"\s+UNIQUE\s*\(\s*"nit"\s*\)/gi, ''],
  ]);

  // users.email — solo el UNIQUE de email individual (no el compuesto con company_id)
  await recreateWithoutUnique('users', [
    [/,\s*CONSTRAINT\s+"[^"]+"\s+UNIQUE\s*\(\s*"email"\s*\)(?!\s*,\s*"company)/gi, ''],
    [/"email"(\s+varchar\(\d+\)[^,)]*?)\s+UNIQUE(?!\s*\("company)/gi, '"email"$1'],
  ]);

  await AppDataSource.query('PRAGMA foreign_keys = ON');
}

async function recreateWithoutUnique(table: string, replacements: [RegExp, string][]): Promise<void> {
  const rows = await AppDataSource.query(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`, [table]
  ) as { sql: string }[];
  if (!rows.length) return;

  let sql: string = rows[0].sql;
  const before = sql;

  for (const [pat, rep] of replacements) sql = sql.replace(pat, rep);
  // Limpiar coma colgante antes del cierre de paréntesis
  sql = sql.replace(/,(\s*\))/g, '$1');

  if (sql === before) { console.log(`  ✓ ${table}: sin UNIQUE obsoleto`); return; }

  const tmp = `${table}_mig_tmp_${Date.now()}`;
  sql = sql.replace(new RegExp(`"${table}"`, 'g'), `"${tmp}"`);

  await AppDataSource.query(sql);
  const cols = (await AppDataSource.query(`PRAGMA table_info('${table}')`) as { name: string }[])
    .map(c => `"${c.name}"`).join(', ');
  await AppDataSource.query(`INSERT INTO "${tmp}" (${cols}) SELECT ${cols} FROM "${table}"`);
  await AppDataSource.query(`DROP TABLE "${table}"`);
  await AppDataSource.query(`ALTER TABLE "${tmp}" RENAME TO "${table}"`);
  console.log(`  ✓ Reconstruida tabla ${table}: UNIQUE obsoleto eliminado`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  await AppDataSource.initialize();
  console.log('✓ Base de datos conectada\n');

  // Migración manual de índices obsoletos (SQLite no soporta ALTER TABLE DROP CONSTRAINT)
  await dropObsoleteUniqueIndexes();

  const companyRepo = AppDataSource.getRepository(Company);
  const moduloRepo  = AppDataSource.getRepository(Modulo);

  // Cargar todos los módulos una sola vez
  const todosModulos = await moduloRepo.find();
  console.log(`Módulos disponibles: ${todosModulos.length}\n`);

  // ─── Buscar Neurum IPS ────────────────────────────────────────────────────
  const allCompanies = await companyRepo.find();
  const neurumIps = allCompanies.find(c =>
    c.name.toLowerCase().includes('neurum') && c.name.toLowerCase().includes('ips')
  ) ?? allCompanies[0]; // fallback: primera empresa del sistema

  if (!neurumIps) {
    console.error('✗ No se encontró ninguna empresa. Ejecuta el setup primero.');
    process.exit(1);
  }
  console.log(`Empresa origen: ${neurumIps.name} (${neurumIps.id})\n`);

  // ─── Neurum AP ────────────────────────────────────────────────────────────
  const neurumApExists = allCompanies.find(c => c.name.toLowerCase() === 'neurum ap');
  let neurumAp: Company;

  if (neurumApExists) {
    console.log('⚠  Neurum AP ya existe, omitiendo creación.\n');
    neurumAp = neurumApExists;
  } else {
    console.log('── Creando Neurum AP ──────────────────────────────────────────────');
    neurumAp = await crearEmpresa('Neurum AP', neurumIps.nit);
    await copiarSettings(neurumIps.id, neurumAp.id);
    await copiarResponsabilidades(neurumIps.id, neurumAp.id);
    await asignarModulosEmpresa(neurumAp.id);
    await copiarDatosMaestros(neurumIps.id, neurumAp.id);

    // Usuarios Neurum AP
    const PW_NEURUM = 'Neurum2026';
    await crearUsuario(neurumAp.id, 'Admin@Neurum.com.co',          'Admin Neurum AP',        'admin',    PW_NEURUM, todosModulos);
    await crearUsuario(neurumAp.id, 'Contabilidad1@Neurum.com.co',  'Contabilidad 1',          'operator', PW_NEURUM, todosModulos);
    await crearUsuario(neurumAp.id, 'Contabilidad2@Neurum.com.co',  'Contabilidad 2',          'operator', PW_NEURUM, todosModulos);
    await crearUsuario(neurumAp.id, 'Contabilidad3@Neurum.com.co',  'Contabilidad 3',          'operator', PW_NEURUM, todosModulos);
    await crearUsuario(neurumAp.id, 'Contabilidad4@Neurum.com.co',  'Contabilidad 4',          'operator', PW_NEURUM, todosModulos);
    await crearUsuario(neurumAp.id, 'Facturacion1@Neurum.com.co',   'Facturación 1',           'operator', PW_NEURUM, todosModulos);
    await crearUsuario(neurumAp.id, 'Facturacion2@Neurum.com.co',   'Facturación 2',           'operator', PW_NEURUM, todosModulos);
    await crearUsuario(neurumAp.id, 'Facturacion3@Neurum.com.co',   'Facturación 3',           'operator', PW_NEURUM, todosModulos);
    await crearUsuario(neurumAp.id, 'Facturacion4@Neurum.com.co',   'Facturación 4',           'operator', PW_NEURUM, todosModulos);
    await crearUsuario(neurumAp.id, 'Facturacion5@Neurum.com.co',   'Facturación 5',           'operator', PW_NEURUM, todosModulos);
    console.log('');
  }

  // ─── Mefesalud AP ─────────────────────────────────────────────────────────
  const mefesaludApExists = allCompanies.find(c => c.name.toLowerCase() === 'mefesalud ap');

  if (mefesaludApExists) {
    console.log('⚠  Mefesalud AP ya existe, omitiendo creación.\n');
  } else {
    console.log('── Creando Mefesalud AP ───────────────────────────────────────────');
    const mefesaludAp = await crearEmpresa('Mefesalud AP', '900891534');
    await asignarModulosEmpresa(mefesaludAp.id);

    const PW_MEFESALUD = 'Mefesalud2026';
    await crearUsuario(mefesaludAp.id, 'Admin@Mefesalud.com.co',        'Admin Mefesalud',       'admin',    PW_MEFESALUD, todosModulos);
    await crearUsuario(mefesaludAp.id, 'Contabilidad1@Mefesalud.com.co','Contabilidad 1',         'operator', PW_MEFESALUD, todosModulos);
    await crearUsuario(mefesaludAp.id, 'Contabilidad2@Mefesalud.com.co','Contabilidad 2',         'operator', PW_MEFESALUD, todosModulos);
    await crearUsuario(mefesaludAp.id, 'Facturacion1@Mefesalud.com.co', 'Facturación 1',          'operator', PW_MEFESALUD, todosModulos);
    await crearUsuario(mefesaludAp.id, 'Facturacion2@Mefesalud.com.co', 'Facturación 2',          'operator', PW_MEFESALUD, todosModulos);
    console.log('');
  }

  // ─── Mefesalud IPS ────────────────────────────────────────────────────────
  const mefesaludIpsExists = allCompanies.find(c => c.name.toLowerCase() === 'mefesalud ips');

  if (mefesaludIpsExists) {
    console.log('⚠  Mefesalud IPS ya existe, omitiendo creación.\n');
  } else {
    console.log('── Creando Mefesalud IPS ──────────────────────────────────────────');
    const mefesaludIps = await crearEmpresa('Mefesalud IPS', '900891534');
    await asignarModulosEmpresa(mefesaludIps.id);

    const PW_MEFESALUD = 'Mefesalud2026';
    await crearUsuario(mefesaludIps.id, 'Admin@Mefesalud.com.co', 'Admin Mefesalud IPS', 'admin', PW_MEFESALUD, todosModulos);
    console.log('');
  }

  // CRÍTICO: autoSave está desactivado en este proyecto; hay que guardar explícitamente
  // antes de destroy(), de lo contrario todos los cambios quedan en memoria y se pierden.
  await forceSqljsSave();
  console.log('[DB] BD guardada en disco.');

  await AppDataSource.destroy();
  console.log('\n✓ Seed multiempresa completado.');
  console.log('\nResumen de accesos:');
  console.log('  Neurum AP    → Admin@Neurum.com.co / Neurum2026');
  console.log('                 Contabilidad1-4@Neurum.com.co / Neurum2026');
  console.log('                 Facturacion1-5@Neurum.com.co / Neurum2026');
  console.log('  Mefesalud AP → Admin@Mefesalud.com.co / Mefesalud2026  (selector de empresa)');
  console.log('                 Contabilidad1-2@Mefesalud.com.co / Mefesalud2026');
  console.log('                 Facturacion1-2@Mefesalud.com.co / Mefesalud2026');
  console.log('  Mefesalud IPS→ Admin@Mefesalud.com.co / Mefesalud2026  (selector de empresa)');
}

main().catch(e => { console.error(e); process.exit(1); });
