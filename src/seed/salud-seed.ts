// @ts-nocheck
/**
 * Seed: datos de prueba módulo Salud
 * Uso: npx ts-node src/seed/salud-seed.ts
 *
 * Crea:
 *  - 4 EPS (Savia Salud, Sanitas, SOS, Nueva EPS)
 *  - 16 servicios CUPS (8 diabetes + 8 hemofilia)
 *  - 8 contratos (distribución por ciudad según especificación)
 *  - Asignación de servicios a cada contrato según su patología
 */

import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();

import { initDatabase, AppDataSource } from '../config/database';
import { Eps, EpsTipo } from '../entities/salud/Eps';
import { ContratoSalud } from '../entities/salud/ContratoSalud';
import { ServicioSalud, CategoriaRips } from '../entities/salud/ServicioSalud';
import { ContratoServicio } from '../entities/salud/ContratoServicio';
import { Company } from '../entities/Company';

// ─────────────────────────────────────────────────────────────────────────────
// Datos maestros
// ─────────────────────────────────────────────────────────────────────────────

const EPS_DATA: Array<Partial<Eps> & { nit: string }> = [
  {
    nit: '800251440', nombre: 'SAVIA SALUD EPS', nombre_comercial: 'Savia Salud',
    tipo: 'EPS', codigo_adres: 'EPS036',
    email: 'contacto@saviasalud.com.co', telefono: '6044447700',
    ciudad_codigo: '05001', ciudad_nombre: 'Medellín',
    departamento_codigo: '05', departamento_nombre: 'Antioquia',
  },
  {
    nit: '860700496', nombre: 'SANITAS EPS S.A.', nombre_comercial: 'Sanitas',
    tipo: 'EPS', codigo_adres: 'EPS018',
    email: 'servicio@sanitas.com.co', telefono: '6016913993',
    ciudad_codigo: '11001', ciudad_nombre: 'Bogotá D.C.',
    departamento_codigo: '11', departamento_nombre: 'Bogotá D.C.',
  },
  {
    nit: '890900518', nombre: 'SUROESTE S.A. SOS EPS', nombre_comercial: 'SOS',
    tipo: 'EPS', codigo_adres: 'EPS031',
    email: 'contacto@sos-eps.com.co', telefono: '6025148000',
    ciudad_codigo: '76001', ciudad_nombre: 'Cali',
    departamento_codigo: '76', departamento_nombre: 'Valle del Cauca',
  },
  {
    nit: '900156264', nombre: 'NUEVA EPS S.A.', nombre_comercial: 'Nueva EPS',
    tipo: 'EPS', codigo_adres: 'EPS047',
    email: 'servicio@nuevaeps.com.co', telefono: '6018879700',
    ciudad_codigo: '11001', ciudad_nombre: 'Bogotá D.C.',
    departamento_codigo: '11', departamento_nombre: 'Bogotá D.C.',
  },
];

const CUPS_DIABETES: Array<Partial<ServicioSalud>> = [
  { codigo_cups: '890601', nombre: 'CONSULTA PRIMERA VEZ - ENDOCRINOLOGÍA',         categoria: 'consultas',      valor_base: 85000,  descripcion: 'Primera consulta especializada en endocrinología para manejo de diabetes' },
  { codigo_cups: '890602', nombre: 'CONSULTA DE CONTROL - ENDOCRINOLOGÍA',           categoria: 'consultas',      valor_base: 68000,  descripcion: 'Consulta de seguimiento en endocrinología' },
  { codigo_cups: '903411', nombre: 'GLUCOSA EN SUERO - CUANTITATIVA',                categoria: 'procedimientos', valor_base: 12000,  descripcion: 'Medición de glucemia en ayunas' },
  { codigo_cups: '903461', nombre: 'HEMOGLOBINA GLICOSILADA (HbA1c)',                categoria: 'procedimientos', valor_base: 35000,  descripcion: 'Control metabólico a 3 meses, estándar de oro en diabetes' },
  { codigo_cups: '903562', nombre: 'MICROALBUMINURIA EN MUESTRA AISLADA',            categoria: 'procedimientos', valor_base: 28000,  descripcion: 'Detección temprana de nefropatía diabética' },
  { codigo_cups: '903141', nombre: 'PERFIL LIPÍDICO COMPLETO',                       categoria: 'procedimientos', valor_base: 42000,  descripcion: 'Colesterol total, HDL, LDL, triglicéridos' },
  { codigo_cups: 'A10BA02', nombre: 'METFORMINA 850MG TABLETA',                      categoria: 'medicamentos',   valor_base: 320,    descripcion: 'Antidiabético oral primera línea' },
  { codigo_cups: 'A10AE04', nombre: 'INSULINA GLARGINA 100UI/ML SOLUCIÓN INYECTABLE',categoria: 'medicamentos',   valor_base: 185000, descripcion: 'Insulina basal análoga de larga acción' },
];

const CUPS_HEMOFILIA: Array<Partial<ServicioSalud>> = [
  { codigo_cups: '890403', nombre: 'CONSULTA PRIMERA VEZ - HEMATOLOGÍA',             categoria: 'consultas',      valor_base: 92000,  descripcion: 'Primera consulta hematológica para diagnóstico y manejo de hemofilia' },
  { codigo_cups: '890404', nombre: 'CONSULTA DE CONTROL - HEMATOLOGÍA',              categoria: 'consultas',      valor_base: 74000,  descripcion: 'Seguimiento periódico en hematología' },
  { codigo_cups: '903531', nombre: 'FACTOR VIII - ACTIVIDAD (COAGULACIÓN)',          categoria: 'procedimientos', valor_base: 95000,  descripcion: 'Cuantificación de actividad del Factor VIII para hemofilia A' },
  { codigo_cups: '903532', nombre: 'FACTOR IX - ACTIVIDAD (COAGULACIÓN)',            categoria: 'procedimientos', valor_base: 95000,  descripcion: 'Cuantificación de actividad del Factor IX para hemofilia B' },
  { codigo_cups: '903521', nombre: 'TIEMPO PARCIAL DE TROMBOPLASTINA ACTIVADO (APTT)',categoria: 'procedimientos', valor_base: 22000,  descripcion: 'Evaluación de la vía intrínseca de la coagulación' },
  { codigo_cups: '903526', nombre: 'DETECCIÓN DE INHIBIDORES FACTOR VIII Y IX',      categoria: 'procedimientos', valor_base: 185000, descripcion: 'Bethesda: cuantificación de anticuerpos inhibidores' },
  { codigo_cups: 'B02BD02', nombre: 'FACTOR VIII DE COAGULACIÓN RECOMBINANTE 500UI', categoria: 'medicamentos',   valor_base: 1250000,descripcion: 'Factor VIII recombinante para hemofilia A severa' },
  { codigo_cups: 'B02BD04', nombre: 'FACTOR IX DE COAGULACIÓN RECOMBINANTE 500UI',   categoria: 'medicamentos',   valor_base: 1450000,descripcion: 'Factor IX recombinante para hemofilia B' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Contratos: 8 en total
//  Savia  → Medellín: diabetes + hemofilia
//  SOS    → Cali:     diabetes + hemofilia
//  Sanitas→ Medellín (hemofilia) + Pereira (hemofilia) + Cali (hemofilia)
//  Nueva  → Medellín: hemofilia
// ─────────────────────────────────────────────────────────────────────────────

type ContratoSpec = {
  epsNit: string;
  numero: string;
  descripcion: string;
  ciudad: string;
  modalidad: 'Evento' | 'PGP';
  tipo_operacion_ss: string;
  tipo_cobertura: string;
  patologia: 'diabetes' | 'hemofilia';
};

const CONTRATOS: ContratoSpec[] = [
  // ── SAVIA SALUD ──
  {
    epsNit: '800251440', numero: 'CTR-SAV-DM-2025', ciudad: 'Medellín',
    descripcion: 'Contrato atención diabetes mellitus - régimen subsidiado Antioquia',
    modalidad: 'Evento', tipo_operacion_ss: 'SS-CUFE', tipo_cobertura: 'POS-S',
    patologia: 'diabetes',
  },
  {
    epsNit: '800251440', numero: 'CTR-SAV-HEM-2025', ciudad: 'Medellín',
    descripcion: 'Contrato atención hemofilia - alto costo Antioquia',
    modalidad: 'Evento', tipo_operacion_ss: 'SS-CUFE', tipo_cobertura: 'POS-S',
    patologia: 'hemofilia',
  },
  // ── SOS ──
  {
    epsNit: '890900518', numero: 'CTR-SOS-DM-2025', ciudad: 'Cali',
    descripcion: 'Contrato atención diabetes mellitus - Valle del Cauca',
    modalidad: 'Evento', tipo_operacion_ss: 'SS-CUFE', tipo_cobertura: 'POS-C',
    patologia: 'diabetes',
  },
  {
    epsNit: '890900518', numero: 'CTR-SOS-HEM-2025', ciudad: 'Cali',
    descripcion: 'Contrato atención hemofilia - alto costo Valle del Cauca',
    modalidad: 'Evento', tipo_operacion_ss: 'SS-CUFE', tipo_cobertura: 'POS-C',
    patologia: 'hemofilia',
  },
  // ── SANITAS ──
  {
    epsNit: '860700496', numero: 'CTR-SAN-HEM-MDE-2025', ciudad: 'Medellín',
    descripcion: 'Contrato hemofilia - sede Medellín',
    modalidad: 'Evento', tipo_operacion_ss: 'SS-CUFE', tipo_cobertura: 'POS-C',
    patologia: 'hemofilia',
  },
  {
    epsNit: '860700496', numero: 'CTR-SAN-HEM-PEI-2025', ciudad: 'Pereira',
    descripcion: 'Contrato hemofilia - sede Pereira',
    modalidad: 'Evento', tipo_operacion_ss: 'SS-CUFE', tipo_cobertura: 'POS-C',
    patologia: 'hemofilia',
  },
  {
    epsNit: '860700496', numero: 'CTR-SAN-HEM-CAL-2025', ciudad: 'Cali',
    descripcion: 'Contrato hemofilia - sede Cali',
    modalidad: 'Evento', tipo_operacion_ss: 'SS-CUFE', tipo_cobertura: 'POS-C',
    patologia: 'hemofilia',
  },
  // ── NUEVA EPS ──
  {
    epsNit: '900156264', numero: 'CTR-NVA-HEM-MDE-2025', ciudad: 'Medellín',
    descripcion: 'Contrato hemofilia - sede Medellín',
    modalidad: 'Evento', tipo_operacion_ss: 'SS-CUFE', tipo_cobertura: 'POS-C',
    patologia: 'hemofilia',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  await initDatabase();

  const companyRepo = AppDataSource.getRepository(Company);
  const epsRepo     = AppDataSource.getRepository(Eps);
  const svcRepo     = AppDataSource.getRepository(ServicioSalud);
  const ctoRepo     = AppDataSource.getRepository(ContratoSalud);
  const csRepo      = AppDataSource.getRepository(ContratoServicio);

  // Usar la primera empresa de la BD
  const company = await companyRepo.findOne({ where: {} });
  if (!company) {
    console.error('❌  No hay empresas en la base de datos. Crea una empresa primero.');
    process.exit(1);
  }
  const cid = company.id;
  console.log(`✔  Empresa: ${company.name} (${cid})`);

  // ── 1. EPS ──────────────────────────────────────────────────────────────────
  console.log('\n── Creando EPS ──');
  const epsMap: Record<string, Eps> = {};

  for (const data of EPS_DATA) {
    let eps = await epsRepo.findOne({ where: { nit: data.nit, company_id: cid } });
    if (eps) {
      console.log(`  ⚠  EPS ya existe: ${data.nombre_comercial} — actualizando`);
      epsRepo.merge(eps, { ...data as any, company_id: cid, activo: true });
    } else {
      eps = epsRepo.create({ ...data as any, company_id: cid, activo: true });
    }
    eps = await epsRepo.save(eps);
    epsMap[data.nit] = eps;
    console.log(`  ✔  ${data.nombre_comercial} (NIT ${data.nit})`);
  }

  // ── 2. Servicios CUPS ────────────────────────────────────────────────────────
  console.log('\n── Creando servicios CUPS ──');
  const svcDiabetesIds: string[] = [];
  const svcHemofiliaIds: string[] = [];

  for (const data of [...CUPS_DIABETES, ...CUPS_HEMOFILIA]) {
    let svc = await svcRepo.findOne({ where: { codigo_cups: data.codigo_cups, company_id: cid } });
    if (svc) {
      console.log(`  ⚠  CUPS ya existe: ${data.codigo_cups} — actualizando`);
      svcRepo.merge(svc, { ...data as any, company_id: cid });
    } else {
      svc = svcRepo.create({ ...data as any, company_id: cid, activo: true });
    }
    svc = await svcRepo.save(svc);

    const isDiabetes = CUPS_DIABETES.some(d => d.codigo_cups === data.codigo_cups);
    if (isDiabetes) svcDiabetesIds.push(svc.id);
    else             svcHemofiliaIds.push(svc.id);
    console.log(`  ✔  ${data.codigo_cups} — ${data.nombre.slice(0, 50)}`);
  }

  // ── 3. Contratos + asignación de servicios ──────────────────────────────────
  console.log('\n── Creando contratos ──');

  for (const spec of CONTRATOS) {
    const eps = epsMap[spec.epsNit];
    if (!eps) { console.warn(`  ⚠  EPS ${spec.epsNit} no encontrada`); continue; }

    let cto = await ctoRepo.findOne({ where: { numero: spec.numero, company_id: cid } });
    if (cto) {
      console.log(`  ⚠  Contrato ya existe: ${spec.numero} — actualizando`);
    } else {
      cto = ctoRepo.create({
        company_id:        cid,
        eps_id:            eps.id,
        numero:            spec.numero,
        descripcion:       spec.descripcion,
        ciudad:            spec.ciudad,
        modalidad_pago:    spec.modalidad,
        tipo_operacion_ss: spec.tipo_operacion_ss,
        tipo_cobertura:    spec.tipo_cobertura,
        cod_prestador:     '',
        fecha_inicio:      '2025-01-01',
        fecha_fin:         '2025-12-31',
        estado:            'activo',
      });
    }
    cto = await ctoRepo.save(cto);
    console.log(`  ✔  ${spec.numero} — ${eps.nombre_comercial} — ${spec.ciudad} — ${spec.patologia}`);

    // Asignar servicios según patología
    const svcIds = spec.patologia === 'diabetes' ? svcDiabetesIds : svcHemofiliaIds;
    let asignados = 0;
    for (const svcId of svcIds) {
      const exists = await csRepo.findOne({ where: { contrato_id: cto.id, servicio_id: svcId } });
      if (!exists) {
        await csRepo.save(csRepo.create({ contrato_id: cto.id, servicio_id: svcId, habilitado: true }));
        asignados++;
      }
    }
    console.log(`     → ${asignados} servicios asignados`);
  }

  console.log('\n✅  Seed completado.');
  await AppDataSource.destroy();
}

run().catch(e => { console.error('❌  Error:', e); process.exit(1); });
