import { DataSource } from 'typeorm';
import { TipoCoberturaSalud } from '../entities/catalogo/TipoCoberturaSalud';
import { CategoriaRips }      from '../entities/catalogo/CategoriaRips';
import { CodigoDiscrepancia, TipoNotaDiscrepancia } from '../entities/catalogo/CodigoDiscrepancia';

const COBERTURAS: { codigo: string; nombre: string; orden: number }[] = [
  { codigo: 'POS-S',              nombre: 'Plan de Beneficios Subsidiado',                orden: 1 },
  { codigo: 'POS-C',              nombre: 'Plan de Beneficios Contributivo',              orden: 2 },
  { codigo: 'Complementario',     nombre: 'Plan Complementario',                          orden: 3 },
  { codigo: 'Voluntario',         nombre: 'Plan Voluntario',                              orden: 4 },
  { codigo: 'ARL',                nombre: 'Accidentes de Trabajo y Enfermedad Laboral',   orden: 5 },
  { codigo: 'Paquete',            nombre: 'Paquete de Servicios',                         orden: 6 },
  { codigo: 'Evento',             nombre: 'Pago por Evento',                              orden: 7 },
  { codigo: 'Global_Prospectivo', nombre: 'Capita / Global Prospectivo',                  orden: 8 },
  { codigo: 'SOAT',               nombre: 'Seguro Obligatorio de Accidentes de Transito', orden: 9 },
];

const CATEGORIAS_RIPS: { codigo: string; nombre: string; descripcion: string; orden: number }[] = [
  { codigo: 'consultas',       nombre: 'Consultas',               descripcion: 'Consultas medicas y de especialidad',                     orden: 1 },
  { codigo: 'procedimientos',  nombre: 'Procedimientos',          descripcion: 'Procedimientos quirurgicos, terapeuticos y diagnosticos', orden: 2 },
  { codigo: 'urgencias',       nombre: 'Urgencias',               descripcion: 'Atencion de urgencias',                                   orden: 3 },
  { codigo: 'hospitalizacion', nombre: 'Hospitalizacion',         descripcion: 'Estancias y servicios de hospitalizacion',                orden: 4 },
  { codigo: 'medicamentos',    nombre: 'Medicamentos y Dispositivos', descripcion: 'Medicamentos, dispositivos y material especial',      orden: 5 },
  { codigo: 'otrosServicios',  nombre: 'Otros Servicios',         descripcion: 'Traslado, oxigeno domiciliario y otros servicios',        orden: 6 },
];

// Codigos DIAN para notas credito y debito (Anexo tecnico FE v1.9)
const CODIGOS_DISCREPANCIA: { codigo: string; descripcion: string; tipo_nota: TipoNotaDiscrepancia; orden: number }[] = [
  { codigo: '1', descripcion: 'Devolucion parcial de los bienes y/o no aceptacion parcial del servicio', tipo_nota: 'credito', orden: 1 },
  { codigo: '2', descripcion: 'Anulacion de factura electronica',                                         tipo_nota: 'credito', orden: 2 },
  { codigo: '3', descripcion: 'Rebaja o descuento parcial o total',                                       tipo_nota: 'credito', orden: 3 },
  { codigo: '4', descripcion: 'Ajuste de precio',                                                         tipo_nota: 'credito', orden: 4 },
  { codigo: '5', descripcion: 'Otros',                                                                    tipo_nota: 'ambos',   orden: 5 },
  { codigo: '6', descripcion: 'Intereses',                                                                tipo_nota: 'debito',  orden: 6 },
  { codigo: '7', descripcion: 'Gastos por cobrar',                                                        tipo_nota: 'debito',  orden: 7 },
  { codigo: '8', descripcion: 'Cambio del valor',                                                         tipo_nota: 'debito',  orden: 8 },
];

export async function seedCatalogoSalud(ds: DataSource): Promise<void> {
  const covRepo  = ds.getRepository(TipoCoberturaSalud);
  const ripsRepo = ds.getRepository(CategoriaRips);
  const discRepo = ds.getRepository(CodigoDiscrepancia);

  let ins = 0;

  for (const d of COBERTURAS) {
    const existe = await covRepo.findOne({ where: { codigo: d.codigo } });
    if (!existe) {
      await covRepo.save(covRepo.create({ ...d, activo: true }));
      ins++;
    }
  }

  for (const d of CATEGORIAS_RIPS) {
    const existe = await ripsRepo.findOne({ where: { codigo: d.codigo } });
    if (!existe) {
      await ripsRepo.save(ripsRepo.create({ ...d, activo: true }));
      ins++;
    }
  }

  for (const d of CODIGOS_DISCREPANCIA) {
    const existe = await discRepo.findOne({ where: { codigo: d.codigo } });
    if (!existe) {
      await discRepo.save(discRepo.create({ ...d, activo: true }));
      ins++;
    }
  }

  if (ins > 0) {
    console.log('[Seed] ' + ins + ' registros catalogo salud insertados');
  }
}
