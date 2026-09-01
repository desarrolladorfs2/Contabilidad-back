"""
Generador de Colilla/Comprobante de Pago de Nomina Electronica
Uso:
  python nomina_colilla_cli.py generate-colilla '<json_payload>'
Salida JSON: { "success": true, "pdf_base64": "..." }
"""
from __future__ import annotations
import sys, json, base64, os, io
from datetime import datetime

try:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        BaseDocTemplate, Frame, PageTemplate,
        Paragraph, Spacer, Table, TableStyle, HRFlowable,
    )
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.enums import TA_CENTER, TA_RIGHT, TA_LEFT
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    HAVE_REPORTLAB = True
except ImportError:
    HAVE_REPORTLAB = False

# ── Fuentes ──────────────────────────────────────────────────────────────────
def _register_fonts():
    candidates = [
        ('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',           'ColReg'),
        ('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',      'ColBold'),
        ('/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf','ColReg'),
        ('/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',   'ColBold'),
        (r'C:\Windows\Fonts\arial.ttf',   'ColReg'),
        (r'C:\Windows\Fonts\arialbd.ttf', 'ColBold'),
        (r'C:\Windows\Fonts\calibri.ttf', 'ColReg'),
        (r'C:\Windows\Fonts\calibrib.ttf','ColBold'),
    ]
    reg = bold = False
    for path, name in candidates:
        if os.path.exists(path):
            try:
                pdfmetrics.registerFont(TTFont(name, path))
                if name == 'ColReg':  reg  = True
                if name == 'ColBold': bold = True
            except Exception:
                pass
        if reg and bold:
            break
    return ('ColReg' if reg else 'Helvetica', 'ColBold' if bold else 'Helvetica-Bold')

def fmt_cop(value: float) -> str:
    try:
        v = float(value)
    except (TypeError, ValueError):
        v = 0.0
    return '$ {:,.0f}'.format(v).replace(',', '.')

def generate_colilla(data: dict) -> bytes:
    if not HAVE_REPORTLAB:
        raise RuntimeError("reportlab no instalado. Ejecuta: pip install reportlab")

    reg_font, bold_font = _register_fonts()

    # ── Colores de la empresa (o default Neurum) ──────────────────────────
    primary_hex   = data.get('pdf_primary_color',   '#7B2D8B')
    secondary_hex = data.get('pdf_secondary_color', '#374151')

    def hex2color(h: str):
        h = h.lstrip('#')
        if len(h) == 3: h = ''.join(c*2 for c in h)
        r, g, b = int(h[0:2],16)/255, int(h[2:4],16)/255, int(h[4:6],16)/255
        return colors.Color(r, g, b)

    COL_PRIMARY   = hex2color(primary_hex)
    COL_SECONDARY = hex2color(secondary_hex)
    COL_LIGHT     = colors.Color(0.96, 0.96, 0.97)
    COL_BORDER    = colors.Color(0.82, 0.82, 0.85)
    COL_WHITE     = colors.white
    COL_DARK      = colors.Color(0.13, 0.13, 0.16)

    # ── Estilos ───────────────────────────────────────────────────────────
    def S(name, **kw):
        defaults = dict(fontName=reg_font, fontSize=9, leading=12,
                        textColor=COL_DARK, spaceAfter=0, spaceBefore=0)
        defaults.update(kw)
        return ParagraphStyle(name, **defaults)

    sNormal  = S('Normal')
    sBold    = S('Bold',  fontName=bold_font)
    sSmall   = S('Small', fontSize=7.5, textColor=colors.Color(.4,.4,.4))
    sCenter  = S('Center', alignment=TA_CENTER)
    sCenterB = S('CenterB', alignment=TA_CENTER, fontName=bold_font)
    sRight   = S('Right', alignment=TA_RIGHT)
    sRightB  = S('RightB', alignment=TA_RIGHT, fontName=bold_font)
    sWhiteB  = S('WhiteB', fontName=bold_font, textColor=COL_WHITE, fontSize=10)
    sWhite   = S('White', textColor=COL_WHITE, fontSize=8.5)
    sMuted   = S('Muted', textColor=colors.Color(.45,.45,.48), fontSize=8)

    # ── Datos ─────────────────────────────────────────────────────────────
    company  = data.get('company', {})
    worker   = data.get('worker',  {})
    period   = data.get('period',  {})
    devs     = data.get('devengados', {})
    deds     = data.get('deducciones', {})
    total_d  = float(data.get('total_devengados', 0))
    total_de = float(data.get('total_deducciones', 0))
    total_p  = float(data.get('total_pago', 0))
    cune     = data.get('cune', '')
    seq      = data.get('sequence_number', '')

    # ── Construir PDF ────────────────────────────────────────────────────
    buf = io.BytesIO()
    W, H = A4  # 210 x 297 mm

    # Half-page colilla (we'll cut at ~145mm height)
    page_w, page_h = W, 148*mm   # A5 landscape-ish

    doc = BaseDocTemplate(
        buf, pagesize=(page_w, page_h),
        leftMargin=14*mm, rightMargin=14*mm,
        topMargin=10*mm, bottomMargin=10*mm,
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin,
                  doc.width, doc.height, id='main')
    doc.addPageTemplates([PageTemplate(id='main', frames=[frame])])

    usable_w = doc.width
    story = []

    # ═══════════════════════════════════════════════
    # ENCABEZADO: empresa | empleado
    # ═══════════════════════════════════════════════
    emp_name = ' '.join(filter(None, [
        worker.get('first_name',''), worker.get('other_names',''),
        worker.get('first_surname',''), worker.get('second_surname',''),
    ]))
    header_data = [
        [
            Paragraph(company.get('razon_social',''), sWhiteB),
            Paragraph('COMPROBANTE DE PAGO DE NOMINA', sCenterB),
            Paragraph('NIT: ' + company.get('nit',''), sRight),
        ],
        [
            Paragraph(company.get('address','') or '', sWhite),
            Paragraph('Periodo: ' + period.get('period_start','') + ' al ' + period.get('period_end',''), sCenter),
            Paragraph('Doc. Nomina No. ' + str(seq), sRight),
        ],
    ]
    header_style = TableStyle([
        ('BACKGROUND',  (0,0), (-1,-1), COL_PRIMARY),
        ('TEXTCOLOR',   (0,0), (-1,-1), COL_WHITE),
        ('FONTNAME',    (0,0), (-1,-1), bold_font),
        ('FONTSIZE',    (0,0), (-1,-1), 9),
        ('VALIGN',      (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING',  (0,0), (-1,-1), 5),
        ('BOTTOMPADDING',(0,0),(-1,-1), 5),
        ('LEFTPADDING', (0,0), (-1,-1), 7),
        ('RIGHTPADDING',(0,0), (-1,-1), 7),
        ('ROUNDEDCORNERS', [4, 4, 0, 0]),
    ])
    t = Table(header_data, colWidths=[usable_w*0.38, usable_w*0.35, usable_w*0.27])
    t.setStyle(header_style)
    story.append(t)

    # ── Fila empleado ────────────────────────────────────────────────────
    emp_row_data = [[
        Paragraph('<b>Empleado:</b> ' + emp_name, sNormal),
        Paragraph('<b>Doc.:</b> ' + worker.get('document_type','CC') + ' ' + worker.get('document_number',''), sNormal),
        Paragraph('<b>Cargo:</b> ' + worker.get('position', 'N/A'), sNormal),
        Paragraph('<b>Pago:</b> ' + period.get('payment_date',''), sRight),
    ]]
    t2 = Table(emp_row_data, colWidths=[usable_w*0.32, usable_w*0.24, usable_w*0.26, usable_w*0.18])
    t2.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), COL_LIGHT),
        ('TOPPADDING', (0,0), (-1,-1), 5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ('LEFTPADDING', (0,0), (-1,-1), 7),
        ('RIGHTPADDING', (0,0), (-1,-1), 7),
        ('BOX', (0,0), (-1,-1), 0.5, COL_BORDER),
    ]))
    story.append(t2)
    story.append(Spacer(1, 3*mm))

    # ═══════════════════════════════════════════════
    # COLUMNAS: DEVENGADOS | DEDUCCIONES
    # ═══════════════════════════════════════════════

    def section_title_row(text):
        return [Paragraph(text, ParagraphStyle('SH', fontName=bold_font, fontSize=8.5,
                           textColor=COL_WHITE, alignment=TA_CENTER))]

    def money_row(label, value, bold=False):
        st = sBold if bold else sNormal
        sr = sRightB if bold else sRight
        return [Paragraph(label, st), Paragraph(fmt_cop(value), sr)]

    # Construir lista de devengados
    dev_rows  = []
    basico    = devs.get('basico', {})
    if basico:
        sal = basico.get('sueldo_trabajado', 0)
        dias= basico.get('dias_trabajados', 30)
        dev_rows.append(['Salario básico (' + str(dias) + ' días)', fmt_cop(sal)])
    transporte = devs.get('transporte', {})
    if transporte:
        dev_rows.append(['Auxilio de transporte', fmt_cop(transporte.get('auxilio_transporte', 0))])
    vacaciones = devs.get('vacaciones', {})
    if vacaciones:
        vc  = vacaciones.get('vc',  {})
        vcp = vacaciones.get('vcp', {})
        if vc:  dev_rows.append(['Vacaciones (' + str(vc.get('cantidad',0)) + ' días)', fmt_cop(vc.get('pago',0))])
        if vcp: dev_rows.append(['Vac. compensadas', fmt_cop(vcp.get('pago',0))])
    prima = devs.get('prima', {})
    if prima: dev_rows.append(['Prima de servicios', fmt_cop(prima.get('pago',0))])
    cesantias = devs.get('cesantias', {})
    if cesantias:
        dev_rows.append(['Cesantías', fmt_cop(cesantias.get('pago',0))])
        if cesantias.get('pago_intereses', 0):
            dev_rows.append(['Intereses cesantías', fmt_cop(cesantias.get('pago_intereses',0))])
    comisiones = devs.get('comisiones', 0)
    if comisiones: dev_rows.append(['Comisiones', fmt_cop(comisiones)])
    horas_extras = devs.get('horas_extras', [])
    for he in horas_extras:
        dev_rows.append(['H.E. ' + he.get('tipo',''), fmt_cop(he.get('pago',0))])

    # Construir lista de deducciones
    ded_rows = []
    salud = deds.get('salud', {})
    if salud:
        pct = salud.get('porcentaje', 4)
        ded_rows.append(['Salud emp. (' + str(pct) + '%)', fmt_cop(salud.get('deduccion',0))])
    pension = deds.get('pension', {})
    if pension:
        pct = pension.get('porcentaje', 4)
        ded_rows.append(['Pensión emp. (' + str(pct) + '%)', fmt_cop(pension.get('deduccion',0))])
    ret_fuente = deds.get('retencion_fuente', 0)
    if ret_fuente: ded_rows.append(['Retención en la fuente', fmt_cop(ret_fuente)])
    fsp = deds.get('fsp', {})
    if fsp and fsp.get('deduccion', 0): ded_rows.append(['FSP', fmt_cop(fsp.get('deduccion',0))])
    for lib in deds.get('libranzas', []):
        ded_rows.append([lib.get('descripcion','Libranza'), fmt_cop(lib.get('deduccion',0))])

    # Normalizar a misma longitud
    max_r = max(len(dev_rows), len(ded_rows), 1)
    while len(dev_rows) < max_r: dev_rows.append(['', ''])
    while len(ded_rows) < max_r: ded_rows.append(['', ''])

    half = usable_w / 2 - 2*mm
    label_w, val_w = half * 0.60, half * 0.40

    # Tabla de devengados
    dev_table_data = [[section_title_row('DEVENGADOS'), '']]
    dev_table_data += [[Paragraph(r[0], sNormal), Paragraph(r[1], sRight)] for r in dev_rows]
    dev_table_data += [['', ''], [Paragraph('TOTAL DEVENGADOS', sBold), Paragraph(fmt_cop(total_d), sRightB)]]

    td = Table(dev_table_data, colWidths=[label_w, val_w])
    td.setStyle(TableStyle([
        ('SPAN',        (0,0), (-1,0)),
        ('BACKGROUND',  (0,0), (-1,0), COL_PRIMARY),
        ('TEXTCOLOR',   (0,0), (-1,0), COL_WHITE),
        ('FONTNAME',    (0,0), (-1,0), bold_font),
        ('FONTSIZE',    (0,0), (-1,0), 8.5),
        ('ALIGN',       (0,0), (-1,0), 'CENTER'),
        ('TOPPADDING',  (0,0), (-1,-1), 3),
        ('BOTTOMPADDING',(0,0),(-1,-1), 3),
        ('LEFTPADDING', (0,0), (-1,-1), 5),
        ('RIGHTPADDING',(0,0), (-1,-1), 5),
        ('ROWBACKGROUNDS', (0,1), (-1,-2), [COL_WHITE, COL_LIGHT]),
        ('BACKGROUND',  (0,-1), (-1,-1), colors.Color(.9,.95,.9)),
        ('FONTNAME',    (0,-1), (-1,-1), bold_font),
        ('BOX',         (0,0), (-1,-1), 0.5, COL_BORDER),
        ('INNERGRID',   (0,1), (-1,-1), 0.3, COL_BORDER),
    ]))

    # Tabla de deducciones
    ded_table_data = [[section_title_row('DEDUCCIONES'), '']]
    ded_table_data += [[Paragraph(r[0], sNormal), Paragraph(r[1], sRight)] for r in ded_rows]
    ded_table_data += [['', ''], [Paragraph('TOTAL DEDUCCIONES', sBold), Paragraph(fmt_cop(total_de), sRightB)]]

    tde = Table(ded_table_data, colWidths=[label_w, val_w])
    tde.setStyle(TableStyle([
        ('SPAN',        (0,0), (-1,0)),
        ('BACKGROUND',  (0,0), (-1,0), COL_SECONDARY),
        ('TEXTCOLOR',   (0,0), (-1,0), COL_WHITE),
        ('FONTNAME',    (0,0), (-1,0), bold_font),
        ('FONTSIZE',    (0,0), (-1,0), 8.5),
        ('ALIGN',       (0,0), (-1,0), 'CENTER'),
        ('TOPPADDING',  (0,0), (-1,-1), 3),
        ('BOTTOMPADDING',(0,0),(-1,-1), 3),
        ('LEFTPADDING', (0,0), (-1,-1), 5),
        ('RIGHTPADDING',(0,0), (-1,-1), 5),
        ('ROWBACKGROUNDS', (0,1), (-1,-2), [COL_WHITE, COL_LIGHT]),
        ('BACKGROUND',  (0,-1), (-1,-1), colors.Color(.98,.92,.92)),
        ('FONTNAME',    (0,-1), (-1,-1), bold_font),
        ('BOX',         (0,0), (-1,-1), 0.5, COL_BORDER),
        ('INNERGRID',   (0,1), (-1,-1), 0.3, COL_BORDER),
    ]))

    # Combinar en tabla de dos columnas
    combined = Table([[td, tde]], colWidths=[half, half], hAlign='CENTER')
    combined.setStyle(TableStyle([
        ('VALIGN',  (0,0), (-1,-1), 'TOP'),
        ('LEFTPADDING',  (0,0), (-1,-1), 0),
        ('RIGHTPADDING', (0,0), (-1,-1), 0),
        ('TOPPADDING',   (0,0), (-1,-1), 0),
        ('BOTTOMPADDING',(0,0), (-1,-1), 0),
        ('ALIGN', (1,0), (1,0), 'RIGHT'),
    ]))
    story.append(combined)
    story.append(Spacer(1, 3*mm))

    # ═══════════════════════════════════════════════
    # NETO A PAGAR + CUNE
    # ═══════════════════════════════════════════════
    neto_data = [[
        Paragraph('NETO A PAGAR:', ParagraphStyle('NL', fontName=bold_font, fontSize=13,
                    textColor=COL_PRIMARY)),
        Paragraph(fmt_cop(total_p), ParagraphStyle('NV', fontName=bold_font, fontSize=14,
                    textColor=COL_PRIMARY, alignment=TA_RIGHT)),
    ]]
    tn = Table(neto_data, colWidths=[usable_w*0.55, usable_w*0.45])
    tn.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), colors.Color(.93,.97,.93)),
        ('BOX', (0,0), (-1,-1), 1, COL_PRIMARY),
        ('TOPPADDING', (0,0), (-1,-1), 6),
        ('BOTTOMPADDING', (0,0), (-1,-1), 6),
        ('LEFTPADDING', (0,0), (-1,-1), 10),
        ('RIGHTPADDING', (0,0), (-1,-1), 10),
        ('ROUNDEDCORNERS', [4,4,4,4]),
    ]))
    story.append(tn)

    if cune:
        story.append(Spacer(1, 2*mm))
        story.append(Paragraph(
            '<b>CUNE:</b> ' + cune,
            ParagraphStyle('CUNE', fontName=reg_font, fontSize=6.5,
                           textColor=colors.Color(.35,.35,.38), wordWrap='LTR'),
        ))

    # ── Pie de página ────────────────────────────────────────────────────
    story.append(Spacer(1, 2*mm))
    story.append(HRFlowable(width='100%', thickness=0.5, color=COL_BORDER))
    story.append(Spacer(1, 1*mm))
    story.append(Paragraph(
        'Generado el ' + datetime.now().strftime('%d/%m/%Y %H:%M') + ' | ' +
        company.get('razon_social','') + ' | Nomina Electronica DIAN Res. 000013/2021',
        ParagraphStyle('Footer', fontName=reg_font, fontSize=6.5,
                       textColor=colors.Color(.5,.5,.55), alignment=TA_CENTER),
    ))

    doc.build(story)
    return buf.getvalue()


# ── CLI ───────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'success': False, 'error': 'Uso: colilla_cli.py generate-colilla <json>'}))
        sys.exit(1)

    operation = sys.argv[1]
    if operation == 'generate-colilla':
        try:
            payload = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
            pdf_bytes = generate_colilla(payload)
            pdf_b64   = base64.b64encode(pdf_bytes).decode('ascii')
            print(json.dumps({'success': True, 'pdf_base64': pdf_b64}))
        except Exception as e:
            print(json.dumps({'success': False, 'error': str(e)}))
    else:
        print(json.dumps({'success': False, 'error': 'Operacion desconocida: ' + operation}))
