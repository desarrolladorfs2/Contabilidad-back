"""
nomina_builder_cli.py

CLI para generar, firmar y transmitir el Documento Soporte de Pago de Nómina Electrónica
(DSPNE) según la Resolución 000013 de 2021 - Anexo Técnico v1.0 de la DIAN.

Operaciones (argumento posicional argv[1]):
  generate-nomina   → Genera el XML UBL de nómina individual
  sign-nomina       → Firma el XML con XAdES-BES usando signer_cli lógica
  send-nomina-sync  → Envía a DIAN producción (SendNominaSync)
  send-nomina-test  → Envía al ambiente de habilitación (SendTestSetAsync)
  get-nomina-status → Consulta estado por CUNE (GetStatus)
  get-status-zip    → Consulta TestSet por ZipKey (GetStatusZip)

Entrada/Salida: JSON por stdin / JSON por stdout (igual que los demás CLI).
"""
import sys
import os
import json
import hashlib
import base64
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(SCRIPT_DIR, 'lib', 'dian-transmitter')))

# ── Constantes DIAN Nómina ────────────────────────────────────────────────────

NOMINA_NS     = "dian:gov:co:facturaelectronica:NominaIndividual"
NOMINA_ADJ_NS = "dian:gov:co:facturaelectronica:NominaIndividualDeAjuste"

DIAN_URLS = {
    "production": "https://vpfe.dian.gov.co/WcfDianCustomerServices.svc",
    "test":       "https://vpfe-hab.dian.gov.co/WcfDianCustomerServices.svc",
}

DIAN_ACTION_BASE = "http://wcf.dian.colombia/IWcfDianCustomerServices/"

# ── Cálculo CUNE ──────────────────────────────────────────────────────────────

def calculate_cune(
    numero_secuencia: str,   # NumNE  — NumeroSecuenciaXML/@Numero
    fecha_gen: str,          # FecNE  — InformacionGeneral/@FechaGen
    hora_gen: str,           # HorNE  — InformacionGeneral/@HoraGen
    devengados_total: str,   # ValDev — DevengadosTotal
    deducciones_total: str,  # ValDed — DeduccionesTotal
    comprobante_total: str,  # ValTol — ComprobanteTotal
    nit_emisor: str,         # NitNE  — Empleador/@NIT  (sin DV, sin puntos)
    numero_documento: str,   # DocEmp — Trabajador/@NumeroDocumento
    tipo_xml: str,           # TipoXML — InformacionGeneral/@TipoXML
    software_pin: str,       # Software-Pin — PIN crudo (no el hash SoftwareSC)
    ambiente: str,           # TipAmb — InformacionGeneral/@Ambiente
) -> str:
    """
    CUNE = SHA-384(NumNE+FecNE+HorNE+ValDev+ValDed+ValTol+NitNE+DocEmp+TipoXML+SoftwarePin+TipAmb)
    Resolución 000013/2021 - Sección 8.1.
    """
    raw = (
        numero_secuencia
        + fecha_gen
        + hora_gen
        + devengados_total
        + deducciones_total
        + comprobante_total
        + nit_emisor
        + numero_documento
        + tipo_xml
        + software_pin
        + ambiente
    )
    return hashlib.sha384(raw.encode('utf-8')).hexdigest()

# ── Helpers de formato ────────────────────────────────────────────────────────

def fmt(v: float) -> str:
    """Formatea como decimal de 2 decimales para el XML."""
    return f"{v:.2f}"

def today_iso() -> str:
    from datetime import timedelta
    col = datetime.now(timezone.utc) - timedelta(hours=5)
    return col.strftime('%Y-%m-%d')

def now_time_col() -> str:
    """Hora en zona horaria Colombia (UTC-5), formato HH:MM:SS-05:00."""
    from datetime import timedelta
    col = datetime.now(timezone.utc) - timedelta(hours=5)
    return col.strftime('%H:%M:%S') + '-05:00'

def calculate_dv(nit: str) -> str:
    """Calcula el dígito de verificación (DV) de un NIT colombiano."""
    weights = [71, 67, 59, 53, 47, 43, 41, 37, 29, 23, 19, 17, 13, 7, 3]
    nit_clean = nit.strip().replace('-', '').replace('.', '')
    padded = nit_clean.zfill(15)[-15:]
    total = sum(int(d) * w for d, w in zip(padded, weights))
    r = total % 11
    return '0' if r == 0 else '1' if r == 1 else str(11 - r)

def calculate_software_code(software_id: str, software_pin: str, numero: str) -> str:
    """
    CodigoGenSoftware = SHA-384(SoftwareID + SoftwarePIN + NumeroSecuencia)
    Según Resolución 000013/2021 - Anexo técnico DIAN.
    """
    raw = software_id + software_pin + numero
    return hashlib.sha384(raw.encode('utf-8')).hexdigest()

# ── Generación del XML ────────────────────────────────────────────────────────

def _xml_tag(indent: int, tag: str, attrs: Dict[str, str] = {}, text: str = '', self_close: bool = False) -> str:
    sp = '  ' * indent
    attr_str = ' '.join(f'{k}="{v}"' for k, v in attrs.items())
    if attr_str:
        attr_str = ' ' + attr_str
    if self_close:
        return f'{sp}<{tag}{attr_str}/>\n'
    if text:
        return f'{sp}<{tag}{attr_str}>{text}</{tag}>\n'
    return f'{sp}<{tag}{attr_str}>\n'

def _xml_close(indent: int, tag: str) -> str:
    return '  ' * indent + f'</{tag}>\n'

def generate_nomina_xml(p: Dict[str, Any]) -> Dict[str, Any]:
    """
    Genera el XML del Documento Soporte de Pago de Nómina Electrónica.

    Estructura del payload esperado:
    {
      "company": { "nit", "dv", "razon_social", "dept_code", "city_code", "address", "software_id" },
      "worker": { "document_type", "document_number", "first_surname", "second_surname", "first_name", "other_names",
                  "worker_code", "contract_type", "integral_salary", "base_salary",
                  "work_dept_code", "work_city_code",
                  "payment_method", "bank_name", "bank_account_type", "bank_account_number" },
      "period": { "period_type", "period_start", "period_end", "payment_date", "notes" },
      "sequence_number": int,
      "issue_date": "YYYY-MM-DD",    # optional, defaults to today
      "environment": "1"|"2",        # 1=prod, 2=hab
      "software_security_code": str, # from DIAN registration
      "devengados": { ... },
      "deducciones": { ... },
      "is_adjustment_note": false,
      "adjusted_cune": null          # only for adjustment notes
    }
    """
    try:
        company  = p['company']
        worker   = p['worker']
        period   = p['period']
        devengs  = p.get('devengados', {})
        deducks  = p.get('deducciones', {})
        env      = str(p.get('environment', '2'))
        seq      = str(p.get('sequence_number', 1))
        is_adj   = p.get('is_adjustment_note', False)
        tipo_xml = '103' if is_adj else '102'

        issue_date = p.get('issue_date') or today_iso()
        issue_time = now_time_col()
        # DV del empleador: usar el valor configurado; si falta, calcularlo del NIT
        _dv_raw = company.get('dv') or ''
        company_dv = _dv_raw if _dv_raw else calculate_dv(company.get('nit', ''))

        # Número completo del documento (con prefijo si aplica) — usado en SoftwareSC y CUNE
        nomina_prefix = p.get('nomina_prefix', '') or ''
        numero_doc    = f'{nomina_prefix}{seq}' if nomina_prefix else str(seq)

        # CodigoGenSoftware = SHA384(SoftwareID + SoftwarePIN + NumeroSecuenciaXML.Numero)
        # Según resolución DIAN: el Numero es el número completo (con prefijo)
        software_id_raw  = company.get('software_id', '')
        software_pin_raw = p.get('software_pin_nomina', '') or p.get('software_security_code', '')
        software_code    = calculate_software_code(software_id_raw, software_pin_raw, numero_doc)

        # ── Totales ──────────────────────────────────────────────────────────
        total_devengados  = float(p.get('total_devengados', 0))
        total_deducciones = float(p.get('total_deducciones', 0))
        total_pago        = float(p.get('total_pago', 0))

        if total_pago == 0:
            total_pago = total_devengados - total_deducciones

        # ── CUNE ─────────────────────────────────────────────────────────────
        worker_code = worker.get('worker_code') or f"CC{worker['document_number']}"
        cune = calculate_cune(
            numero_secuencia  = numero_doc,
            fecha_gen         = issue_date,
            hora_gen          = issue_time,
            devengados_total  = fmt(total_devengados),
            deducciones_total = fmt(total_deducciones),
            comprobante_total = fmt(total_pago),
            nit_emisor        = company['nit'],
            numero_documento  = str(worker['document_number']),
            tipo_xml          = tipo_xml,
            software_pin      = software_pin_raw,
            ambiente          = env,
        )

        ns = NOMINA_ADJ_NS if is_adj else NOMINA_NS
        root_tag = 'NominaIndividualDeAjuste' if is_adj else 'NominaIndividual'

        xsd_name = 'NominaIndividualDeAjusteElectronicaXSD.xsd' if is_adj else 'NominaIndividualElectronicaXSD.xsd'
        xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
        xml += f'<{root_tag}\n'
        xml += f'  xmlns="{ns}"\n'
        xml += f'  xmlns:xs="http://www.w3.org/2001/XMLSchema-instance"\n'
        xml += f'  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"\n'
        xml += f'  xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"\n'
        xml += f'  xmlns:xades="http://uri.etsi.org/01903/v1.3.2#"\n'
        xml += f'  xmlns:xades141="http://uri.etsi.org/01903/v1.4.1#"\n'
        xml += f'  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n'
        xml += f'  SchemaLocation="{ns} {xsd_name}"\n'
        xml += f'  xsi:schemaLocation="{ns} {xsd_name}">\n'

        # ext:UBLExtensions: una sola extensión para la firma XAdES
        # El nómina XSD solo permite un UBLExtension (diferente a factura UBL)
        xml += '  <ext:UBLExtensions>\n'
        xml += '    <ext:UBLExtension>\n'
        xml += '      <ext:ExtensionContent/>\n'
        xml += '    </ext:UBLExtension>\n'
        xml += '  </ext:UBLExtensions>\n'

        # Datos del predecesor para Nota de Ajuste
        orig_cune  = p.get('adjusted_cune', '0') or '0'
        orig_num   = p.get('adjusted_numero', '0') or '0'
        orig_date  = p.get('adjusted_issue_date', '9999-12-31') or '9999-12-31'

        if is_adj:
            # TipoNota: 1=Reemplazar (ajuste de contenido), 2=Eliminar — tabla 5.5.8
            tipo_nota = str(p.get('tipo_nota', 1))
            xml += f'  <TipoNota>{tipo_nota}</TipoNota>\n'
            xml += '  <Reemplazar>\n'
            xml += f'    <ReemplazandoPredecesor NumeroPred="{orig_num}" CUNEPred="{orig_cune}" FechaGenPred="{orig_date}"/>\n'

        # Periodo
        from datetime import timedelta as _td
        try:
            _d1 = datetime.strptime(period['period_start'], '%Y-%m-%d')
            _d2 = datetime.strptime(period['period_end'],   '%Y-%m-%d')
            # TiempoLaborado = diferencia inclusive (FechaFin - FechaInicio + 1) según NIE111
            _days = (_d2 - _d1).days + 1
        except Exception:
            _days = 30
        tiempo_laborado = str(_days)

        # FechaIngreso = fecha de contratación del empleado
        fecha_ingreso  = worker.get('hire_date') or period['period_start']
        # FechaRetiro solo si el trabajador tiene fecha de retiro
        fecha_retiro   = worker.get('termination_date', '')
        periodo_attrs  = (
            f' FechaIngreso="{fecha_ingreso}"'
            + (f' FechaRetiro="{fecha_retiro}"' if fecha_retiro else '')
            + f' FechaLiquidacionInicio="{period["period_start"]}"'
            + f' FechaLiquidacionFin="{period["period_end"]}"'
            + f' TiempoLaborado="{tiempo_laborado}"'
            + f' FechaGen="{issue_date}"'
        )
        xml += f'  <Periodo{periodo_attrs}/>\n'

        # NumeroSecuenciaXML: numero_doc y nomina_prefix ya calculados arriba
        _prefijo_attr = f' Prefijo="{nomina_prefix}"' if nomina_prefix else ''
        xml += f'  <NumeroSecuenciaXML{_prefijo_attr} Consecutivo="{seq}" Numero="{numero_doc}" CodigoTrabajador="{worker_code}"/>\n'

        # LugarGeneracionXML
        xml += f'  <LugarGeneracionXML Pais="CO" DepartamentoEstado="{company.get("dept_code", "11")}" MunicipioCiudad="{company.get("city_code", "11001")}" Idioma="es"/>\n'

        # ProveedorXML
        xml += f'  <ProveedorXML RazonSocial="{_esc(company["razon_social"])}" NIT="{company["nit"]}" DV="{company_dv}" SoftwareID="{software_id_raw}" SoftwareSC="{software_code}"/>\n'

        # CodigoQR — requerido por XSD entre ProveedorXML e InformacionGeneral
        qr_base = 'https://catalogo-vpfe-hab.dian.gov.co' if env == '2' else 'https://catalogo-vpfe.dian.gov.co'
        xml += f'  <CodigoQR>{qr_base}/document/searchqr?documentkey={cune}</CodigoQR>\n'

        # InformacionGeneral
        # PeriodoNomina y TipoMoneda son required en NominaIndividual y en Reemplazar de NominaIndividualDeAjuste
        # TRM es opcional en ambos
        _version_str = (
            'V1.0: Nota de Ajuste de Documento Soporte de Pago de N&#243;mina Electr&#243;nica'
            if is_adj else
            'V1.0: Documento Soporte de Pago de N&#243;mina Electr&#243;nica'
        )
        xml += (
            f'  <InformacionGeneral'
            f' Version="{_version_str}"'
            f' Ambiente="{env}"'
            f' TipoXML="{tipo_xml}"'
            f' CUNE="{cune}"'
            f' EncripCUNE="CUNE-SHA384"'
            f' FechaGen="{issue_date}"'
            f' HoraGen="{issue_time}"'
            f' PeriodoNomina="{period.get("period_type", "6")}"'
            f' TipoMoneda="COP"'
            f' TRM="1.00"/>\n'
        )

        # Notas
        notes = period.get('notes') or ''
        xml += f'  <Notas>{_esc(notes)}</Notas>\n'

        # Empleador
        xml += (
            f'  <Empleador RazonSocial="{_esc(company["razon_social"])}"'
            f' NIT="{company["nit"]}" DV="{company_dv}"'
            f' Pais="CO"'
            f' DepartamentoEstado="{company.get("dept_code","11")}"'
            f' MunicipioCiudad="{company.get("city_code","11001")}"'
            f' Direccion="{_esc(company.get("address",""))}"/>\n'
        )

        # Trabajador — TipoTrabajador y SubTipoTrabajador son códigos de 2 dígitos (tabla 5.5.3/5.5.4)
        integral = 'true' if worker.get('integral_salary') else 'false'
        worker_address = _esc(worker.get('address', '') or '')
        _tipo_trab     = str(int(worker.get("worker_type", "01"))).zfill(2)
        _sub_tipo_trab = str(int(worker.get("worker_subtype", "00"))).zfill(2)
        xml += (
            f'  <Trabajador'
            f' TipoTrabajador="{_tipo_trab}"'
            f' SubTipoTrabajador="{_sub_tipo_trab}"'
            f' AltoRiesgoPension="{str(worker.get("high_risk_pension", False)).lower()}"'
            f' TipoDocumento="{worker.get("document_type","13")}"'
            f' NumeroDocumento="{worker["document_number"]}"'
            f' PrimerApellido="{_esc(worker["first_surname"])}"'
            f' SegundoApellido="{_esc(worker.get("second_surname",""))}"'
            f' PrimerNombre="{_esc(worker["first_name"])}"'
            f' OtrosNombres="{_esc(worker.get("other_names","") or " ")}"'
            f' LugarTrabajoPais="CO"'
            f' LugarTrabajoDepartamentoEstado="{worker.get("work_dept_code","11")}"'
            f' LugarTrabajoMunicipioCiudad="{worker.get("work_city_code","11001")}"'
            f' LugarTrabajoDireccion="{worker_address}"'
            f' SalarioIntegral="{integral}"'
            f' TipoContrato="{worker.get("contract_type","1")}"'
            f' Sueldo="{fmt(float(worker.get("base_salary",0)))}"'
            f' CodigoTrabajador="{worker_code}"/>\n'
        )

        # Pago
        pay_method = worker.get('payment_method', '10')
        if pay_method == '10':
            # Efectivo — sin datos bancarios
            xml += f'  <Pago Forma="1" Metodo="{pay_method}"/>\n'
        else:
            xml += (
                f'  <Pago Forma="1" Metodo="{pay_method}"'
                f' Banco="{_esc(worker.get("bank_name",""))}"'
                f' TipoCuenta="{worker.get("bank_account_type","")}"'
                f' NumeroCuenta="{worker.get("bank_account_number","")}" />\n'
            )

        # FechasPagos
        xml += '  <FechasPagos>\n'
        xml += f'    <FechaPago>{period["payment_date"]}</FechaPago>\n'
        xml += '  </FechasPagos>\n'

        # ── Devengados ──────────────────────────────────────────────────────
        xml += '  <Devengados>\n'

        basico = devengs.get('basico', {})
        xml += f'    <Basico DiasTrabajados="{int(basico.get("dias_trabajados", 30))}" SueldoTrabajado="{fmt(float(basico.get("sueldo_trabajado", 0)))}"/>\n'

        if 'transporte' in devengs:
            t = devengs['transporte']
            _auxilio    = float(t.get("auxilio_transporte", 0))
            _viaticos_s  = float(t.get("viaticos_s", 0))
            _viaticos_ns = float(t.get("viaticos_ns", 0))
            if _auxilio > 0 or _viaticos_s > 0 or _viaticos_ns > 0:
                _trans = '    <Transporte'
                if _auxilio    > 0: _trans += f' AuxilioTransporte="{fmt(_auxilio)}"'
                if _viaticos_s  > 0: _trans += f' ViaticoManuAlojS="{fmt(_viaticos_s)}"'
                if _viaticos_ns > 0: _trans += f' ViaticoManuAlojNS="{fmt(_viaticos_ns)}"'
                xml += _trans + '/>\n'

        if 'horas_extras' in devengs:
            for he in devengs['horas_extras']:
                tipo = he.get('tipo', 'HED')
                xml += f'    <{tipo}s>\n'
                xml += f'      <{tipo} Cantidad="{int(float(he.get("cantidad",0)))}" Porcentaje="{fmt(float(he.get("porcentaje",25)))}" Pago="{fmt(float(he.get("pago",0)))}"/>\n'
                xml += f'    </{tipo}s>\n'

        if 'vacaciones' in devengs:
            vac = devengs['vacaciones']
            xml += '    <Vacaciones>\n'
            if 'vc' in vac:
                vc = vac['vc']
                xml += f'      <VacacionesComunes Cantidad="{int(float(vc.get("cantidad",0)))}" Pago="{fmt(float(vc.get("pago",0)))}"/>\n'
            if 'vcp' in vac:
                vcp = vac['vcp']
                xml += f'      <VacacionesCompensadas Cantidad="{int(float(vcp.get("cantidad",0)))}" Pago="{fmt(float(vcp.get("pago",0)))}"/>\n'
            xml += '    </Vacaciones>\n'

        if 'prima' in devengs:
            pr = devengs['prima']
            xml += (
                f'    <Primas Cantidad="{int(float(pr.get("cantidad",0)))}"'
                f' Pago="{fmt(float(pr.get("pago",0)))}"'
                f' PagoNS="{fmt(float(pr.get("pago_ns",0)))}"/>\n'
            )

        if 'cesantias' in devengs:
            ces = devengs['cesantias']
            xml += (
                f'    <Cesantias Pago="{fmt(float(ces.get("pago",0)))}"'
                f' Porcentaje="{fmt(float(ces.get("porcentaje",12)))}"'
                f' PagoIntereses="{fmt(float(ces.get("pago_intereses",0)))}"/>\n'
            )

        if 'incapacidades' in devengs:
            for inc in devengs['incapacidades']:
                xml += '    <Incapacidades>\n'
                xml += f'      <Incapacidad Tipo="{inc.get("tipo","EG")}" Cantidad="{int(float(inc.get("cantidad",0)))}" Pago="{fmt(float(inc.get("pago",0)))}"/>\n'
                xml += '    </Incapacidades>\n'

        if 'licencias' in devengs:
            lic = devengs['licencias']
            xml += '    <Licencias>\n'
            if 'maternidad' in lic:
                m = lic['maternidad']
                xml += f'      <LicenciaMP Cantidad="{int(float(m.get("cantidad",0)))}" Pago="{fmt(float(m.get("pago",0)))}"/>\n'
            if 'paternidad' in lic:
                pa = lic['paternidad']
                xml += f'      <LicenciaR Cantidad="{int(float(pa.get("cantidad",0)))}" Pago="{fmt(float(pa.get("pago",0)))}"/>\n'
            if 'remuneradas' in lic:
                lr = lic['remuneradas']
                xml += f'      <LicenciaR Cantidad="{int(float(lr.get("cantidad",0)))}" Pago="{fmt(float(lr.get("pago",0)))}"/>\n'
            if 'no_remuneradas' in lic:
                lnr = lic['no_remuneradas']
                xml += f'      <LicenciaNR Cantidad="{int(float(lnr.get("cantidad",0)))}"/>\n'
            xml += '    </Licencias>\n'

        if 'bonificaciones' in devengs:
            for bon in devengs['bonificaciones']:
                tag = 'BonificacionS' if bon.get('salarial') else 'BonificacionNS'
                xml += f'    <Bonificaciones>\n'
                xml += f'      <{tag} PagoS="{fmt(float(bon.get("pago",0)))}" PagoNS="{fmt(float(bon.get("pago_ns",0)))}"/>\n'
                xml += f'    </Bonificaciones>\n'

        if 'comisiones' in devengs:
            xml += f'    <Comisiones Comision="{fmt(float(devengs["comisiones"]))}"/>\n'

        if 'otros' in devengs:
            for ot in devengs['otros']:
                xml += f'    <OtrosConceptos>\n'
                xml += f'      <OtroConcepto DescripcionConcepto="{_esc(ot.get("descripcion",""))}" ConceptoS="{fmt(float(ot.get("pago",0)))}" ConceptoNS="{fmt(float(ot.get("pago_ns",0)))}"/>\n'
                xml += f'    </OtrosConceptos>\n'

        xml += '  </Devengados>\n'

        # ── Deducciones ─────────────────────────────────────────────────────
        xml += '  <Deducciones>\n'

        salud = deducks.get('salud', {})
        xml += f'    <Salud Porcentaje="{fmt(float(salud.get("porcentaje",4)))}" Deduccion="{fmt(float(salud.get("deduccion",0)))}"/>\n'

        pension = deducks.get('pension', {})
        xml += f'    <FondoPension Porcentaje="{fmt(float(pension.get("porcentaje",4)))}" Deduccion="{fmt(float(pension.get("deduccion",0)))}"/>\n'

        if 'fsp' in deducks:
            fsp = deducks['fsp']
            xml += (
                f'    <FondoSP'
                f' PorcentajeSub="{fmt(float(fsp.get("porcentaje_sub",0)))}"'
                f' DeduccionSub="{fmt(float(fsp.get("deduccion_sub",0)))}"'
                f' Porcentaje="{fmt(float(fsp.get("porcentaje",0)))}"'
                f' Deduccion="{fmt(float(fsp.get("deduccion",0)))}"/>\n'
            )

        if 'retencion_fuente' in deducks:
            xml += f'    <RetencionFuente Deduccion="{fmt(float(deducks["retencion_fuente"]))}"/>\n'

        if 'libranzas' in deducks:
            for lib in deducks['libranzas']:
                xml += f'    <Libranzas>\n'
                xml += f'      <Libranza Descripcion="{_esc(lib.get("descripcion",""))}" Deduccion="{fmt(float(lib.get("deduccion",0)))}"/>\n'
                xml += f'    </Libranzas>\n'

        if 'sindicatos' in deducks:
            sind = deducks['sindicatos']
            xml += f'    <Sindicatos Porcentaje="{fmt(float(sind.get("porcentaje",0)))}" Deduccion="{fmt(float(sind.get("deduccion",0)))}"/>\n'

        if 'sanciones' in deducks:
            san = deducks['sanciones']
            xml += f'    <Sanciones SancionPublica="{fmt(float(san.get("publica",0)))}" SancionPrivada="{fmt(float(san.get("privada",0)))}"/>\n'

        if 'otras' in deducks:
            for ot in deducks['otras']:
                xml += f'    <OtrasDeducciones>\n'
                xml += f'      <OtraDeduccion DescripcionConcepto="{_esc(ot.get("descripcion",""))}" Deduccion="{fmt(float(ot.get("deduccion",0)))}"/>\n'
                xml += f'    </OtrasDeducciones>\n'

        xml += '  </Deducciones>\n'

        # Totales
        xml += f'  <DevengadosTotal>{fmt(total_devengados)}</DevengadosTotal>\n'
        xml += f'  <DeduccionesTotal>{fmt(total_deducciones)}</DeduccionesTotal>\n'
        xml += f'  <ComprobanteTotal>{fmt(total_pago)}</ComprobanteTotal>\n'

        if is_adj:
            xml += '  </Reemplazar>\n'
            # TipoNota=1 → Reemplazar only (no Eliminar section needed)
            # TipoNota=2 → Eliminar only (minimal data, no Devengados/Deducciones)
            if tipo_nota == '2':
                xml += '  <Eliminar>\n'
                xml += f'    <EliminandoPredecesor NumeroPred="{orig_num}" CUNEPred="{orig_cune}" FechaGenPred="{orig_date}"/>\n'
                _prefijo_attr_e = f' Prefijo="{nomina_prefix}"' if nomina_prefix else ''
                xml += f'    <NumeroSecuenciaXML{_prefijo_attr_e} Consecutivo="{seq}" Numero="{numero_doc}"/>\n'
                xml += f'    <LugarGeneracionXML Pais="CO" DepartamentoEstado="{company.get("dept_code","11")}" MunicipioCiudad="{company.get("city_code","11001")}" Idioma="es"/>\n'
                xml += f'    <ProveedorXML RazonSocial="{_esc(company["razon_social"])}" NIT="{company["nit"]}" DV="{company_dv}" SoftwareID="{software_id_raw}" SoftwareSC="{software_code}"/>\n'
                xml += f'    <CodigoQR>{qr_base}/document/searchqr?documentkey={cune}</CodigoQR>\n'
                xml += (
                    f'    <InformacionGeneral'
                    f' Version="{_version_str}"'
                    f' Ambiente="{env}"'
                    f' TipoXML="{tipo_xml}"'
                    f' CUNE="{cune}"'
                    f' EncripCUNE="CUNE-SHA384"'
                    f' FechaGen="{issue_date}"'
                    f' HoraGen="{issue_time}"/>\n'
                )
                xml += f'    <Notas>{_esc(notes)}</Notas>\n'
                xml += (
                    f'    <Empleador RazonSocial="{_esc(company["razon_social"])}"'
                    f' NIT="{company["nit"]}" DV="{company_dv}"'
                    f' Pais="CO"'
                    f' DepartamentoEstado="{company.get("dept_code","11")}"'
                    f' MunicipioCiudad="{company.get("city_code","11001")}"'
                    f' Direccion="{_esc(company.get("address",""))}"/>\n'
                )
                xml += '  </Eliminar>\n'

        xml += f'</{root_tag}>\n'

        xml_b64 = base64.b64encode(xml.encode('utf-8')).decode()

        return {
            'success': True,
            'xml_base64': xml_b64,
            'cune': cune,
            'issue_date': issue_date,
            'issue_time': issue_time,
            'total_devengados': fmt(total_devengados),
            'total_deducciones': fmt(total_deducciones),
            'total_pago': fmt(total_pago),
        }

    except Exception as e:
        import traceback
        return {'success': False, 'error': str(e), 'traceback': traceback.format_exc()}


def _esc(s: str) -> str:
    """Escapa caracteres especiales XML básicos."""
    return (s or '').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')


# ── Firma (reutiliza signer_cli lógica) ──────────────────────────────────────

def sign_nomina(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Firma el XML de nómina con XAdES-BES.
    Usa el mismo proceso que signer_cli.py — simplemente llama al módulo directamente.
    payload: { xml_base64, filename, pfx_base64, password }
    """
    try:
        import subprocess
        signer_path = os.path.join(SCRIPT_DIR, 'signer_cli.py')
        python_exec = os.environ.get('PYTHON_EXECUTABLE', sys.executable)

        input_data = json.dumps(payload).encode()
        result = subprocess.run(
            [python_exec, signer_path, 'sign'],
            input=input_data,
            capture_output=True,
            timeout=60,
        )
        stdout = result.stdout.decode('utf-8', errors='replace').strip()
        if not stdout:
            return {'success': False, 'error': result.stderr.decode('utf-8', errors='replace')[:500]}
        idx = stdout.find('{')
        return json.loads(stdout[idx:] if idx >= 0 else stdout)
    except Exception as e:
        import traceback
        return {'success': False, 'error': str(e), 'traceback': traceback.format_exc()}


# ── Transmisión DIAN Nómina ───────────────────────────────────────────────────

def send_nomina_sync(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    SendNominaSync → Ambiente de producción.
    payload: { zip_base64, filename, pfx_base64, password }
    """
    return _send_to_dian(payload, operation='SendNominaSync')


def send_nomina_test(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    SendTestSetAsync → Ambiente de habilitación.
    payload: { zip_base64, filename, pfx_base64, password, test_set_id }
    """
    return _send_to_dian(payload, operation='SendTestSetAsync')


def get_nomina_status(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    GetStatus → Consulta por CUNE.
    payload: { track_id (CUNE), pfx_base64, password }
    """
    return _send_to_dian(payload, operation='GetStatus')


def get_status_zip(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    GetStatusZip → Consulta TestSet por ZipKey.
    payload: { zip_key, pfx_base64, password }
    """
    return _send_to_dian(payload, operation='GetStatusZip')


def _send_to_dian(payload: Dict[str, Any], operation: str) -> Dict[str, Any]:
    """
    Construye el sobre SOAP y llama al endpoint de nómina.
    La firma del header WS-Security es idéntica a la de facturación.
    """
    try:
        from dian_sender import DianTransmitter, load_cert_and_key
        import requests
        from lxml import etree

        env_raw = payload.get('environment', 'test')
        env = {'1': 'production', '2': 'test'}.get(str(env_raw), 'test')
        url = DIAN_URLS[env]

        pfx_base64 = payload.get('pfx_base64')
        pfx_bytes  = base64.b64decode(pfx_base64) if pfx_base64 else None
        password   = payload.get('password', '')

        tx = DianTransmitter(
            environment=env,
            pfx_bytes=pfx_bytes,
            password=password,
        ) if pfx_bytes else None

        if operation == 'SendNominaSync':
            if not tx:
                return {'success': False, 'error': 'Certificado PFX requerido para transmitir'}
            result = tx.send_nomina_sync(
                zip_base64=payload['zip_base64'],
                filename=payload['filename'],
            )

        elif operation == 'SendTestSetAsync':
            if not tx:
                return {'success': False, 'error': 'Certificado PFX requerido para ambiente de habilitación'}
            result = tx.send_test_set_async(
                zip_base64=payload['zip_base64'],
                filename=payload['filename'],
                test_set_id=payload.get('test_set_id', ''),
            )

        elif operation == 'GetStatus':
            if not tx:
                return {'success': False, 'error': 'Certificado PFX requerido'}
            result = tx.get_status(track_id=payload['track_id'])

        elif operation == 'GetStatusZip':
            if not tx:
                return {'success': False, 'error': 'Certificado PFX requerido'}
            result = tx.get_status_zip(zip_key=payload['zip_key'])

        else:
            return {'success': False, 'error': f'Operación desconocida: {operation}'}

        result.pop('raw_request', None)
        # Conservar raw_response cuando success=False para debug
        keep_raw = payload.get('include_raw') or (not result.get('success', True))
        if not keep_raw:
            result.pop('raw_response', None)
        result['success'] = result.get('success', False)
        return result

    except ImportError:
        # dian_sender no disponible — usar SOAP directo como fallback
        return _send_nomina_soap_direct(payload, operation)
    except Exception as e:
        import traceback
        return {'success': False, 'error': str(e), 'traceback': traceback.format_exc()}


def _send_nomina_soap_direct(payload: Dict[str, Any], operation: str) -> Dict[str, Any]:
    """
    Fallback: SOAP directo para nómina cuando DianTransmitter no tiene el método.
    Construye el sobre manualmente igual que el transmisor de facturas.
    """
    try:
        import requests
        from lxml import etree
        from dian_sender import load_cert_and_key
        import xmlsig
        from cryptography.hazmat.primitives import serialization
        from datetime import timedelta

        env_raw = payload.get('environment', 'test')
        env = {'1': 'production', '2': 'test'}.get(str(env_raw), 'test')
        url = DIAN_URLS[env]

        pfx_base64 = payload.get('pfx_base64')
        pfx_bytes  = base64.b64decode(pfx_base64) if pfx_base64 else None
        password   = payload.get('password', '')

        if not pfx_bytes:
            return {'success': False, 'error': 'PFX requerido'}

        cert, private_key = load_cert_and_key(pfx_bytes=pfx_bytes, password=password)

        action_map = {
            'SendNominaSync':  'SendNominaSync',
            'SendTestSetAsync':'SendTestSetAsync',
            'GetStatus':       'GetStatus',
            'GetStatusZip':    'GetStatusZip',
        }
        soap_action = DIAN_ACTION_BASE + action_map[operation]

        # ── Construir el cuerpo SOAP ─────────────────────────────────────────
        now_utc = datetime.now(timezone.utc)
        expires = now_utc + timedelta(minutes=5)

        wsu_id_ts  = f'TS-{uuid.uuid4().hex[:16]}'
        wsu_id_bst = f'X509-{uuid.uuid4().hex[:16]}'

        cert_der   = cert.public_bytes(serialization.Encoding.DER)
        cert_b64   = base64.b64encode(cert_der).decode()

        # Cuerpo según la operación
        if operation == 'SendNominaSync':
            body_content = f"""<wcf:SendNominaSync>
    <wcf:fileName>{payload['filename']}</wcf:fileName>
    <wcf:contentFile>{payload['zip_base64']}</wcf:contentFile>
  </wcf:SendNominaSync>"""
        elif operation == 'SendTestSetAsync':
            body_content = f"""<wcf:SendTestSetAsync>
    <wcf:fileName>{payload['filename']}</wcf:fileName>
    <wcf:contentFile>{payload['zip_base64']}</wcf:contentFile>
    <wcf:testSetId>{payload.get('test_set_id','')}</wcf:testSetId>
  </wcf:SendTestSetAsync>"""
        elif operation == 'GetStatus':
            body_content = f"""<wcf:GetStatus>
    <wcf:trackId>{payload.get('track_id','')}</wcf:trackId>
  </wcf:GetStatus>"""
        else:  # GetStatusZip
            body_content = f"""<wcf:GetStatusZip>
    <wcf:trackId>{payload.get('zip_key','')}</wcf:trackId>
  </wcf:GetStatusZip>"""

        soap_body = f"""<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
  xmlns:wcf="http://wcf.dian.colombia"
  xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
  xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"
  xmlns:wsa="http://www.w3.org/2005/08/addressing"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <soap:Header>
    <wsse:Security soap:mustUnderstand="1">
      <wsu:Timestamp wsu:Id="{wsu_id_ts}">
        <wsu:Created>{now_utc.strftime('%Y-%m-%dT%H:%M:%SZ')}</wsu:Created>
        <wsu:Expires>{expires.strftime('%Y-%m-%dT%H:%M:%SZ')}</wsu:Expires>
      </wsu:Timestamp>
      <wsse:BinarySecurityToken
        EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary"
        ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3"
        wsu:Id="{wsu_id_bst}">{cert_b64}</wsse:BinarySecurityToken>
    </wsse:Security>
    <wsa:Action>{soap_action}</wsa:Action>
    <wsa:To>{url}</wsa:To>
  </soap:Header>
  <soap:Body>
    {body_content}
  </soap:Body>
</soap:Envelope>"""

        headers = {
            'Content-Type': 'application/soap+xml; charset=utf-8',
            'SOAPAction':   soap_action,
        }
        resp = requests.post(url, data=soap_body.encode('utf-8'), headers=headers, timeout=60)

        # Parse response
        try:
            root = etree.fromstring(resp.content)
  
            ns = {'soap': 'http://www.w3.org/2003/05/soap-envelope', 'wcf': 'http://wcf.dian.colombia'}
            result_el = root.find('.//{http://wcf.dian.colombia}' + action_map[operation] + 'Result')
            if result_el is not None:
                text = (result_el.text or '').strip()
                # SendTestSetAsync devuelve un GUID plano (ZipKey), no XML interno
                if operation == 'SendTestSetAsync' and text and '-' in text and not text.startswith('<'):
                    return {
                        'success': True,
                        'zip_key': text,
                        'status_code': None,
                        'status_description': 'Enviado a DIAN (procesamiento asincrono)',
                        'errors': [],
                        'http_status': resp.status_code,
                    }
                inner = etree.fromstring(text or '<r/>')
                status_code = inner.findtext('.//{*}StatusCode') or inner.findtext('.//{*}errorCode') or '99'
                status_desc = inner.findtext('.//{*}StatusDescription') or inner.findtext('.//{*}statusDescription') or ''
                errors_el = inner.findall('.//{*}ErrorMessage') or inner.findall('.//{*}errorMessage')
                errors = [e.text for e in errors_el if e.text]
                return {
                    'success': status_code == '00',
                    'status_code': status_code,
                    'status_description': status_desc,
                    'errors': errors,
                    'http_status': resp.status_code,
                }
        except Exception:
            pass

        return {
            'success': resp.status_code == 200,
            'http_status': resp.status_code,
            'raw_text': resp.text[:2000],
        }

    except Exception as e:
        import traceback
        return {'success': False, 'error': str(e), 'traceback': traceback.format_exc()}


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    operation = sys.argv[1] if len(sys.argv) > 1 else 'generate-nomina'
    payload   = json.loads(sys.stdin.read())

    handlers = {
        'generate-nomina':    generate_nomina_xml,
        'sign-nomina':        sign_nomina,
        'send-nomina-sync':   send_nomina_sync,
        'send-nomina-test':   send_nomina_test,
        'get-nomina-status':  get_nomina_status,
        'get-status-zip':     get_status_zip,
    }

    handler = handlers.get(operation)
    if not handler:
        print(json.dumps({'success': False, 'error': f'Operacion desconocida: {operation}'}))
        return
    result = handler(payload)
    print(json.dumps(result))

if __name__ == '__main__':
    main()
