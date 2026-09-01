import 'reflect-metadata';
import { buildHealthEventoXmlPayload } from './src/utils/dian-payload.utils';

const factura: any = {
  pacientes_json: JSON.stringify([{
    tipoDocumentoIdentificacion: 'CC', numDocumentoIdentificacion: '10217389',
    tipoUsuario: '01', fechaNacimiento: '1949-12-30', codSexo: 'M',
    codMunicipioResidencia: '05001', codZonaTerritorialResidencia: '01',
    servicios: { consultas: [{
      codPrestador: '050011399101', fechaInicioAtencion: '2026-07-22 00:00',
      codConsulta: '890351', modalidadGrupoServicioTecSal: '01', grupoServicios: '01',
      codServicio: 321, finalidadTecnologiaSalud: '15', causaMotivoAtencion: '38',
      codDiagnosticoPrincipal: 'D693', tipoDiagnosticoPrincipal: '02',
      tipoDocumentoIdentificacion: 'CC', numDocumentoIdentificacion: '43866093',
      numAutorizacion: '2796-98169802', vrServicio: 300000,
    }] } }]),
  contrato: { cucon: 'ABC', cod_prestador: '050011399101' },
  regimen: 'contributivo',
  issue_date: '2026-08-31',
  subtotal: 300000,
};
const company: any = { nit: '900746052', name: 'NEURUM SAS' };
const settings: any = {};
const payload = buildHealthEventoXmlPayload(factura, company, settings, 63, 'PRUE');
console.log('invoice_period_start:', payload.invoice_period_start);
console.log('invoice_period_end:', payload.invoice_period_end);
console.log('issue_date:', payload.issue_date);
