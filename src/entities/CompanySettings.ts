import {
  Entity, PrimaryGeneratedColumn, Column, OneToOne,
  JoinColumn, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';
import { Company } from './Company';

/** @deprecated Usar el sistema de módulos relacional (empresa_modulo + modulos) */
export type ModuleKey =
  | 'invoices'
  | 'credit_notes'
  | 'debit_notes'
  | 'received'
  | 'health'
  | 'payroll';

@Entity('company_settings')
export class CompanySettings {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @OneToOne(() => Company, (c) => c.settings)
  @JoinColumn({ name: 'company_id' })
  company!: Company;

  @Column()
  company_id!: string;

  // Credenciales DIAN — Facturacion electronica
  @Column({ length: 100, nullable: true })
  software_id?: string;

  @Column({ length: 20, nullable: true })
  software_pin?: string;

  @Column({ length: 200, nullable: true })
  technical_key_test?: string;

  @Column({ length: 200, nullable: true })
  technical_key_prod?: string;

  @Column({ default: '2' })
  environment!: string;

  // Resolucion de facturacion
  @Column({ length: 50, nullable: true })
  resolution_number?: string;

  @Column({ length: 10, nullable: true })
  resolution_prefix?: string;

  @Column({ nullable: true })
  resolution_from?: number;

  @Column({ nullable: true })
  resolution_to?: number;

  @Column({ type: 'date', nullable: true })
  resolution_date?: string;

  /** Fecha de inicio de vigencia de la resolución (normalmente igual a resolution_date) */
  @Column({ type: 'date', nullable: true })
  resolution_start_date?: string;

  /** Fecha de fin de vigencia de la resolución según la DIAN */
  @Column({ type: 'date', nullable: true })
  resolution_end_date?: string;

  // Certificado digital (.pfx)
  @Column({ type: 'text', nullable: true })
  cert_data?: string;

  @Column({ type: 'text', nullable: true })
  cert_password_encrypted?: string;

  @Column({ type: 'date', nullable: true })
  cert_expires_at?: string;

  @Column({ length: 500, nullable: true })
  cert_filename?: string;

  @Column({ type: 'text', nullable: true })
  cert_path?: string;

  /**
   * Hallazgo #57 (mitad): antes el .pfx quedaba en disco sin cifrar (solo la
   * contraseña estaba cifrada). Certificados guardados a partir de este
   * cambio se cifran con AES-256-CBC usando CERT_ENCRYPTION_KEY antes de
   * escribirse a disco — este flag distingue esos archivos nuevos (true) de
   * certificados ya existentes guardados en texto plano antes del cambio
   * (false/null), para no romper la lectura de certificados subidos antes.
   */
  @Column({ default: false })
  cert_encrypted_at_rest!: boolean;

  // Logos y branding
  @Column({ type: 'text', nullable: true })
  logo_pdf_path?: string;

  @Column({ type: 'text', nullable: true })
  logo_app_path?: string;

  @Column({ type: 'text', nullable: true })
  logo_watermark_path?: string;

  /** @deprecated Usar logo_pdf_path o logo_app_path segun el contexto. */
  @Column({ length: 500, nullable: true })
  logo_path?: string;

  // Colores PDF
  @Column({ length: 20, nullable: true, default: '#1a56db' })
  pdf_primary_color?: string;

  @Column({ length: 20, nullable: true, default: '#374151' })
  pdf_secondary_color?: string;

  @Column({ length: 20, nullable: true, default: '#FFFFFF' })
  pdf_color_header_text?: string;

  @Column({ length: 20, nullable: true, default: '#93C5FD' })
  pdf_color_accent?: string;

  // Modulos activos (sistema legado)
  @Column({ type: 'simple-json', default: '["invoices","credit_notes","debit_notes","received"]' })
  enabled_modules!: ModuleKey[];

  // Numeracion — Facturacion electronica
  @Column({ default: 1 })
  next_invoice_number!: number;

  @Column({ length: 10, default: 'SETP' })
  invoice_prefix!: string;

  @Column({ default: 1 })
  next_credit_note_number!: number;

  @Column({ length: 10, default: 'NC' })
  credit_note_prefix!: string;

  @Column({ default: 1 })
  next_debit_note_number!: number;

  @Column({ length: 10, default: 'ND' })
  debit_note_prefix!: string;

  // Numeracion — Sector salud
  @Column({ default: 1 })
  next_health_invoice_number!: number;

  @Column({ length: 10, default: 'FVS' })
  health_prefix!: string;

  @Column({ length: 30, nullable: true })
  health_resolution_number?: string;

  @Column({ nullable: true })
  health_resolution_from?: number;

  @Column({ nullable: true })
  health_resolution_to?: number;

  @Column({ type: 'date', nullable: true })
  health_resolution_date?: string;

  @Column({ type: 'date', nullable: true })
  health_resolution_start_date?: string;

  @Column({ type: 'date', nullable: true })
  health_resolution_end_date?: string;

  @Column({ default: 1 })
  next_health_credit_note_number!: number;

  @Column({ length: 10, default: 'NCSS' })
  health_credit_note_prefix!: string;

  @Column({ default: 1 })
  next_health_debit_note_number!: number;

  @Column({ length: 10, default: 'NDSS' })
  health_debit_note_prefix!: string;

  // Numeracion — Nomina electronica
  @Column({ default: 1 })
  next_payroll_document_number!: number;

  @Column({ length: 20, nullable: true })
  nomina_prefix?: string;

  // Credenciales DIAN — Nomina electronica
  @Column({ length: 100, nullable: true })
  software_id_nomina?: string;

  @Column({ length: 20, nullable: true })
  software_pin_nomina?: string;

  @Column({ length: 100, nullable: true })
  test_set_id_nomina?: string;

  @Column({ length: 200, nullable: true })
  software_security_code_nomina?: string;

  /** @deprecated Usar Company.nit_dv. */
  @Column({ length: 2, nullable: true })
  nit_dv?: string;

  // Numeracion — Documento Soporte (DS) · Res. 0167/2021
  @Column({ default: 1 })
  next_ds_number!: number;

  @Column({ length: 10, default: 'DS' })
  ds_prefix!: string;

  @Column({ default: 1 })
  next_nota_ajuste_ds_number!: number;

  @Column({ length: 10, default: 'NADS' })
  nota_ajuste_ds_prefix!: string;

  /**
   * Resolución / rango de numeración autorizado por la DIAN para Documento Soporte.
   * La DIAN exige un rango de numeración autorizado también para DS (se solicita
   * en el portal DIAN igual que la resolución de facturación) — sts:InvoiceControl
   * es un elemento obligatorio del esquema XML del DS. Sin estos datos, la DIAN
   * rechaza el documento con "ZB01, Fallo en el esquema XML del archivo".
   */
  @Column({ length: 30, nullable: true })
  ds_resolution_number?: string;

  @Column({ type: 'date', nullable: true })
  ds_resolution_date?: string;

  @Column({ length: 10, nullable: true })
  ds_resolution_prefix?: string;

  @Column({ nullable: true })
  ds_resolution_from?: number;

  @Column({ nullable: true })
  ds_resolution_to?: number;

  /** Fecha de inicio de vigencia de la autorización de numeración DS */
  @Column({ type: 'date', nullable: true })
  ds_resolution_start_date?: string;

  /** Fecha de fin de vigencia de la autorización de numeración DS */
  @Column({ type: 'date', nullable: true })
  ds_resolution_end_date?: string;

  // RADIAN — Eventos (Res. 000085/2022, Anexo Técnico v1.1)
  /**
   * Numeración consecutiva de "Número del evento" (cbc:ID) para eventos RADIAN
   * (030 Acuse, 031 Reclamo, 032 Recibo del bien, 033 Aceptación expresa, 034
   * Aceptación tácita). La DIAN exige que este número no se repita para un mismo
   * tipo de evento; un único contador global compartido entre todos los tipos
   * satisface esa condición trivialmente (unicidad global implica unicidad por tipo).
   */
  @Column({ default: 1 })
  next_radian_evento_number!: number;

  /**
   * Credenciales de habilitación RADIAN, si la DIAN asigna Id_Software/PIN
   * distintos a los de facturación electrónica normal (software_id/software_pin).
   * Si no están definidos, se usan por defecto software_id/software_pin.
   */
  @Column({ length: 100, nullable: true })
  software_id_radian?: string;

  @Column({ length: 20, nullable: true })
  software_pin_radian?: string;

  /**
   * Hallazgo #33: prefijos de códigos PUC que representan cuentas de efectivo
   * (caja/bancos) para el cálculo del Flujo de Efectivo, separados por coma
   * (ej. "1105,1110,1115"). Si la empresa personalizó su PUC con códigos de
   * efectivo distintos a los del PUC estándar, se configuran aquí — si queda
   * vacío/null, el reporte usa el set de códigos estándar por defecto.
   */
  @Column({ type: 'text', nullable: true })
  flujo_efectivo_cuentas_caja?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  /** @deprecated Usar EmpresaModulo para verificar modulos habilitados. */
  hasModule(module: ModuleKey): boolean {
    return (this.enabled_modules || []).includes(module);
  }

  get logoParaPdf(): string | undefined {
    return this.logo_pdf_path || this.logo_app_path || this.logo_path;
  }

  get logoParaApp(): string | undefined {
    return this.logo_app_path || this.logo_pdf_path || this.logo_path;
  }

  /** software_id efectivo para eventos RADIAN (usa el específico si existe, si no el general) */
  get softwareIdRadianEfectivo(): string | undefined {
    return this.software_id_radian || this.software_id;
  }

  /** software_pin efectivo para eventos RADIAN (usa el específico si existe, si no el general) */
  get softwarePinRadianEfectivo(): string | undefined {
    return this.software_pin_radian || this.software_pin;
  }
}
