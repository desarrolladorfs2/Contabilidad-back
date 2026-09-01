/**
 * Seed de catálogos estáticos del sistema.
 * Datos de referencia colombianos: tipos de documento, países,
 * departamentos, municipios y responsabilidades fiscales DIAN.
 *
 * Idempotente: nunca duplica ni borra registros existentes.
 * Se ejecuta al iniciar el backend junto con seedModulos.
 */
import { DataSource } from 'typeorm';
import { TipoDocumentoIdentidad } from '../entities/catalogo/TipoDocumentoIdentidad';
import { Pais } from '../entities/catalogo/Pais';
import { Departamento } from '../entities/catalogo/Departamento';
import { Municipio } from '../entities/catalogo/Municipio';
import { TipoResponsabilidadFiscal } from '../entities/catalogo/TipoResponsabilidadFiscal';
import { ActividadEconomica } from '../entities/catalogo/ActividadEconomica';
import { EmpresaModulo } from '../entities/EmpresaModulo';
import { Company } from '../entities/Company';
import { Modulo } from '../entities/Modulo';

// ── Datos de referencia ───────────────────────────────────────────────────────

const TIPOS_DOCUMENTO = [
  { codigo: 'CC',   codigo_dian: '13', nombre: 'Cédula de Ciudadanía',                      aplica_persona_natural: true,  aplica_persona_juridica: false, requiere_dv: false, orden: 1 },
  { codigo: 'NIT',  codigo_dian: '31', nombre: 'NIT',                                        aplica_persona_natural: false, aplica_persona_juridica: true,  requiere_dv: true,  orden: 2 },
  { codigo: 'CE',   codigo_dian: '22', nombre: 'Cédula de Extranjería',                      aplica_persona_natural: true,  aplica_persona_juridica: false, requiere_dv: false, orden: 3 },
  { codigo: 'PP',   codigo_dian: '41', nombre: 'Pasaporte',                                  aplica_persona_natural: true,  aplica_persona_juridica: false, requiere_dv: false, orden: 4 },
  { codigo: 'TI',   codigo_dian: '12', nombre: 'Tarjeta de Identidad',                       aplica_persona_natural: true,  aplica_persona_juridica: false, requiere_dv: false, orden: 5 },
  { codigo: 'RC',   codigo_dian: '11', nombre: 'Registro Civil',                             aplica_persona_natural: true,  aplica_persona_juridica: false, requiere_dv: false, orden: 6 },
  { codigo: 'DE',   codigo_dian: '42', nombre: 'Documento de Identificación Extranjero',     aplica_persona_natural: true,  aplica_persona_juridica: true,  requiere_dv: false, orden: 7 },
  { codigo: 'PEP',  codigo_dian: '47', nombre: 'Permiso Especial de Permanencia',            aplica_persona_natural: true,  aplica_persona_juridica: false, requiere_dv: false, orden: 8 },
  { codigo: 'NUIP', codigo_dian: '50', nombre: 'Número Único de Identificación Personal',    aplica_persona_natural: true,  aplica_persona_juridica: false, requiere_dv: false, orden: 9 },
  // RUT no es un tipo de documento DIAN independiente; es el certificado del NIT (código 31).
  // Se omite para evitar duplicado en codigo_dian.
  // Agregados al cargar la base de terceros de SIESA (Entrega 40): aparecían en esos
  // datos reales y no estaban en este catálogo todavía.
  { codigo: 'TE',   codigo_dian: '21', nombre: 'Tarjeta de Extranjería',                     aplica_persona_natural: true,  aplica_persona_juridica: false, requiere_dv: false, orden: 10 },
  { codigo: 'PT',   codigo_dian: '48', nombre: 'Permiso por Protección Temporal',            aplica_persona_natural: true,  aplica_persona_juridica: false, requiere_dv: false, orden: 11 },
  { codigo: 'SIN',  codigo_dian: '43', nombre: 'Sin Identificación del Exterior',            aplica_persona_natural: true,  aplica_persona_juridica: true,  requiere_dv: false, orden: 12 },
];

const PAISES = [
  { codigo_iso2: 'CO', codigo_iso3: 'COL', codigo_iso_num: '170', nombre: 'Colombia',          nombre_en: 'Colombia' },
  { codigo_iso2: 'US', codigo_iso3: 'USA', codigo_iso_num: '840', nombre: 'Estados Unidos',    nombre_en: 'United States' },
  { codigo_iso2: 'MX', codigo_iso3: 'MEX', codigo_iso_num: '484', nombre: 'México',            nombre_en: 'Mexico' },
  { codigo_iso2: 'ES', codigo_iso3: 'ESP', codigo_iso_num: '724', nombre: 'España',            nombre_en: 'Spain' },
  { codigo_iso2: 'BR', codigo_iso3: 'BRA', codigo_iso_num: '076', nombre: 'Brasil',            nombre_en: 'Brazil' },
  { codigo_iso2: 'AR', codigo_iso3: 'ARG', codigo_iso_num: '032', nombre: 'Argentina',         nombre_en: 'Argentina' },
  { codigo_iso2: 'CL', codigo_iso3: 'CHL', codigo_iso_num: '152', nombre: 'Chile',             nombre_en: 'Chile' },
  { codigo_iso2: 'PE', codigo_iso3: 'PER', codigo_iso_num: '604', nombre: 'Perú',              nombre_en: 'Peru' },
  { codigo_iso2: 'VE', codigo_iso3: 'VEN', codigo_iso_num: '862', nombre: 'Venezuela',         nombre_en: 'Venezuela' },
  { codigo_iso2: 'EC', codigo_iso3: 'ECU', codigo_iso_num: '218', nombre: 'Ecuador',           nombre_en: 'Ecuador' },
  { codigo_iso2: 'PA', codigo_iso3: 'PAN', codigo_iso_num: '591', nombre: 'Panamá',            nombre_en: 'Panama' },
  { codigo_iso2: 'CN', codigo_iso3: 'CHN', codigo_iso_num: '156', nombre: 'China',             nombre_en: 'China' },
  { codigo_iso2: 'DE', codigo_iso3: 'DEU', codigo_iso_num: '276', nombre: 'Alemania',          nombre_en: 'Germany' },
  { codigo_iso2: 'FR', codigo_iso3: 'FRA', codigo_iso_num: '250', nombre: 'Francia',           nombre_en: 'France' },
  { codigo_iso2: 'IT', codigo_iso3: 'ITA', codigo_iso_num: '380', nombre: 'Italia',            nombre_en: 'Italy' },
];

// 33 departamentos de Colombia — códigos DANE oficiales
const DEPARTAMENTOS = [
  { codigo_dane: '05', nombre: 'Antioquia' },
  { codigo_dane: '08', nombre: 'Atlántico' },
  { codigo_dane: '11', nombre: 'Bogotá D.C.' },
  { codigo_dane: '13', nombre: 'Bolívar' },
  { codigo_dane: '15', nombre: 'Boyacá' },
  { codigo_dane: '17', nombre: 'Caldas' },
  { codigo_dane: '18', nombre: 'Caquetá' },
  { codigo_dane: '19', nombre: 'Cauca' },
  { codigo_dane: '20', nombre: 'Cesar' },
  { codigo_dane: '23', nombre: 'Córdoba' },
  { codigo_dane: '25', nombre: 'Cundinamarca' },
  { codigo_dane: '27', nombre: 'Chocó' },
  { codigo_dane: '41', nombre: 'Huila' },
  { codigo_dane: '44', nombre: 'La Guajira' },
  { codigo_dane: '47', nombre: 'Magdalena' },
  { codigo_dane: '50', nombre: 'Meta' },
  { codigo_dane: '52', nombre: 'Nariño' },
  { codigo_dane: '54', nombre: 'Norte de Santander' },
  { codigo_dane: '63', nombre: 'Quindío' },
  { codigo_dane: '66', nombre: 'Risaralda' },
  { codigo_dane: '68', nombre: 'Santander' },
  { codigo_dane: '70', nombre: 'Sucre' },
  { codigo_dane: '73', nombre: 'Tolima' },
  { codigo_dane: '76', nombre: 'Valle del Cauca' },
  { codigo_dane: '81', nombre: 'Arauca' },
  { codigo_dane: '85', nombre: 'Casanare' },
  { codigo_dane: '86', nombre: 'Putumayo' },
  { codigo_dane: '88', nombre: 'Archipiélago de San Andrés, Providencia y Santa Catalina' },
  { codigo_dane: '91', nombre: 'Amazonas' },
  { codigo_dane: '94', nombre: 'Guainía' },
  { codigo_dane: '95', nombre: 'Guaviare' },
  { codigo_dane: '97', nombre: 'Vaupés' },
  { codigo_dane: '99', nombre: 'Vichada' },
];

// Municipios: capitales + ciudades principales
// dept_codigo: primeros 2 dígitos del código DANE del municipio
const MUNICIPIOS: { codigo_dane: string; nombre: string; dept_codigo: string; es_capital: boolean }[] = [
  // Antioquia (05)
  { codigo_dane: '05001', nombre: 'Medellín',         dept_codigo: '05', es_capital: true  },
  { codigo_dane: '05088', nombre: 'Bello',            dept_codigo: '05', es_capital: false },
  { codigo_dane: '05266', nombre: 'Envigado',         dept_codigo: '05', es_capital: false },
  { codigo_dane: '05360', nombre: 'Itagüí',           dept_codigo: '05', es_capital: false },
  { codigo_dane: '05615', nombre: 'Rionegro',         dept_codigo: '05', es_capital: false },
  // Atlántico (08)
  { codigo_dane: '08001', nombre: 'Barranquilla',     dept_codigo: '08', es_capital: true  },
  { codigo_dane: '08520', nombre: 'Soledad',          dept_codigo: '08', es_capital: false },
  // Bogotá D.C. (11)
  { codigo_dane: '11001', nombre: 'Bogotá D.C.',      dept_codigo: '11', es_capital: true  },
  // Bolívar (13)
  { codigo_dane: '13001', nombre: 'Cartagena de Indias', dept_codigo: '13', es_capital: true },
  { codigo_dane: '13430', nombre: 'Magangué',         dept_codigo: '13', es_capital: false },
  // Boyacá (15)
  { codigo_dane: '15001', nombre: 'Tunja',            dept_codigo: '15', es_capital: true  },
  { codigo_dane: '15238', nombre: 'Duitama',          dept_codigo: '15', es_capital: false },
  { codigo_dane: '15693', nombre: 'Sogamoso',         dept_codigo: '15', es_capital: false },
  // Caldas (17)
  { codigo_dane: '17001', nombre: 'Manizales',        dept_codigo: '17', es_capital: true  },
  // Caquetá (18)
  { codigo_dane: '18001', nombre: 'Florencia',        dept_codigo: '18', es_capital: true  },
  // Cauca (19)
  { codigo_dane: '19001', nombre: 'Popayán',          dept_codigo: '19', es_capital: true  },
  // Cesar (20)
  { codigo_dane: '20001', nombre: 'Valledupar',       dept_codigo: '20', es_capital: true  },
  // Córdoba (23)
  { codigo_dane: '23001', nombre: 'Montería',         dept_codigo: '23', es_capital: true  },
  // Cundinamarca (25)
  { codigo_dane: '25175', nombre: 'Chía',             dept_codigo: '25', es_capital: false },
  { codigo_dane: '25290', nombre: 'Facatativá',       dept_codigo: '25', es_capital: true  },
  { codigo_dane: '25754', nombre: 'Soacha',           dept_codigo: '25', es_capital: false },
  { codigo_dane: '25307', nombre: 'Girardot',         dept_codigo: '25', es_capital: false },
  { codigo_dane: '25899', nombre: 'Zipaquirá',        dept_codigo: '25', es_capital: false },
  // Chocó (27)
  { codigo_dane: '27001', nombre: 'Quibdó',           dept_codigo: '27', es_capital: true  },
  // Huila (41)
  { codigo_dane: '41001', nombre: 'Neiva',            dept_codigo: '41', es_capital: true  },
  // La Guajira (44)
  { codigo_dane: '44001', nombre: 'Riohacha',         dept_codigo: '44', es_capital: true  },
  // Magdalena (47)
  { codigo_dane: '47001', nombre: 'Santa Marta',      dept_codigo: '47', es_capital: true  },
  // Meta (50)
  { codigo_dane: '50001', nombre: 'Villavicencio',    dept_codigo: '50', es_capital: true  },
  // Nariño (52)
  { codigo_dane: '52001', nombre: 'Pasto',            dept_codigo: '52', es_capital: true  },
  { codigo_dane: '52835', nombre: 'Tumaco',           dept_codigo: '52', es_capital: false },
  // Norte de Santander (54)
  { codigo_dane: '54001', nombre: 'Cúcuta',           dept_codigo: '54', es_capital: true  },
  // Quindío (63)
  { codigo_dane: '63001', nombre: 'Armenia',          dept_codigo: '63', es_capital: true  },
  // Risaralda (66)
  { codigo_dane: '66001', nombre: 'Pereira',          dept_codigo: '66', es_capital: true  },
  // Santander (68)
  { codigo_dane: '68001', nombre: 'Bucaramanga',      dept_codigo: '68', es_capital: true  },
  { codigo_dane: '68081', nombre: 'Barrancabermeja',  dept_codigo: '68', es_capital: false },
  { codigo_dane: '68276', nombre: 'Floridablanca',    dept_codigo: '68', es_capital: false },
  { codigo_dane: '68307', nombre: 'Girón',            dept_codigo: '68', es_capital: false },
  // Sucre (70)
  { codigo_dane: '70001', nombre: 'Sincelejo',        dept_codigo: '70', es_capital: true  },
  // Tolima (73)
  { codigo_dane: '73001', nombre: 'Ibagué',           dept_codigo: '73', es_capital: true  },
  // Valle del Cauca (76)
  { codigo_dane: '76001', nombre: 'Cali',             dept_codigo: '76', es_capital: true  },
  { codigo_dane: '76109', nombre: 'Buenaventura',     dept_codigo: '76', es_capital: false },
  { codigo_dane: '76520', nombre: 'Palmira',          dept_codigo: '76', es_capital: false },
  { codigo_dane: '76563', nombre: 'Palmira',          dept_codigo: '76', es_capital: false },
  { codigo_dane: '76111', nombre: 'Buga',             dept_codigo: '76', es_capital: false },
  { codigo_dane: '76130', nombre: 'Cartago',          dept_codigo: '76', es_capital: false },
  { codigo_dane: '76834', nombre: 'Tulúa',            dept_codigo: '76', es_capital: false },
  // Arauca (81)
  { codigo_dane: '81001', nombre: 'Arauca',           dept_codigo: '81', es_capital: true  },
  // Casanare (85)
  { codigo_dane: '85001', nombre: 'Yopal',            dept_codigo: '85', es_capital: true  },
  // Putumayo (86)
  { codigo_dane: '86001', nombre: 'Mocoa',            dept_codigo: '86', es_capital: true  },
  // San Andrés (88)
  { codigo_dane: '88001', nombre: 'San Andrés',       dept_codigo: '88', es_capital: true  },
  // Amazonas (91)
  { codigo_dane: '91001', nombre: 'Leticia',          dept_codigo: '91', es_capital: true  },
  // Guainía (94)
  { codigo_dane: '94001', nombre: 'Inírida',          dept_codigo: '94', es_capital: true  },
  // Guaviare (95)
  { codigo_dane: '95001', nombre: 'San José del Guaviare', dept_codigo: '95', es_capital: true },
  // Vaupés (97)
  { codigo_dane: '97001', nombre: 'Mitú',             dept_codigo: '97', es_capital: true  },
  // Vichada (99)
  { codigo_dane: '99001', nombre: 'Puerto Carreño',   dept_codigo: '99', es_capital: true  },
];

const RESPONSABILIDADES_FISCALES = [
  { codigo: 'O-13', nombre: 'Gran Contribuyente',                    descripcion: 'Persona natural o jurídica calificada por la DIAN como gran contribuyente.',           aplica_persona_natural: true,  aplica_persona_juridica: true,  orden: 1 },
  { codigo: 'O-15', nombre: 'Autorretenedor',                        descripcion: 'Autorizado por la DIAN para practicarse su propia retención en la fuente.',             aplica_persona_natural: true,  aplica_persona_juridica: true,  orden: 2 },
  { codigo: 'O-23', nombre: 'Agente de Retención en la Fuente',      descripcion: 'Obligado a retener en la fuente sobre pagos realizados.',                              aplica_persona_natural: true,  aplica_persona_juridica: true,  orden: 3 },
  { codigo: 'O-24', nombre: 'Declarante de Ingresos y Patrimonio',   descripcion: 'Entidades no contribuyentes del impuesto sobre la renta.',                             aplica_persona_natural: false, aplica_persona_juridica: true,  orden: 4 },
  { codigo: 'O-47', nombre: 'Régimen Simple de Tributación (SIMPLE)', descripcion: 'Contribuyentes que optaron por el régimen simple.',                                  aplica_persona_natural: true,  aplica_persona_juridica: true,  orden: 5 },
  { codigo: 'R-99-PN', nombre: 'No Responsable de IVA',              descripcion: 'Antes denominado Régimen Simplificado. No cobra ni declara IVA.',                     aplica_persona_natural: true,  aplica_persona_juridica: false, orden: 6 },
];

// Actividades económicas CIIU Rev. 4 Colombia — códigos más usados
// Lista completa (621 códigos): https://www.dane.gov.co/files/nomenclaturas/CIIU_Rev4ac.pdf
const ACTIVIDADES_ECONOMICAS = [
  // Sección A — Agricultura, ganadería, caza, silvicultura y pesca
  { codigo_ciiu: '0111', descripcion: 'Cultivo de cereales (excepto arroz), legumbres y semillas oleaginosas', seccion: 'A', seccion_nombre: 'Agricultura, ganadería, caza, silvicultura y pesca', division: '01', grupo: '011' },
  { codigo_ciiu: '0119', descripcion: 'Otros cultivos agrícolas transitorios n.c.p.', seccion: 'A', seccion_nombre: 'Agricultura, ganadería, caza, silvicultura y pesca', division: '01', grupo: '011' },
  { codigo_ciiu: '0141', descripcion: 'Cría de ganado bovino y bufalino', seccion: 'A', seccion_nombre: 'Agricultura, ganadería, caza, silvicultura y pesca', division: '01', grupo: '014' },
  // Sección C — Industrias manufactureras
  { codigo_ciiu: '1011', descripcion: 'Procesamiento y conservación de carne y productos cárnicos', seccion: 'C', seccion_nombre: 'Industrias manufactureras', division: '10', grupo: '101' },
  { codigo_ciiu: '1081', descripcion: 'Elaboración de productos de panadería', seccion: 'C', seccion_nombre: 'Industrias manufactureras', division: '10', grupo: '108' },
  { codigo_ciiu: '1511', descripcion: 'Curtido y recurtido de cueros; recurtido y teñido de pieles', seccion: 'C', seccion_nombre: 'Industrias manufactureras', division: '15', grupo: '151' },
  { codigo_ciiu: '2410', descripcion: 'Industrias básicas de hierro y de acero', seccion: 'C', seccion_nombre: 'Industrias manufactureras', division: '24', grupo: '241' },
  { codigo_ciiu: '2670', descripcion: 'Fabricación de instrumentos ópticos y equipos fotográficos', seccion: 'C', seccion_nombre: 'Industrias manufactureras', division: '26', grupo: '267' },
  { codigo_ciiu: '3110', descripcion: 'Fabricación de muebles', seccion: 'C', seccion_nombre: 'Industrias manufactureras', division: '31', grupo: '310' },
  // Sección F — Construcción
  { codigo_ciiu: '4111', descripcion: 'Construcción de edificios residenciales', seccion: 'F', seccion_nombre: 'Construcción', division: '41', grupo: '411' },
  { codigo_ciiu: '4112', descripcion: 'Construcción de edificios no residenciales', seccion: 'F', seccion_nombre: 'Construcción', division: '41', grupo: '411' },
  { codigo_ciiu: '4290', descripcion: 'Construcción de otras obras de ingeniería civil', seccion: 'F', seccion_nombre: 'Construcción', division: '42', grupo: '429' },
  { codigo_ciiu: '4321', descripcion: 'Instalaciones eléctricas', seccion: 'F', seccion_nombre: 'Construcción', division: '43', grupo: '432' },
  // Sección G — Comercio al por mayor y al por menor
  { codigo_ciiu: '4511', descripcion: 'Comercio de vehículos automotores nuevos', seccion: 'G', seccion_nombre: 'Comercio al por mayor y al por menor', division: '45', grupo: '451' },
  { codigo_ciiu: '4520', descripcion: 'Mantenimiento y reparación de vehículos automotores', seccion: 'G', seccion_nombre: 'Comercio al por mayor y al por menor', division: '45', grupo: '452' },
  { codigo_ciiu: '4690', descripcion: 'Comercio al por mayor no especializado', seccion: 'G', seccion_nombre: 'Comercio al por mayor y al por menor', division: '46', grupo: '469' },
  { codigo_ciiu: '4711', descripcion: 'Comercio al por menor en establecimientos no especializados con surtido compuesto principalmente por alimentos, bebidas o tabaco', seccion: 'G', seccion_nombre: 'Comercio al por mayor y al por menor', division: '47', grupo: '471' },
  { codigo_ciiu: '4719', descripcion: 'Otros tipos de comercio al por menor en establecimientos no especializados', seccion: 'G', seccion_nombre: 'Comercio al por mayor y al por menor', division: '47', grupo: '471' },
  { codigo_ciiu: '4741', descripcion: 'Comercio al por menor de computadores, equipos periféricos, programas de informática y equipos de telecomunicaciones en establecimientos especializados', seccion: 'G', seccion_nombre: 'Comercio al por mayor y al por menor', division: '47', grupo: '474' },
  { codigo_ciiu: '4789', descripcion: 'Comercio al por menor de otros productos en puestos de venta móviles o en mercados', seccion: 'G', seccion_nombre: 'Comercio al por mayor y al por menor', division: '47', grupo: '478' },
  // Sección H ─────────────────────────────────────────────
  { codigo_ciiu: '4921', descripcion: 'Transporte de pasajeros', seccion: 'H', seccion_nombre: 'Transporte y almacenamiento', division: '49', grupo: '492' },
  { codigo_ciiu: '4922', descripcion: 'Transporte mixto', seccion: 'H', seccion_nombre: 'Transporte y almacenamiento', division: '49', grupo: '492' },
  { codigo_ciiu: '4923', descripcion: 'Transporte de carga por carretera', seccion: 'H', seccion_nombre: 'Transporte y almacenamiento', division: '49', grupo: '492' },
  { codigo_ciiu: '5210', descripcion: 'Almacenamiento y dep\u00f3sito', seccion: 'H', seccion_nombre: 'Transporte y almacenamiento', division: '52', grupo: '521' },
  // Secci\u00f3n I \u2014 Alojamiento y servicios de comida
  { codigo_ciiu: '5511', descripcion: 'Alojamiento en hoteles', seccion: 'I', seccion_nombre: 'Alojamiento y servicios de comida', division: '55', grupo: '551' },
  { codigo_ciiu: '5611', descripcion: 'Expendio a la mesa de comidas preparadas', seccion: 'I', seccion_nombre: 'Alojamiento y servicios de comida', division: '56', grupo: '561' },
  { codigo_ciiu: '5612', descripcion: 'Expendio por autoservicio de comidas preparadas', seccion: 'I', seccion_nombre: 'Alojamiento y servicios de comida', division: '56', grupo: '561' },
  { codigo_ciiu: '5613', descripcion: 'Expendio de comidas preparadas en cafeter\u00edas', seccion: 'I', seccion_nombre: 'Alojamiento y servicios de comida', division: '56', grupo: '561' },
  { codigo_ciiu: '5619', descripcion: 'Otros tipos de expendio de comidas preparadas n.c.p.', seccion: 'I', seccion_nombre: 'Alojamiento y servicios de comida', division: '56', grupo: '561' },
  // Secci\u00f3n J \u2014 Informaci\u00f3n y comunicaciones
  { codigo_ciiu: '5911', descripcion: 'Actividades de producci\u00f3n de pel\u00edculas cinematogr\u00e1ficas, videos, programas, anuncios de televisi\u00f3n y anuncios publicitarios', seccion: 'J', seccion_nombre: 'Informaci\u00f3n y comunicaciones', division: '59', grupo: '591' },
  { codigo_ciiu: '6110', descripcion: 'Actividades de telecomunicaciones al\u00e1mbricas', seccion: 'J', seccion_nombre: 'Informaci\u00f3n y comunicaciones', division: '61', grupo: '611' },
  { codigo_ciiu: '6120', descripcion: 'Actividades de telecomunicaciones inal\u00e1mbricas', seccion: 'J', seccion_nombre: 'Informaci\u00f3n y comunicaciones', division: '61', grupo: '612' },
  { codigo_ciiu: '6190', descripcion: 'Otras actividades de telecomunicaciones', seccion: 'J', seccion_nombre: 'Informaci\u00f3n y comunicaciones', division: '61', grupo: '619' },
  { codigo_ciiu: '6201', descripcion: 'Actividades de desarrollo de sistemas inform\u00e1ticos (planificaci\u00f3n, an\u00e1lisis, dise\u00f1o, programaci\u00f3n, pruebas)', seccion: 'J', seccion_nombre: 'Informaci\u00f3n y comunicaciones', division: '62', grupo: '620' },
  { codigo_ciiu: '6202', descripcion: 'Actividades de consultor\u00eda inform\u00e1tica y actividades de administraci\u00f3n de instalaciones inform\u00e1ticas', seccion: 'J', seccion_nombre: 'Informaci\u00f3n y comunicaciones', division: '62', grupo: '620' },
  { codigo_ciiu: '6209', descripcion: 'Otras actividades de tecnolog\u00eda de la informaci\u00f3n y actividades de servicios inform\u00e1ticos', seccion: 'J', seccion_nombre: 'Informaci\u00f3n y comunicaciones', division: '62', grupo: '620' },
  { codigo_ciiu: '6311', descripcion: 'Procesamiento de datos, alojamiento (hosting) y actividades relacionadas', seccion: 'J', seccion_nombre: 'Informaci\u00f3n y comunicaciones', division: '63', grupo: '631' },
  { codigo_ciiu: '6312', descripcion: 'Portales web', seccion: 'J', seccion_nombre: 'Informaci\u00f3n y comunicaciones', division: '63', grupo: '631' },
  // Secci\u00f3n K \u2014 Actividades financieras y de seguros
  { codigo_ciiu: '6499', descripcion: 'Otras actividades de servicio financiero, excepto las de seguros y pensiones n.c.p.', seccion: 'K', seccion_nombre: 'Actividades financieras y de seguros', division: '64', grupo: '649' },
  { codigo_ciiu: '6612', descripcion: 'Corretaje de valores y de contratos de productos b\u00e1sicos', seccion: 'K', seccion_nombre: 'Actividades financieras y de seguros', division: '66', grupo: '661' },
  // Secci\u00f3n L \u2014 Actividades inmobiliarias
  { codigo_ciiu: '6810', descripcion: 'Actividades inmobiliarias realizadas con bienes propios o arrendados', seccion: 'L', seccion_nombre: 'Actividades inmobiliarias', division: '68', grupo: '681' },
  { codigo_ciiu: '6820', descripcion: 'Actividades inmobiliarias realizadas a cambio de una retribuci\u00f3n o por contrata', seccion: 'L', seccion_nombre: 'Actividades inmobiliarias', division: '68', grupo: '682' },
  // Secci\u00f3n M \u2014 Actividades profesionales, cient\u00edficas y t\u00e9cnicas
  { codigo_ciiu: '6910', descripcion: 'Actividades jur\u00eddicas', seccion: 'M', seccion_nombre: 'Actividades profesionales, cient\u00edficas y t\u00e9cnicas', division: '69', grupo: '691' },
  { codigo_ciiu: '6920', descripcion: 'Actividades de contabilidad, tenedur\u00eda de libros, auditor\u00eda financiera y asesor\u00eda tributaria', seccion: 'M', seccion_nombre: 'Actividades profesionales, cient\u00edficas y t\u00e9cnicas', division: '69', grupo: '692' },
  { codigo_ciiu: '7010', descripcion: 'Actividades de administraci\u00f3n empresarial', seccion: 'M', seccion_nombre: 'Actividades profesionales, cient\u00edficas y t\u00e9cnicas', division: '70', grupo: '701' },
  { codigo_ciiu: '7020', descripcion: 'Actividades de consultores de gesti\u00f3n empresarial', seccion: 'M', seccion_nombre: 'Actividades profesionales, cient\u00edficas y t\u00e9cnicas', division: '70', grupo: '702' },
  { codigo_ciiu: '7110', descripcion: 'Actividades de arquitectura e ingenier\u00eda y otras actividades conexas de consultor\u00eda t\u00e9cnica', seccion: 'M', seccion_nombre: 'Actividades profesionales, cient\u00edficas y t\u00e9cnicas', division: '71', grupo: '711' },
  { codigo_ciiu: '7310', descripcion: 'Publicidad', seccion: 'M', seccion_nombre: 'Actividades profesionales, cient\u00edficas y t\u00e9cnicas', division: '73', grupo: '731' },
  { codigo_ciiu: '7490', descripcion: 'Otras actividades profesionales, cient\u00edficas y t\u00e9cnicas n.c.p.', seccion: 'M', seccion_nombre: 'Actividades profesionales, cient\u00edficas y t\u00e9cnicas', division: '74', grupo: '749' },
  // Secci\u00f3n N \u2014 Actividades de servicios administrativos y de apoyo
  { codigo_ciiu: '7810', descripcion: 'Actividades de las agencias de empleo', seccion: 'N', seccion_nombre: 'Actividades de servicios administrativos y de apoyo', division: '78', grupo: '781' },
  { codigo_ciiu: '8010', descripcion: 'Actividades de seguridad privada', seccion: 'N', seccion_nombre: 'Actividades de servicios administrativos y de apoyo', division: '80', grupo: '801' },
  { codigo_ciiu: '8110', descripcion: 'Actividades combinadas de apoyo a instalaciones', seccion: 'N', seccion_nombre: 'Actividades de servicios administrativos y de apoyo', division: '81', grupo: '811' },
  { codigo_ciiu: '8121', descripcion: 'Limpieza general interior de edificios', seccion: 'N', seccion_nombre: 'Actividades de servicios administrativos y de apoyo', division: '81', grupo: '812' },
  { codigo_ciiu: '8299', descripcion: 'Otras actividades de servicios de apoyo a las empresas n.c.p.', seccion: 'N', seccion_nombre: 'Actividades de servicios administrativos y de apoyo', division: '82', grupo: '829' },
  // Secci\u00f3n P \u2014 Educaci\u00f3n
  { codigo_ciiu: '8511', descripcion: 'Educaci\u00f3n de la primera infancia', seccion: 'P', seccion_nombre: 'Educaci\u00f3n', division: '85', grupo: '851' },
  { codigo_ciiu: '8513', descripcion: 'Educaci\u00f3n b\u00e1sica secundaria', seccion: 'P', seccion_nombre: 'Educaci\u00f3n', division: '85', grupo: '851' },
  { codigo_ciiu: '8521', descripcion: 'Educaci\u00f3n superior universitaria', seccion: 'P', seccion_nombre: 'Educaci\u00f3n', division: '85', grupo: '852' },
  { codigo_ciiu: '8560', descripcion: 'Actividades de apoyo a la ense\u00f1anza', seccion: 'P', seccion_nombre: 'Educaci\u00f3n', division: '85', grupo: '856' },
  // Secci\u00f3n Q \u2014 Actividades de atenci\u00f3n de la salud humana y de asistencia social
  { codigo_ciiu: '8610', descripcion: 'Actividades de hospitales y cl\u00ednicas con internaci\u00f3n', seccion: 'Q', seccion_nombre: 'Actividades de atenci\u00f3n de la salud humana y de asistencia social', division: '86', grupo: '861' },
  { codigo_ciiu: '8621', descripcion: 'Actividades de la pr\u00e1ctica m\u00e9dica, sin internaci\u00f3n', seccion: 'Q', seccion_nombre: 'Actividades de atenci\u00f3n de la salud humana y de asistencia social', division: '86', grupo: '862' },
  { codigo_ciiu: '8622', descripcion: 'Actividades de la pr\u00e1ctica odontol\u00f3gica', seccion: 'Q', seccion_nombre: 'Actividades de atenci\u00f3n de la salud humana y de asistencia social', division: '86', grupo: '862' },
  { codigo_ciiu: '8691', descripcion: 'Actividades de apoyo diagn\u00f3stico', seccion: 'Q', seccion_nombre: 'Actividades de atenci\u00f3n de la salud humana y de asistencia social', division: '86', grupo: '869' },
  { codigo_ciiu: '8692', descripcion: 'Actividades de apoyo terap\u00e9utico', seccion: 'Q', seccion_nombre: 'Actividades de atenci\u00f3n de la salud humana y de asistencia social', division: '86', grupo: '869' },
  { codigo_ciiu: '8699', descripcion: 'Otras actividades de atenci\u00f3n de la salud humana', seccion: 'Q', seccion_nombre: 'Actividades de atenci\u00f3n de la salud humana y de asistencia social', division: '86', grupo: '869' },
  // Secci\u00f3n S \u2014 Otras actividades de servicios
  { codigo_ciiu: '9511', descripcion: 'Mantenimiento y reparaci\u00f3n de computadores y de equipo perif\u00e9rico', seccion: 'S', seccion_nombre: 'Otras actividades de servicios', division: '95', grupo: '951' },
  { codigo_ciiu: '9512', descripcion: 'Mantenimiento y reparaci\u00f3n de equipos de comunicaci\u00f3n', seccion: 'S', seccion_nombre: 'Otras actividades de servicios', division: '95', grupo: '951' },
  { codigo_ciiu: '9601', descripcion: 'Lavado y limpieza, incluso la limpieza en seco, de productos textiles y de piel', seccion: 'S', seccion_nombre: 'Otras actividades de servicios', division: '96', grupo: '960' },
  { codigo_ciiu: '9609', descripcion: 'Otras actividades de servicios personales n.c.p.', seccion: 'S', seccion_nombre: 'Otras actividades de servicios', division: '96', grupo: '960' },
];

export async function seedCatalogo(ds: DataSource): Promise<void> {
  const tipoDocRepo       = ds.getRepository(TipoDocumentoIdentidad);
  const paisRepo          = ds.getRepository(Pais);
  const deptoRepo         = ds.getRepository(Departamento);
  const municRepo         = ds.getRepository(Municipio);
  const respFiscalRepo    = ds.getRepository(TipoResponsabilidadFiscal);
  const actEconRepo       = ds.getRepository(ActividadEconomica);
  const empresaModuloRepo = ds.getRepository(EmpresaModulo);
  const companyRepo       = ds.getRepository(Company);
  const moduloRepo        = ds.getRepository(Modulo);

  let total = 0;

  for (const td of TIPOS_DOCUMENTO) {
    const exists = await tipoDocRepo.findOne({ where: { codigo: td.codigo } });
    if (!exists) { await tipoDocRepo.save(tipoDocRepo.create(td)); total++; }
  }

  for (const p of PAISES) {
    const exists = await paisRepo.findOne({ where: { codigo_iso2: p.codigo_iso2 } });
    if (!exists) { await paisRepo.save(paisRepo.create(p)); total++; }
  }

  const colombia = await paisRepo.findOne({ where: { codigo_iso2: 'CO' } });
  for (const d of DEPARTAMENTOS) {
    const exists = await deptoRepo.findOne({ where: { codigo_dane: d.codigo_dane } });
    if (!exists) { await deptoRepo.save(deptoRepo.create({ ...d, pais_id: colombia?.id })); total++; }
  }

  const municipiosUnicos = MUNICIPIOS.filter(
    (m, idx, arr) => arr.findIndex(x => x.codigo_dane === m.codigo_dane) === idx
  );
  for (const m of municipiosUnicos) {
    const exists = await municRepo.findOne({ where: { codigo_dane: m.codigo_dane } });
    if (!exists) {
      const depto = await deptoRepo.findOne({ where: { codigo_dane: m.dept_codigo } });
      await municRepo.save(municRepo.create({ codigo_dane: m.codigo_dane, nombre: m.nombre, es_capital: m.es_capital, departamento_id: depto?.id }));
      total++;
    }
  }

  for (const rf of RESPONSABILIDADES_FISCALES) {
    const exists = await respFiscalRepo.findOne({ where: { codigo: rf.codigo } });
    if (!exists) { await respFiscalRepo.save(respFiscalRepo.create(rf)); total++; }
  }

  for (const ae of ACTIVIDADES_ECONOMICAS) {
    const exists = await actEconRepo.findOne({ where: { codigo_ciiu: ae.codigo_ciiu } });
    if (!exists) { await actEconRepo.save(actEconRepo.create(ae)); total++; }
  }

  if (total > 0) console.log(`[Seed] ${total} registros de cat\u00e1logo insertados`);

  // Nota de rendimiento: se evita un findOne() por cada par (empresa, modulo)
  // -- contra una base remota eso es un viaje de red por par. En su lugar se
  // trae lo existente en una sola consulta y se compara en memoria.
  const empresas       = await companyRepo.find();
  const todosModulos   = await moduloRepo.find({ where: { activo: true } });
  const existentes     = await empresaModuloRepo.find({ select: ['company_id', 'modulo_id'] });
  const clavesExistentes = new Set(existentes.map(e => `${e.company_id}::${e.modulo_id}`));

  const nuevasAsignaciones: EmpresaModulo[] = [];
  for (const empresa of empresas) {
    for (const modulo of todosModulos) {
      const key = `${empresa.id}::${modulo.id}`;
      if (clavesExistentes.has(key)) continue;
      nuevasAsignaciones.push(empresaModuloRepo.create({ company_id: empresa.id, modulo_id: modulo.id, activo: true, asignado_por: 'seed' }));
      clavesExistentes.add(key);
    }
  }
  if (nuevasAsignaciones.length > 0) {
    await empresaModuloRepo.save(nuevasAsignaciones);
    console.log(`[Seed] ${nuevasAsignaciones.length} m\u00f3dulos asignados a empresas existentes`);
  }
}
