/**
 * Factura electronica de salud (modalidad PGP o Evento).
 * Cumple con la resolucion DIAN para facturas del sector salud con RIPS adjunto.
 * Tabla: salud_facturas
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn,
} from 'typeorm';
import { Company } from '../Company';
import { Eps } from './Eps';
import { ContratoSalud } from './ContratoSalud';
import { Sede } from '../contabilidad/Sede';
import { CentroCosto } from '../contabilidad/CentroCosto';

// Union types exportados (usados tambien en ContratoSalud y notas)

/** Estado del ciclo de vida de la factura salud ante la DIAN */
export type FacturaSaludStatus =
  | 'borrador'
  | 'pendiente_cierre'
  | 'enviando'
  | 'aprobada'
  | 'rechazada'
  | 'anulada';

/** Estado de pago de la factura por la EPS */
export type FacturaSaludPaymentStatus = 'pendiente' | 'parcial' | 'pagada' | 'glosada';

/** Modalidad de facturacion salud */
export type FacturaSaludTipo = 'pgp' | 'evento';

/**
 * Tipo de operacion SS para el XML DIAN.
 * Identifica el tipo de documento de soporte en salud.
 */
export type TipoOperacionSS =
  | 'SS-CUFE'
  | 'SS-Recaudo'
  | 'SS-POS'
  | 'SS-SNUM'
  | 'SS-Reporte'
  | 'SS-SinAporte';

/** Regimen de afiliacion del paciente */
export type RegimenSalud = 'subsidiado' | 'contributivo' | 'especial' | 'excepcion';

/** Modalidad de pago del contrato */
export type ModalidadPagoSalud = 'PGP' | 'Evento' | 'Paquete' | 'Global_Prospectivo';

@Entity('salud_facturas')
export class FacturaSalud {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { nullable: false, onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column({ length: 10, default: 'evento' })
  tipo!: FacturaSaludTipo;

  // Encabezado salud

  @Column({ nullable: true })
  eps_id?: string;

  @ManyToOne(() => Eps, { eager: true, nullable: true })
  @JoinColumn({ name: 'eps_id' })
  eps?: Eps;

  @Column({ nullable: true })
  contrato_id?: string;

  @ManyToOne(() => ContratoSalud, { eager: true, nullable: true })
  @JoinColumn({ name: 'contrato_id' })
  contrato?: ContratoSalud;

  /** Natural key -> cat_tipos_cobertura_salud.codigo */
  @Column({ length: 30, nullable: true })
  tipo_cobertura?: string;

  @Column({ length: 20, default: 'SS-CUFE' })
  tipo_operacion_ss!: TipoOperacionSS;

  @Column({ length: 30, nullable: true })
  regimen?: RegimenSalud;

  @Column({ length: 30, nullable: true })
  modalidad_pago?: ModalidadPagoSalud;

  /** Periodo facturado inicio */
  @Column({ type: 'date', nullable: true })
  periodo_inicio?: string;

  /** Periodo facturado fin */
  @Column({ type: 'date', nullable: true })
  periodo_fin?: string;

  /** Solo PGP: numero de afiliados del periodo */
  @Column({ nullable: true })
  num_afiliados?: number;

  /** Solo PGP: valor UPC pactado */
  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  valor_upc?: number;

  // Numeracion DIAN

  @Column({ length: 20, nullable: true })
  prefix?: string;

  @Column({ nullable: true })
  number?: number;

  /** Numero completo de la factura (prefix + number). Unico por empresa. */
  @Column({ length: 50, nullable: true })
  invoice_number?: string;

  @Column({ type: 'date' })
  issue_date!: string;

  // Totales
  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  subtotal!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  tax_total!: number;

  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  total!: number;

  @Column({ length: 10, default: 'COP' })
  currency!: string;

  // Cartera / pago EPS

  /** Fecha limite de pago por parte de la EPS */
  @Column({ type: 'date', nullable: true })
  payment_due_date?: string;

  /** Estado de pago de la factura por la EPS */
  @Column({ length: 15, default: 'pendiente' })
  payment_status!: FacturaSaludPaymentStatus;

  /** Monto ya recibido de la EPS (pagos parciales) */
  @Column({ type: 'decimal', precision: 18, scale: 2, default: 0 })
  total_paid!: number;

  // Estado DIAN

  @Column({ length: 20, default: 'borrador' })
  status!: FacturaSaludStatus;

  @Column({ type: 'text', nullable: true })
  cufe?: string;

  @Column({ length: 10, nullable: true })
  dian_status_code?: string;

  @Column({ type: 'text', nullable: true })
  dian_status_description?: string;

  @Column({ type: 'text', nullable: true })
  dian_response_raw?: string;

  // RIPS

  /**
   * JSON array de pacientes con sus servicios (tipo=evento).
   * Estructura: RipsUsuario[] — se genera automaticamente desde las lineas
   * o se importa desde Excel para PGP.
   */
  @Column({ type: 'text', nullable: true })
  pacientes_json?: string;

  /**
   * @deprecated Se deja solo por compatibilidad con facturas ya migradas
   * antes de este cambio. Las nuevas facturas guardan el RIPS en disco
   * (ver rips_json_path) en vez de en esta columna — un RIPS con muchos
   * pacientes puede pesar varios MB en JSON y no tiene sentido cargar eso
   * en la base de datos ni arriesgar límites de tamaño de fila/paquete.
   */
  @Column({ type: 'text', nullable: true })
  rips_json?: string;

  /** Ruta en disco del archivo con el RIPS JSON (ver services/rips-storage.service.ts). */
  @Column({ length: 500, nullable: true })
  rips_json_path?: string;

  @Column({ length: 200, nullable: true })
  rips_filename?: string;

  // Archivos

  @Column({ type: 'text', nullable: true })
  xml_base64?: string;

  @Column({ type: 'text', nullable: true })
  signed_xml_base64?: string;

  @Column({ type: 'text', nullable: true })
  pdf_base64?: string;

  // Observaciones

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Column({ type: 'text', nullable: true })
  motivo_anulacion?: string;

  // ── Pago por usuario (factura secundaria al paciente) ─────────────────────

  /** Valor del pago por usuario (cuota moderadora o copago) pagado por el paciente.
   *  Cuando es > 0, se genera una factura DIAN adicional dirigida al paciente. */
  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  pago_usuario_monto?: number;

  /** Número de factura DIAN emitida al paciente por el pago por usuario (ej. SETP990000042). */
  @Column({ length: 50, nullable: true })
  pago_usuario_invoice_number?: string;

  /** CUFE de la factura de pago por usuario. */
  @Column({ type: 'text', nullable: true })
  pago_usuario_cufe?: string;

  /** PDF en base64 de la factura de pago por usuario (dirigida al paciente). */
  @Column({ type: 'text', nullable: true })
  pago_usuario_pdf_base64?: string;

  /** Código de respuesta DIAN para la factura de pago por usuario ('00' = aprobada, otro = rechazada). */
  @Column({ length: 10, nullable: true })
  pago_usuario_dian_status?: string;

  /** Descripción de respuesta DIAN para la factura de pago por usuario. */
  @Column({ type: 'text', nullable: true })
  pago_usuario_dian_description?: string;

  /** Lista de errores/notificaciones DIAN del pago por usuario (JSON array de strings). */
  @Column({ type: 'text', nullable: true })
  pago_usuario_dian_errors?: string;

  /** Respuesta DIAN completa del pago por usuario (JSON serializado — mismo patrón que dian_response_raw). */
  @Column({ type: 'text', nullable: true })
  pago_usuario_dian_response_raw?: string;

  /** Tipo de cobro al usuario: 'cuota_moderadora' (monto fijo) o 'copago' (porcentaje del total). */
  @Column({ length: 20, nullable: true })
  tipo_cobro_usuario?: 'cuota_moderadora' | 'copago';

  /** Porcentaje aplicado cuando tipo_cobro_usuario = 'copago'. */
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  pago_usuario_porcentaje?: number;


  /** Causal para facturas sin CUCON (Res. 948/2026).
   *  Valores válidos: URGENCIAS | ADRES | SOAT | TUTELA | PORTABILIDAD | OTRO.
   *  Usar solo cuando el contrato no tiene CUCON registrado en SIIFA. */
  @Column({ length: 30, nullable: true })
  factura_sin_contrato?: string;

  /** Cargue masivo: ID del lote que originó esta factura */
  @Column({ nullable: true })
  lote_id?: string;

  /** Usuario asignado para revisar y cerrar esta factura (viene del cargue masivo) */
  @Column({ nullable: true })
  asignado_a_user_id?: string;

  @Column({ length: 120, nullable: true })
  asignado_a_user_name?: string;

  /** Referencia externa del cargue (clave de negocio del usuario) */
  @Column({ length: 100, nullable: true })
  referencia_externa?: string;

  /** Usuario que creó el registro. Desnormalizado: sobrevive borrado/renombrado de usuario. */
  @Column({ nullable: true })
  created_by_user_id?: string;

  @Column({ length: 120, nullable: true })
  created_by_name?: string;

  /**
   * Módulo desde el que se creó la factura:
   *  'evento'   → Facturas de Evento (equipo contable, flujo RIPS completo).
   *  'clientes' → Facturas Clientes (personal sin contexto contable, mismo motor DIAN/RIPS).
   * Default 'evento' para no alterar el comportamiento de los registros existentes.
   */
  @Column({ length: 20, default: 'evento' })
  origen_modulo!: 'evento' | 'clientes';

  // ── Forma de pago / tirilla POS (módulo Facturas Clientes) ────────────────

  /** Medio de pago DIAN (catálogo payment_method_id: 10 Efectivo, 42 Transferencia, etc.). */
  @Column({ length: 10, nullable: true })
  payment_method_id?: string;

  /**
   * Sede asignada a la factura (antes solo se usaba como "punto de pago" en el
   * flujo Facturas Clientes/POS): desde esta version se usa como la sede de
   * TODA factura de salud — evento, PGP y clientes — obligatoria en los tres
   * flujos. Debe ser una de las sedes permitidas por `contrato.sedes`.
   */
  @Column({ nullable: true })
  punto_pago_sede_id?: string;

  @ManyToOne(() => Sede, { nullable: true, eager: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'punto_pago_sede_id' })
  punto_pago_sede?: Sede;

  /**
   * Centro de costo asignado a la factura, obligatorio en los tres flujos
   * (evento, PGP, clientes). Debe ser uno de los permitidos por `contrato.centros_costo`.
   */
  @Column({ nullable: true })
  centro_costo_id?: string;

  @ManyToOne(() => CentroCosto, { nullable: true, eager: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'centro_costo_id' })
  centro_costo?: CentroCosto;

  /** Valor efectivamente recibido del paciente (para calcular el cambio en la tirilla). */
  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  valor_recibido?: number;

  /** Cambio devuelto al paciente (valor_recibido - total). */
  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  valor_cambio?: number;

  /** PDF en base64 de la tirilla POS (cacheado, mismo patrón que pdf_base64). */
  @Column({ type: 'text', nullable: true })
  tirilla_pdf_base64?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
