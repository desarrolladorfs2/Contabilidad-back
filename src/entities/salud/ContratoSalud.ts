/**
 * Contrato entre la IPS y una EPS/ADRES/ARL.
 * Define modalidad de pago, cobertura, periodo y servicios pactados.
 * Tabla: salud_contratos
 */
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
  ManyToOne, ManyToMany, JoinColumn, JoinTable, Unique,
} from 'typeorm';
import { Company } from '../Company';
import { Eps } from './Eps';
import { TipoOperacionSS, ModalidadPagoSalud } from './FacturaSalud';
import { CentroCosto } from '../contabilidad/CentroCosto';
import { Sede } from '../contabilidad/Sede';

/** Estado del contrato salud */
export type ContratoSaludEstado = 'activo' | 'vencido' | 'suspendido' | 'terminado';

@Entity('salud_contratos')
@Unique(['company_id', 'numero'])
export class ContratoSalud {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  company_id!: string;

  @ManyToOne(() => Company, { nullable: false, onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column()
  eps_id!: string;

  @ManyToOne(() => Eps, { eager: true, nullable: false })
  @JoinColumn({ name: 'eps_id' })
  eps!: Eps;

  /** Numero de contrato (unico por empresa) */
  @Column({ length: 50 })
  numero!: string;

  /** Natural key -> cat_tipos_cobertura_salud.codigo */
  @Column({ length: 30, nullable: true })
  tipo_cobertura?: string;

  /**
   * Tipo de operacion SS para el XML DIAN.
   * Natural key -> valores SS-CUFE, SS-Recaudo, etc.
   */
  @Column({ length: 20, default: 'SS-CUFE' })
  tipo_operacion_ss!: TipoOperacionSS;

  @Column({ length: 30, default: 'Evento' })
  modalidad_pago!: ModalidadPagoSalud;

  /**
   * Forma de pago DIAN (tabla "Forma de Pago" 6.3.4.1: "1"=Contado, "2"=Crédito)
   * para la FACTURA A LA EPS de este contrato. Va en cac:PaymentMeans/cbc:ID del
   * XML — es un campo independiente de modalidad_pago (que solo alimenta el tag
   * de salud CustomTagGeneral/MODALIDAD_PAGO). La DIAN valida este campo con la
   * regla FAN02 y solo acepta "1" o "2" (ver builder.py). Por defecto "2"
   * (Crédito), ya que normalmente la EPS no paga de contado.
   */
  @Column({ length: 1, default: '2' })
  forma_pago_eps!: string;

  /**
   * Forma de pago DIAN (misma tabla 6.3.4.1: "1"=Contado, "2"=Crédito) para la
   * FACTURA DE PAGO POR USUARIO (cuota moderadora / copago) que se emite al
   * PACIENTE bajo este contrato. Solo aplica/se muestra en el formulario cuando
   * tiene_pago_usuario es true. Por defecto "1" (Contado), ya que el paciente
   * suele pagar en el momento de la atención.
   */
  @Column({ length: 1, default: '1' })
  forma_pago_usuario!: string;

  /** Codigo REPS del prestador para este contrato (puede diferir por sede) */
  @Column({ length: 20, nullable: true })
  cod_prestador?: string;

  /**
   * SAL-056: sufijo de sede/consultorio (2 dígitos) que exige el REPS para el
   * código de habilitación DENTRO DEL RIPS. El campo C07 "codPrestador" del
   * RIPS debe tener 12 caracteres = cod_prestador (10 dígitos, el NIT+DV del
   * prestador) + este sufijo de sede (ej. "01"). El XML DIAN (el campo
   * cod_prestador que va en BuyersItemIdentification/CustomTag) NO lleva este
   * sufijo — usa cod_prestador tal cual, solo el RIPS lo necesita completo.
   * Antes había que guardar el cod_prestador YA con el sufijo pegado, lo cual
   * dañaba el XML (que no debía llevarlo). Con este campo separado, cada uno
   * sale correcto sin tocar el otro.
   */
  @Column({ length: 2, nullable: true })
  sede_reps?: string;

  @Column({ type: 'date' })
  fecha_inicio!: string;

  @Column({ type: 'date' })
  fecha_fin!: string;

  /** Valor fijo PGP por periodo (solo modalidad PGP / Global_Prospectivo) */
  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  valor_contrato?: number;

  /** Valor correspondiente al regimen subsidiado (contratos mixtos) */
  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  valor_subsidiado?: number;

  /** Valor correspondiente al regimen contributivo (contratos mixtos) */
  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  valor_contributivo?: number;

  /** Tasa IVA pactada (%). Por defecto 0 — salud generalmente exenta. */
  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  tasa_iva!: number;

  /** Si el contrato exige pago por usuario (cuota moderadora o copago) al paciente.
   *  Cuando es true, las facturas de evento bajo este contrato generarán
   *  una factura DIAN adicional dirigida al paciente. */
  @Column({ type: 'boolean', default: false })
  tiene_pago_usuario!: boolean;

  /** Valor fijo de pago por usuario por paciente (si el contrato lo define).
   *  Opcional — el operador puede ajustarlo al crear la factura. */
  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  valor_pago_usuario_fijo?: number;

  /**
   * Cuenta PUC a la que se debe contabilizar el COPAGO cobrado al paciente
   * bajo este contrato (solicitud de contabilidad). Opcional — si se deja
   * vacía, el asiento contable de la factura de salud sigue generándose
   * igual que hoy (sin separar el pago por usuario en una cuenta distinta).
   */
  @Column({ length: 20, nullable: true })
  cuenta_copago?: string;

  /**
   * Cuenta PUC a la que se debe contabilizar la CUOTA MODERADORA cobrada
   * al paciente bajo este contrato. Misma lógica opcional que cuenta_copago.
   */
  @Column({ length: 20, nullable: true })
  cuenta_cuota_moderadora?: string;

  /**
   * SAL-058: Cuenta PUC del INGRESO principal de este contrato — el valor
   * que se le cobra a la EPS (contratos Evento: el ingreso de cada factura,
   * sin contar copago/cuota moderadora; contratos PGP/Paquete/Global
   * Prospectivo: el valor único del período completo). Aplica a TODOS los
   * contratos, tengan o no pago por usuario. Opcional — si se deja vacía, el
   * asiento sigue usando la cuenta configurada a nivel de empresa (Ajustes
   * Contables → evento "venta_salud") o, en su defecto, el código estándar
   * 4110 (comportamiento igual al de antes de que existiera este campo).
   */
  @Column({ length: 20, nullable: true })
  cuenta_ingreso_servicio?: string;

  @Column({ length: 20, default: 'activo' })
  estado!: ContratoSaludEstado;

  /** CUCON — Código Único de Contrato asignado por SIIFA (Res. 948/2026).
   *  64 caracteres alfanuméricos. Va en el root del RIPS JSON.
   *  Mutuamente excluyente con factura_sin_contrato en la factura. */
  @Column({ length: 64, nullable: true })
  cucon?: string;

  // Ubicacion del contrato — snapshot DIVIPOLA
  @Column({ length: 10, nullable: true })
  ciudad_codigo?: string;

  @Column({ length: 150, nullable: true })
  ciudad_nombre?: string;

  @Column({ length: 500, nullable: true })
  descripcion?: string;

  @Column({ length: 500, nullable: true })
  observaciones?: string;

  /**
   * Centros de costo y sedes en los que puede operar este contrato (M2M).
   * Un contrato de salud puede cubrir varias ciudades/sedes a la vez; al crear
   * una factura de evento/PGP bajo este contrato, o al asignar registros de
   * cargue masivo, se debe elegir UN centro de costo y UNA sede de entre estos permitidos.
   * La ciudad no se guarda aparte: se deriva de `sede.municipio`.
   */
  @ManyToMany(() => CentroCosto)
  @JoinTable({
    name: 'contrato_salud_centros_costo',
    joinColumn:        { name: 'contrato_id',      referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'centro_costo_id',  referencedColumnName: 'id' },
  })
  centros_costo?: CentroCosto[];

  @ManyToMany(() => Sede)
  @JoinTable({
    name: 'contrato_salud_sedes',
    joinColumn:        { name: 'contrato_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'sede_id',      referencedColumnName: 'id' },
  })
  sedes?: Sede[];

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
