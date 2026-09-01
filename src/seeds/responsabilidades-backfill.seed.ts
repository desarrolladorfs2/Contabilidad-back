/**
 * Seed / backfill de responsabilidades fiscales.
 * Migra los valores existentes en:
 *   - companies.tax_level_code   -> company_responsabilidades
 *   - terceros.nivel_tributario  -> tercero_responsabilidades
 *
 * Tambien siembra los codigos DIAN estandar en cat_responsabilidades_fiscales
 * si aun no existen (esto normalmente lo hace catalogo.seed.ts, pero se
 * garantiza aqui para independencia).
 *
 * Idempotente: no duplica registros existentes.
 */
import { DataSource } from 'typeorm';
import { Company } from '../entities/Company';
import { Tercero } from '../entities/Tercero';
import { CompanyResponsabilidad } from '../entities/CompanyResponsabilidad';
import { TerceroResponsabilidad } from '../entities/TerceroResponsabilidad';
import { TipoResponsabilidadFiscal } from '../entities/catalogo/TipoResponsabilidadFiscal';

// Catalogo completo DIAN de responsabilidades fiscales
const RESPONSABILIDADES_DIAN = [
  { codigo: 'O-13',   nombre: 'Gran contribuyente',                         aplica_persona_natural: false, aplica_persona_juridica: true,  orden: 1 },
  { codigo: 'O-15',   nombre: 'Autorretenedor',                              aplica_persona_natural: true,  aplica_persona_juridica: true,  orden: 2 },
  { codigo: 'O-23',   nombre: 'Agente de retención en la fuente',            aplica_persona_natural: true,  aplica_persona_juridica: true,  orden: 3 },
  { codigo: 'O-24',   nombre: 'Declarante de ingresos y patrimonio',         aplica_persona_natural: true,  aplica_persona_juridica: true,  orden: 4 },
  { codigo: 'O-47',   nombre: 'Régimen simple de tributación (SIMPLE)',      aplica_persona_natural: true,  aplica_persona_juridica: true,  orden: 5 },
  { codigo: 'R-99-PN',nombre: 'No responsable de IVA (Régimen Simplificado)',aplica_persona_natural: true,  aplica_persona_juridica: false, orden: 6 },
  { codigo: 'O-07',   nombre: 'Gran responsable del IVA',                    aplica_persona_natural: false, aplica_persona_juridica: true,  orden: 7 },
  { codigo: 'O-09',   nombre: 'Responsable del impuesto sobre las ventas IVA', aplica_persona_natural: true, aplica_persona_juridica: true, orden: 8 },
  { codigo: 'O-14',   nombre: 'Informante de exógena',                       aplica_persona_natural: true,  aplica_persona_juridica: true,  orden: 9 },
  { codigo: 'O-16',   nombre: 'Obligación financiera y de cambios',          aplica_persona_natural: true,  aplica_persona_juridica: true,  orden: 10 },
  { codigo: 'O-25',   nombre: 'Declarante del impuesto sobre la renta CREE', aplica_persona_natural: false, aplica_persona_juridica: true,  orden: 11 },
  { codigo: 'O-32',   nombre: 'Impuesto sobre las ventas régimen común',     aplica_persona_natural: true,  aplica_persona_juridica: true,  orden: 12 },
  { codigo: 'O-33',   nombre: 'Servicios excluidos del impuesto sobre ventas', aplica_persona_natural: true, aplica_persona_juridica: true, orden: 13 },
  { codigo: 'O-49',   nombre: 'Patrimonio',                                  aplica_persona_natural: true,  aplica_persona_juridica: false, orden: 14 },
  { codigo: 'O-50',   nombre: 'Productor de bienes exentos del IVA',         aplica_persona_natural: true,  aplica_persona_juridica: true,  orden: 15 },
  { codigo: 'O-53',   nombre: 'Usuario aduanero',                            aplica_persona_natural: true,  aplica_persona_juridica: true,  orden: 16 },
];

export async function seedResponsabilidadesBackfill(ds: DataSource): Promise<void> {
  const respRepo    = ds.getRepository(TipoResponsabilidadFiscal);
  const compRepo    = ds.getRepository(Company);
  const tercRepo    = ds.getRepository(Tercero);
  const compRespRepo = ds.getRepository(CompanyResponsabilidad);
  const tercRespRepo = ds.getRepository(TerceroResponsabilidad);

  // NOTA DE RENDIMIENTO: esta funcion corre en cada arranque del backend.
  // Con SQLite local, un findOne() de mas no se notaba (latencia ~0). Contra
  // una base remota (AWS RDS) cada findOne() es un viaje de red completo, asi
  // que aqui se evita deliberadamente cualquier consulta dentro de un for —
  // se trae todo lo necesario en pocas consultas masivas y se compara en
  // memoria con Sets, sin cambiar el comportamiento idempotente original.

  // 1. Garantizar que el catalogo tiene todos los codigos DIAN
  const catalogoExistente = await respRepo.find();
  const codigosCatalogo   = new Set(catalogoExistente.map(r => r.codigo));
  const nuevosCatalogo    = RESPONSABILIDADES_DIAN.filter(r => !codigosCatalogo.has(r.codigo));
  if (nuevosCatalogo.length > 0) {
    await respRepo.save(nuevosCatalogo.map(r => respRepo.create({
      codigo: r.codigo,
      nombre: r.nombre,
      aplica_persona_natural: r.aplica_persona_natural,
      aplica_persona_juridica: r.aplica_persona_juridica,
      orden: r.orden,
      activo: true,
    })));
    nuevosCatalogo.forEach(r => codigosCatalogo.add(r.codigo));
  }

  // 2. Backfill company_responsabilidades desde companies.tax_level_code
  const companies = await compRepo.find();
  const existingCompResp = await compRespRepo.find({ select: ['company_id', 'responsabilidad_codigo'] });
  const compRespKeys = new Set(existingCompResp.map(cr => `${cr.company_id}::${cr.responsabilidad_codigo}`));

  const nuevosCompResp: CompanyResponsabilidad[] = [];
  for (const company of companies) {
    if (!company.tax_level_code) continue;
    if (!codigosCatalogo.has(company.tax_level_code)) continue; // codigo desconocido — saltar
    const key = `${company.id}::${company.tax_level_code}`;
    if (compRespKeys.has(key)) continue;
    nuevosCompResp.push(compRespRepo.create({
      company_id:              company.id,
      responsabilidad_codigo:  company.tax_level_code,
      es_principal:            true,
    }));
    compRespKeys.add(key);
  }
  if (nuevosCompResp.length > 0) await compRespRepo.save(nuevosCompResp);

  // 3. Backfill tercero_responsabilidades desde terceros.nivel_tributario
  // Solo se traen id + nivel_tributario (no la entidad completa) — con bases
  // grandes (decenas de miles de terceros) traer todas las columnas de cada
  // fila es innecesario y lento.
  const terceros = await tercRepo
    .createQueryBuilder('t')
    .select(['t.id', 't.nivel_tributario'])
    .where('t.nivel_tributario IS NOT NULL')
    .getMany();

  const existingTercResp = await tercRespRepo.find({ select: ['tercero_id', 'responsabilidad_codigo'] });
  const tercRespKeys = new Set(existingTercResp.map(tr => `${tr.tercero_id}::${tr.responsabilidad_codigo}`));

  const nuevosTercResp: TerceroResponsabilidad[] = [];
  for (const tercero of terceros) {
    if (!tercero.nivel_tributario) continue;
    if (!codigosCatalogo.has(tercero.nivel_tributario)) continue;
    const key = `${tercero.id}::${tercero.nivel_tributario}`;
    if (tercRespKeys.has(key)) continue;
    nuevosTercResp.push(tercRespRepo.create({
      tercero_id:             tercero.id,
      responsabilidad_codigo: tercero.nivel_tributario,
      es_principal:           true,
    }));
    tercRespKeys.add(key);
  }

  // Insertar en lotes (una base con decenas de miles de terceros nuevos no
  // debe intentarse en una sola sentencia).
  const BATCH = 500;
  for (let i = 0; i < nuevosTercResp.length; i += BATCH) {
    await tercRespRepo.save(nuevosTercResp.slice(i, i + BATCH));
  }

  const total = nuevosCompResp.length + nuevosTercResp.length;
  if (total > 0) {
    console.log(`[Seed] Responsabilidades backfill: ${nuevosCompResp.length} empresas, ${nuevosTercResp.length} terceros`);
  }
}
