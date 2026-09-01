"""
Representación Gráfica PDF — Factura Electrónica DIAN Colombia v2
Diseño Bajo en Tinta: identidad por bordes, tipografía y acento de color.
Fondos blancos — mínimo consumo de tinta — máxima elegancia.

Colores configurables por empresa:
  primary_color  → color oscuro  (textos, bordes fuertes)        default #1a0a2e
  secondary_color→ color de acento (bordes izquierdos, labels)   default #7B2D8B
"""
from __future__ import annotations
import base64, io, json, os
from datetime import datetime
from typing import Any, Dict, List, Optional

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch, mm
from reportlab.lib.utils import ImageReader
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, HRFlowable,
    Image, Paragraph, Spacer, Table, TableStyle,
)
from reportlab.lib.enums import TA_CENTER, TA_RIGHT, TA_JUSTIFY, TA_LEFT
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
try:
    import qrcode
    _QRCODE = True
except ImportError:
    _QRCODE = False

try:
    from PIL import Image as PILImage
    _PIL = True
except ImportError:
    _PIL = False


def _register_fonts():
    candidates = [
        (r'C:\Windows\Fonts\arial.ttf',    'NeuReg'),
        (r'C:\Windows\Fonts\arialbd.ttf',  'NeuBold'),
        (r'C:\Windows\Fonts\calibri.ttf',  'NeuReg'),
        (r'C:\Windows\Fonts\calibrib.ttf', 'NeuBold'),
        (r'C:\Windows\Fonts\segoeui.ttf',  'NeuReg'),
        (r'C:\Windows\Fonts\segoeuib.ttf', 'NeuBold'),
        ('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',      'NeuReg'),
        ('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'NeuBold'),
    ]
    reg = bold = False
    for fpath, name in candidates:
        if os.path.exists(fpath):
            try:
                pdfmetrics.registerFont(TTFont(name, fpath))
                if name == 'NeuReg':  reg  = True
                if name == 'NeuBold': bold = True
            except Exception:
                pass
        if reg and bold:
            break
    return ('NeuReg' if reg else 'Helvetica', 'NeuBold' if bold else 'Helvetica-Bold')

_FONT_REG, _FONT_BOLD = _register_fonts()

_AKRIBEIA_LOGO_BYTES = None
try:
    _akr_path = os.path.normpath(os.path.join(
        os.path.dirname(__file__),
        '..', '..', '..', '..', '..',
        'frontend', 'src', 'assets', 'images', 'Logo_Akribeia_Factura.png'
    ))
    with open(_akr_path, 'rb') as _f:
        _AKRIBEIA_LOGO_BYTES = _f.read()
except Exception:
    pass

DIAN_QR_TEST = "https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey="
DIAN_QR_PROD = "https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey="
PAYMENT_MEANS_LABELS  = {'1': 'Contado', '2': 'Crédito'}
PAYMENT_METHOD_LABELS = {'10': 'Efectivo', '20': 'Cheque', '42': 'Transferencia Bancaria',
    '47': 'Débito Automático', '48': 'Tarjeta de Crédito', '49': 'Tarjeta Débito',
    '71': 'Bonos', '72': 'Vales', 'ZZZ': 'Otro'}
UNIT_CODE_LABELS = {
    'EA': 'Und.', 'NIU': 'Und.', 'KGM': 'Kg', 'GRM': 'g', 'LTR': 'L',
    'MTR': 'm', 'MTK': 'm²', 'MTQ': 'm³', 'HUR': 'h', 'DAY': 'día',
    'MON': 'mes', 'ANN': 'año', 'SET': 'Set', 'BX': 'Caja',
    '94': 'N/A',   # No aplica — usado en PGP/capitación
    'ZZ': 'N/A',
}

TAX_TYPE_LABELS = {
    '01': 'IVA', '02': 'INC', '03': 'ICA', '04': 'INC',
    '05': 'INC', '06': 'INC', '07': 'INC',
    'ZA': 'Excl.', 'ZY': 'Excl.',
}

DEFAULT_DARK   = '#1a0a2e'
DEFAULT_ACCENT = '#7B2D8B'


def _darken(hex_color, factor=0.6):
    h = hex_color.lstrip('#')
    r,g,b = int(h[0:2],16),int(h[2:4],16),int(h[4:6],16)
    return '#{:02x}{:02x}{:02x}'.format(int(r*factor),int(g*factor),int(b*factor))

def _lighten(hex_color, factor=0.85):
    h = hex_color.lstrip('#')
    r,g,b = int(h[0:2],16),int(h[2:4],16),int(h[4:6],16)
    return '#{:02x}{:02x}{:02x}'.format(min(255,int(r+(255-r)*factor)),min(255,int(g+(255-g)*factor)),min(255,int(b+(255-b)*factor)))

def _hex_rgb(hex_color):
    h = hex_color.lstrip('#')
    return int(h[0:2],16),int(h[2:4],16),int(h[4:6],16)

def _fmt_cur(v):
    try: v=float(v or 0)
    except: v=0.0
    return "${:,.2f}".format(v).replace(",","X").replace(".","," ).replace("X",".")

def _fmt_num(v,d=2):
    try: v=float(v or 0)
    except: v=0.0
    return ("{:,.%df}"%d).format(v).replace(",","X").replace(".","," ).replace("X",".")

def _get_qr(cufe, env="test"):
    if not cufe or not _QRCODE: return None
    try:
        base = DIAN_QR_PROD if env in ("1", "production") else DIAN_QR_TEST
        qr = qrcode.QRCode(version=1,error_correction=qrcode.constants.ERROR_CORRECT_L,box_size=4,border=1)
        qr.add_data(base+cufe); qr.make(fit=True)
        img = qr.make_image(fill_color="#1a0a2e",back_color="white")
        buf = io.BytesIO(); img.save(buf,format="PNG"); return buf.getvalue()
    except: return None

def _safe_str(s):
    if not isinstance(s,str): return str(s) if s is not None else ''
    try: return s.encode('latin-1').decode('utf-8')
    except: return s

def _extract_signature(signed_xml_b64):
    try:
        from xml.etree import ElementTree as ET
        xml_bytes = base64.b64decode(signed_xml_b64)
        root = ET.fromstring(xml_bytes.decode('utf-8'))
        elem = root.find('.//{http://www.w3.org/2000/09/xmldsig#}SignatureValue')
        if elem is not None and elem.text: return ''.join(elem.text.split())
    except: pass
    return ''

def _numero_a_letras(n):
    n = int(round(abs(float(n or 0))))
    if n == 0: return 'Cero Pesos'
    def _lt1000(x):
        if x<=0: return ''
        if x==100: return 'Cien'
        _U=[''  ,'Uno','Dos','Tres','Cuatro','Cinco','Seis','Siete','Ocho','Nueve',
             'Diez','Once','Doce','Trece','Catorce','Quince',
             'Dieciséis','Diecisiete','Dieciocho','Diecinueve',
             'Veinte','Veintiuno','Veintidós','Veintitrés','Veinticuatro',
             'Veinticinco','Veintiséis','Veintisiete','Veintiocho','Veintinueve']
        _D=[''  ,''  ,'Veinte','Treinta','Cuarenta','Cincuenta','Sesenta','Setenta','Ochenta','Noventa']
        _C=[''  ,'Ciento','Doscientos','Trescientos','Cuatrocientos','Quinientos','Seiscientos','Setecientos','Ochocientos','Novecientos']
        parts=[]; c,r=x//100,x%100
        if c: parts.append(_C[c])
        if r<=29:
            if r: parts.append(_U[r])
        else:
            d,u=r//10,r%10
            parts.append(_D[d]+(' y '+_U[u] if u else ''))
        return ' '.join(p for p in parts if p)
    parts=[]
    b=min(n//1_000_000_000,999); n%=1_000_000_000
    if b==1: parts.append('Mil Millones')
    elif b>1: parts.append(_lt1000(b)+' Mil Millones')
    m=n//1_000_000; n%=1_000_000
    if m==1: parts.append('Un Millón')
    elif m>1: parts.append(_lt1000(m)+' Millones')
    t=n//1000; n%=1000
    if t==1: parts.append('Mil')
    elif t>1: parts.append(_lt1000(t)+' Mil')
    if n>0: parts.append(_lt1000(n))
    return ' '.join(parts)+' Pesos'

def _make_watermark(logo_bytes, opacity=0.06):
    if not _PIL or not logo_bytes: return None
    try:
        img = PILImage.open(io.BytesIO(logo_bytes)).convert("RGBA")
        iw,ih = img.size
        if iw>220: img=img.resize((220,int(ih*220/iw)),PILImage.LANCZOS)
        r,g,b,a = img.split(); a=a.point(lambda x:int(x*opacity)); img.putalpha(a)
        buf=io.BytesIO(); img.save(buf,format="PNG"); return buf.getvalue()
    except: return None



def _luminance(hex_color):
    """Relative luminance 0-1 for a hex color."""
    h = hex_color.lstrip('#')
    vals = [int(h[i:i+2], 16) / 255.0 for i in (0, 2, 4)]
    rgb = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in vals]
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]

def _text_on_bg(hex_bg):
    """Return '#FFFFFF' or '#1A1028' depending on bg luminance."""
    return '#FFFFFF' if _luminance(hex_bg) < 0.35 else '#1A1028'

def _subtle_on_bg(hex_bg):
    """Return a slightly dimmed version of the contrast text color."""
    if _luminance(hex_bg) < 0.35:
        return '#BDB0CC'   # blanco suavizado sobre fondo oscuro
    return '#4A3F5C'       # gris oscuro sobre fondo claro

class _PageDec:
    def __init__(self,company_name,doc_title,doc_number,env_label,c_dark,c_acc,
                 logo_bytes=None,wm_bytes=None,company_nit='',akribeia_logo_bytes=None):
        self.company_name=company_name; self.company_nit=company_nit
        self.doc_title=doc_title; self.doc_number=doc_number; self.env_label=env_label
        self.c_dark=c_dark; self.c_acc=c_acc; self.logo_bytes=logo_bytes; self.wm_bytes=wm_bytes
        self.akribeia_logo_bytes=akribeia_logo_bytes

    def __call__(self,canv,doc):
        canv.saveState()
        pw,ph=letter; hh=64; ah=4; mrg=22
        canv.setFillColor(colors.white)
        canv.rect(0,ph-hh,pw,hh,fill=1,stroke=0)
        r0,g0,b0=_hex_rgb(self.c_acc); steps=160; half=steps//2
        for i in range(steps):
            t=(i/half if i<half else (steps-i)/half)
            alpha=t**1.2
            rv=r0+(255-r0)*(1-alpha); gv=g0+(255-g0)*(1-alpha); bv=b0+(255-b0)*(1-alpha)
            canv.setFillColorRGB(rv/255,gv/255,bv/255)
            canv.rect(pw*i/steps,ph-hh-ah,pw/steps+1,ah,fill=1,stroke=0)

        canv.setStrokeColor(colors.HexColor(self.c_acc)); canv.setLineWidth(0.8)
        canv.line(0,ph-0.5,pw,ph-0.5)
        av_cy=ph-hh+hh/2; av_cx=mrg+24
        # Calcular ancho del grupo (logo + gap + texto) para centrar en la pagina
        logo_w=100; gap=14
        title_w=canv.stringWidth(self.doc_title.upper(),_FONT_REG,6.5)
        number_w=canv.stringWidth(self.doc_number,_FONT_BOLD,16)
        text_blk_w=max(title_w,number_w)
        group_w=logo_w+gap+text_blk_w
        start_x=(pw-group_w)/2
        if self.logo_bytes:
            try:
                reader=ImageReader(io.BytesIO(self.logo_bytes))
                canv.drawImage(reader,start_x,av_cy-16,width=logo_w,height=32,preserveAspectRatio=True,anchor='w',mask='auto')
                txt_x=start_x+logo_w+gap
            except:
                self._draw_avatar(canv,av_cx,av_cy); txt_x=mrg+52
        else:
            self._draw_avatar(canv,av_cx,av_cy); txt_x=mrg+52
        # Centrar verticalmente el bloque titulo+numero respecto al centro del header
        canv.setFont(_FONT_REG,6.5); canv.setFillColor(colors.HexColor('#8A7A9A'))
        canv.drawString(txt_x,av_cy+8,self.doc_title.upper())
        canv.setFont(_FONT_BOLD,16); canv.setFillColor(colors.HexColor(self.c_acc))
        canv.drawString(txt_x,av_cy-10,self.doc_number)
        if self.wm_bytes:
            try:
                ww,wh=170,80; wx=(pw-ww)/2; wy=32
                canv.drawImage(ImageReader(io.BytesIO(self.wm_bytes)),wx,wy,width=ww,height=wh,preserveAspectRatio=True,mask='auto')
            except: pass
        canv.setStrokeColor(colors.HexColor('#D8D0E8')); canv.setLineWidth(0.4)
        canv.line(mrg,22,pw-mrg,22); canv.setFont(_FONT_REG,6); canv.setFillColorRGB(0.58,0.52,0.65)
        # Linea 1: texto
        canv.drawString(mrg,15,f'Facturación electrónica - Software propio {(self.company_name or "")[:35]}')
        # Linea 2: logo Akribeia
        if self.akribeia_logo_bytes:
            try:
                canv.drawImage(ImageReader(io.BytesIO(self.akribeia_logo_bytes)),mrg,2,width=40,height=11,preserveAspectRatio=True,mask='auto')
            except: pass
        canv.drawRightString(pw-mrg,12,f'Pág. {doc.page}')
        canv.restoreState()

    def _draw_avatar(self,canv,cx,cy):
        # Avatar circular con color de acento — mantiene identidad de marca
        canv.setFillColor(colors.HexColor(self.c_acc)); canv.circle(cx,cy,18,fill=1,stroke=0)
        canv.setFont(_FONT_BOLD,14); canv.setFillColor(colors.white)
        canv.drawCentredString(cx,cy-5,self.company_name[0].upper() if self.company_name else 'N')

    def _draw_company_text(self,canv,name_x,cy):
        # Texto en colores de marca sobre fondo blanco
        canv.setFont(_FONT_BOLD,10); canv.setFillColor(colors.HexColor(self.c_dark))
        canv.drawString(name_x,cy+4,(self.company_name or '')[:24])
        canv.setFont(_FONT_REG,7); canv.setFillColor(colors.HexColor('#6B5F7A'))
        if self.company_nit: canv.drawString(name_x,cy-9,f'NIT: {self.company_nit}')


def _build_styles(c_dark,c_acc):
    s=getSampleStyleSheet(); cd=colors.HexColor(c_dark); ca=colors.HexColor(c_acc)
    ca_l=colors.HexColor(_lighten(c_acc,0.90)); gray_d=colors.HexColor('#3D3550')
    gray_m=colors.HexColor('#6B5F7A'); white=colors.white; black=colors.HexColor('#1A1028')
    def _add(name,**kw): s.add(ParagraphStyle(name=name,**kw))
    _add('SecHdr',  fontSize=7.5, fontName=_FONT_BOLD,textColor=ca, spaceBefore=0,spaceAfter=2,leading=10,letterSpacing=0.3)
    _add('Sm',      fontSize=8.5, fontName=_FONT_REG, textColor=black,leading=12)
    _add('Tiny',    fontSize=7.5, fontName=_FONT_REG, textColor=gray_d,leading=10)
    _add('CufeS',   fontSize=6.5, fontName='Courier',textColor=gray_d,leading=9,alignment=TA_CENTER,wordWrap='CJK')
    _add('Legal',   fontSize=6.5, fontName=_FONT_REG, textColor=gray_m,leading=9,alignment=TA_JUSTIFY)
    _add('TotLbl',  fontSize=9,   fontName=_FONT_BOLD,textColor=gray_d,alignment=TA_RIGHT)
    _add('TotVal',  fontSize=9,   fontName=_FONT_BOLD,textColor=cd,   alignment=TA_RIGHT)
    _add('TotBoxLbl',fontSize=9.5,fontName=_FONT_BOLD,textColor=black, alignment=TA_LEFT)
    _add('TotBoxVal',fontSize=14, fontName=_FONT_BOLD,textColor=ca,   alignment=TA_RIGHT)
    _add('SonS',    fontSize=8.5, fontName=_FONT_REG, textColor=cd,   spaceBefore=1,spaceAfter=1,leading=12)
    _add('FirmaCell',fontSize=6.5,fontName='Courier',textColor=gray_d,leading=9,wordWrap='CJK')
    _add('MetaSm',  fontSize=8.5, fontName=_FONT_REG, textColor=cd,   leading=11)
    _add('ResoS',   fontSize=7,   fontName=_FONT_REG, textColor=gray_m, leading=10, alignment=TA_RIGHT)
    _add('NoteHdr', fontSize=7.5, fontName=_FONT_BOLD, textColor=ca,  spaceBefore=0, spaceAfter=2, leading=10)
    _add('NoteS',   fontSize=8.5, fontName=_FONT_REG, textColor=black, leading=12, alignment=TA_JUSTIFY)
    return s


def build_dian_invoice_pdf(payload,cufe,environment="test",signed_filename=None,
        issue_datetime=None,document_type="invoice",billing_reference=None,
        concepto_code=None,concepto_desc=None,primary_color=None,secondary_color=None,
        payment_means_id=None,payment_method_id=None,signed_xml_b64=None,logo_base64=None):
    """Genera PDF factura DIAN v2 — diseño bajo en tinta, identidad por bordes y tipografía."""
    try:
        c_dark=(primary_color or DEFAULT_DARK).strip(); c_acc=(secondary_color or DEFAULT_ACCENT).strip()
        c_acc_l=_lighten(c_acc,0.90); c_acc_l2=_lighten(c_acc,0.96)
        c_dark_l=_lighten(c_dark,0.93); c_border=_lighten(c_acc,0.70)
        cd_obj=colors.HexColor(c_dark); ca_obj=colors.HexColor(c_acc)
        cal_obj=colors.HexColor(c_acc_l); cal2_obj=colors.HexColor(c_acc_l2)
        cdl_obj=colors.HexColor(c_dark_l); cbr_obj=colors.HexColor(c_border)
        c_dark_bdr=colors.HexColor(_lighten(c_dark,0.78))

        logo_bytes=None
        if logo_base64:
            try: logo_bytes=base64.b64decode(logo_base64)
            except: pass
        wm_bytes=_make_watermark(logo_bytes) if logo_bytes else None

        issuer  =payload.get("issuer",  {}); customer=payload.get("customer",{})
        lines_d =payload.get("lines",   []); prefix  =payload.get("prefix","SETP")
        number  =payload.get("number",  0) ; issue_date=payload.get("issue_date","")
        soft_id =payload.get("software_id",""); reso_num=payload.get("resolution_number","")
        reso_pfx=payload.get("resolution_prefix",prefix)
        hora=issue_datetime or datetime.now().strftime("%Y-%m-%dT%H:%M:%S-05:00")
        hora_disp=hora[:19] if len(hora)>=19 else hora
        company_name=_safe_str(issuer.get('name',''))
        is_nc=document_type=="credit_note"; is_nd=document_type=="debit_note"
        is_compra=document_type=="compra"; is_ds=document_type=="ds"
        if is_nc:     doc_title="Nota Crédito Electrónica";  cufe_label="CUDE"
        elif is_nd:   doc_title="Nota Débito Electrónica";   cufe_label="CUDE"
        elif is_compra: doc_title="Factura de Compra";       cufe_label="CUFE"
        elif is_ds:   doc_title="Documento Soporte";         cufe_label="CUDS"
        else:         doc_title="Factura Electrónica de Venta"; cufe_label="CUFE"
        env_label="PRODUCCIÓN" if environment=="1" else "HABILITACIÓN"
        reso_from  = payload.get('resolution_from')
        reso_to    = payload.get('resolution_to')
        note_text  = _safe_str(payload.get('note','') or '')
        doc_number=f"{prefix}{number}"
        means_lbl =PAYMENT_MEANS_LABELS.get( str(payment_means_id  or ''),payment_means_id  or '—')
        method_lbl=PAYMENT_METHOD_LABELS.get(str(payment_method_id or ''),payment_method_id or '—')

        s=_build_styles(c_dark,c_acc)
        dec=_PageDec(company_name=company_name,doc_title=doc_title,doc_number=doc_number,
                     env_label=env_label,c_dark=c_dark,c_acc=c_acc,
                     logo_bytes=logo_bytes,wm_bytes=wm_bytes,
                     company_nit=_safe_str(issuer.get('nit','')),
                     akribeia_logo_bytes=_AKRIBEIA_LOGO_BYTES)
        buf=io.BytesIO()
        doc=BaseDocTemplate(buf,pagesize=letter,rightMargin=0.5*inch,leftMargin=0.5*inch,
                            topMargin=1.05*inch,bottomMargin=0.55*inch)
        frame=Frame(doc.leftMargin,doc.bottomMargin,doc.width,doc.height,id='main')
        doc.addPageTemplates([PageTemplate(id='N',frames=[frame],onPage=dec)])
        story=[Spacer(1,2*mm)]

        # ── EMISOR / ADQUIRIENTE ──────────────────────────────────────────────
        _DOC_TYPE_LABELS = {
            "11": "RC", "12": "TI", "13": "CC", "21": "TE", "22": "CE",
            "31": "NIT", "41": "PAS", "42": "DIE", "47": "PEP", "50": "NIT EXT", "91": "NUIP",
        }
        def _party_html(role_label,d,label_color,extra=""):
            name=_safe_str(d.get('name','')); city=_safe_str(d.get('city_name',''))
            address=_safe_str(d.get('address',''))
            eps_nombre=_safe_str(d.get('eps_nombre',''))
            _addr_clean = address if address and address not in ("Carrera 1 # 1-1", "") else ""
            addr_t = (f", {_addr_clean}" if city and _addr_clean else _addr_clean)
            lc=label_color.lstrip('#')
            doc_code = str(d.get("document_type", "31"))
            doc_label = _DOC_TYPE_LABELS.get(doc_code, "NIT")
            parts=[f'<font size="7" color="#{lc}"><b>{role_label.upper()}</b></font>',
                   f'<b><font size="11">{name}</font></b>',
                   f'<font size="8.5" color="#6B5F7A">{doc_label}: {d.get("nit","")}</font>']
            # Mostrar EPS asociada si existe (copago), o ciudad/dirección si hay datos
            if eps_nombre:
                parts.append(f'<font size="8.5" color="#6B5F7A">EPS: {eps_nombre}</font>')
            elif city or addr_t:
                parts.append(f'<font size="8.5" color="#6B5F7A">{city}{addr_t}</font>')
            if extra: parts.append(f'<font size="8.5" color="#6B5F7A">{extra}</font>')
            return "<br/>".join(parts)
        extra_issuer=""
        # Para Documento Soporte la ley exige estas etiquetas exactas (Res. DIAN 0167/2021)
        _role_emisor    = "Emisor (Obligado a Facturar)"   if is_ds else "Emisor"
        _role_adquirien = "Proveedor (No Obligado a Facturar)" if is_ds else "Adquiriente"
        party_t=Table([[Paragraph(_party_html(_role_emisor,issuer,c_acc,extra_issuer),s['Sm']),
                        Paragraph(_party_html(_role_adquirien,customer,c_dark,""),s['Sm'])]],
                      colWidths=[3.4*inch,3.4*inch])
        party_t.setStyle(TableStyle([
            ('BACKGROUND',(0,0),(-1,-1),colors.white),
            ('LINEBEFORE',(0,0),(0,-1),3.5,ca_obj),('LINEBEFORE',(1,0),(1,-1),3.5,cd_obj),
            ('BOX',(0,0),(0,0),0.5,cbr_obj),('BOX',(1,0),(1,0),0.5,c_dark_bdr),
            ('VALIGN',(0,0),(-1,-1),'TOP'),('TOPPADDING',(0,0),(-1,-1),9),
            ('BOTTOMPADDING',(0,0),(-1,-1),9),('LEFTPADDING',(0,0),(-1,-1),10),('RIGHTPADDING',(0,0),(-1,-1),8)]))
        story.append(party_t); story.append(Spacer(1,2*mm))

        # ── META BAR ─────────────────────────────────────────────────────────
        ca_h=c_acc.lstrip('#')
        def _meta_cell(lbl,val):
            return Paragraph(
                f'<font size="6.5" color="#{ca_h}"><b>{lbl.upper()}</b></font><br/>'
                f'<font size="9">{val}</font>',s['MetaSm'])
        meta_t=Table([[
                _meta_cell('Fecha',issue_date),
                _meta_cell('Hora',hora_disp),
                _meta_cell('Forma de pago',means_lbl),
                _meta_cell('Medio de pago',method_lbl)]],
                     colWidths=[1.5*inch,2.1*inch,1.6*inch,1.6*inch])
        meta_t.setStyle(TableStyle([
            ('BACKGROUND',(0,0),(-1,-1),colors.white),
            ('BOX',(0,0),(-1,-1),0.5,cbr_obj),
            ('LINEABOVE',(0,0),(-1,0),2.5,ca_obj),
            ('INNERGRID',(0,0),(-1,-1),0.4,colors.HexColor('#E8E0F5')),
            ('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6),
            ('LEFTPADDING',(0,0),(-1,-1),10),('VALIGN',(0,0),(-1,-1),'MIDDLE')]))
        story.append(meta_t)
        if reso_from or reso_to:
            _rp=[f"Resoluci\u00f3n DIAN N\u00b0 {reso_num}"]
            if reso_pfx: _rp.append(f"Prefijo {reso_pfx}")
            _rp.append(f"Rango autorizado: {int(reso_from):,} \u2013 {int(reso_to):,}".replace(',','.'))
            reso_str="  \u00b7  ".join(_rp)
            reso_t=Table([[Paragraph(reso_str,s['ResoS'])]],colWidths=[6.8*inch])
            reso_t.setStyle(TableStyle([
                ("BACKGROUND",(0,0),(0,0),colors.white),
                ("BOX",(0,0),(0,0),0.3,cbr_obj),
                ("TOPPADDING",(0,0),(0,0),3),("BOTTOMPADDING",(0,0),(0,0),3),("RIGHTPADDING",(0,0),(0,0),8)]))
            story.append(reso_t)
        story.append(Spacer(1,5*mm))

        # ── SALUD (opcional) ──────────────────────────────────────────────────
        health=payload.get("health")
        if health:
            def _hf(lbl,val): return f"<b>{lbl}:</b> {val}" if val else ""
            regimen=health.get("regimen",""); op=health.get("operation","")
            prest=health.get("cod_prestador",""); contrato=health.get("contrato_numero","")
            modalidad=health.get("modalidad_pago",""); cobertura=health.get("tipo_cobertura","")
            p_ini=payload.get("periodo_inicio") or health.get("periodo_inicio","")
            p_fin=health.get("periodo_fin",""); v_upc=health.get("valor_upc",0)
            if not p_ini and lines_d:
                import re; m=re.search(r'(\d{4}-\d{2}-\d{2})',lines_d[0].get("description",""))
                if m: p_ini=m.group(1)
            periodo_str=f"{p_ini} → {p_fin}" if p_ini and p_fin else (p_ini or p_fin or "")
            fields=[f for f in [_hf("Régimen",regimen.capitalize() if regimen else ""),
                _hf("Tipo operación",op),_hf("Cód. prestador",prest),_hf("N° contrato",contrato),
                _hf("Modalidad",modalidad),_hf("Cobertura",cobertura),_hf("Período",periodo_str),
                _hf("Valor UPC",_fmt_cur(float(v_upc)) if v_upc else "")] if f]
            if fields:
                story.append(Paragraph("DATOS SALUD",s['SecHdr']))
                story.append(HRFlowable(width='100%',thickness=0.4,color=ca_obj,spaceAfter=3,spaceBefore=1))
                pairs=[]
                for i in range(0,len(fields),2):
                    pairs.append([Paragraph(fields[i],s['Sm']),Paragraph(fields[i+1] if i+1<len(fields) else "",s['Sm'])])
                ht=Table(pairs,colWidths=[3.4*inch,3.4*inch])
                ht.setStyle(TableStyle([('TOPPADDING',(0,0),(-1,-1),3),('BOTTOMPADDING',(0,0),(-1,-1),3),
                    ('LEFTPADDING',(0,0),(-1,-1),6),('RIGHTPADDING',(0,0),(-1,-1),6),
                    ('BACKGROUND',(0,0),(-1,-1),colors.white),('BOX',(0,0),(-1,-1),0.5,cbr_obj),
                    ('INNERGRID',(0,0),(-1,-1),0.3,colors.HexColor('#F0EBF8'))]))
                story.append(ht); story.append(Spacer(1,2*mm))
            # ── Tabla de pacientes (por evento) ───────────────────────────────
            pacientes_info=health.get("pacientes_info") or []
            if pacientes_info:
                story.append(Paragraph("DATOS USUARIO",s['SecHdr']))
                story.append(HRFlowable(width='100%',thickness=0.4,color=ca_obj,spaceAfter=3,spaceBefore=1))
                pac_hdr=[Paragraph(f"<b>{h}</b>",s['Sm']) for h in ['#','Documento','Nombre']]
                pac_rows=[pac_hdr]
                for idx_p,pi in enumerate(pacientes_info,1):
                    nom=pi.get("nombre","") or "—"; p_doc=pi.get("doc","") or "—"
                    pac_rows.append([Paragraph(str(idx_p),s['Tiny']),Paragraph(p_doc,s['Tiny']),Paragraph(nom,s['Tiny'])])
                pac_t=Table(pac_rows,colWidths=[0.3*inch,2.2*inch,4.3*inch])
                pac_t.setStyle(TableStyle([
                    ('BACKGROUND',(0,0),(-1,0),colors.HexColor('#F0EBF8')),
                    ('FONTNAME',(0,0),(-1,0),'Helvetica-Bold'),
                    ('BOX',(0,0),(-1,-1),0.5,cbr_obj),
                    ('INNERGRID',(0,0),(-1,-1),0.3,colors.HexColor('#F0EBF8')),
                    ('TOPPADDING',(0,0),(-1,-1),3),('BOTTOMPADDING',(0,0),(-1,-1),3),
                    ('LEFTPADDING',(0,0),(-1,-1),6),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#FAF8FF')])]))
                story.append(pac_t); story.append(Spacer(1,4*mm))

        # ── REFERENCIA NC/ND ──────────────────────────────────────────────────
        CONCEPTO_NC={"1":"Devolución parcial","2":"Anulación de factura","3":"Rebaja o descuento","4":"Ajuste de precio","5":"Otros"}
        CONCEPTO_ND={"1":"Intereses","2":"Gastos por cobrar","3":"Cambio del valor","4":"Otros"}
        if (is_nc or is_nd) and billing_reference:
            ref_id=billing_reference.get("invoice_id",""); ref_date=billing_reference.get("invoice_date","")
            ref_cufe=billing_reference.get("invoice_uuid","")
            code=concepto_code or ""; desc=concepto_desc or (CONCEPTO_NC if is_nc else CONCEPTO_ND).get(code,"")
            conc_txt=f"{code} – {desc}" if code else desc
            ref_lbl="FACTURA CORREGIDA" if is_nc else "FACTURA DE REFERENCIA"
            orange=colors.HexColor('#E65100'); orange_l=colors.HexColor('#FFF3E0')
            ref_data=[[Paragraph(f"<b>{ref_lbl}</b>",s['SecHdr']),""],
                      [Paragraph(f"<b>Número:</b> {ref_id}",s['Sm']),Paragraph(f"<b>Fecha:</b> {ref_date}",s['Sm'])]]
            if ref_cufe: ref_data.append([Paragraph(f"<b>CUFE:</b> <font face='Courier' size='5.5'>{ref_cufe}</font>",s['Sm']),""])
            if conc_txt: ref_data.append([Paragraph(f"<b>Concepto:</b> {conc_txt}",s['Sm']),""])
            ref_t=Table(ref_data,colWidths=[3.4*inch,3.4*inch])
            ref_t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),orange_l),('SPAN',(0,0),(-1,0)),
                ('SPAN',(0,2),(-1,2)),('SPAN',(0,3),(-1,3)),('BOX',(0,0),(-1,-1),0.8,orange),
                ('LINEBELOW',(0,0),(-1,0),0.5,orange),('GRID',(0,1),(-1,-1),0.3,colors.HexColor('#FFE0B2')),
                ('VALIGN',(0,0),(-1,-1),'MIDDLE'),('TOPPADDING',(0,0),(-1,-1),4),
                ('BOTTOMPADDING',(0,0),(-1,-1),4),('LEFTPADDING',(0,0),(-1,-1),8),('RIGHTPADDING',(0,0),(-1,-1),8)]))
            story.append(ref_t); story.append(Spacer(1,4*mm))

        # ── ÍTEMS ─────────────────────────────────────────────────────────────
        # IVA total manual (solo factura de compra/recibida): el proveedor no
        # discrimina el IVA por ítem, así que el usuario ingresó un único valor
        # total en vez de un % por línea. En ese caso no tiene sentido mostrar
        # columnas de impuesto por ítem (siempre saldrían en 0/"—"), así que se
        # ocultan y el IVA aparece solo como una línea en TOTALES.
        iva_manual = is_compra and bool(payload.get('iva_total_manual'))
        story.append(Paragraph("DETALLE DE ÍTEMS",s['SecHdr']))
        story.append(HRFlowable(width='100%',thickness=0.5,color=ca_obj,spaceAfter=3,spaceBefore=1))
        has_disc=any(float(ln.get('discount_percent',0) or ln.get('discount_rate',0) or 0)>0 for ln in lines_d)
        if iva_manual:
            if has_disc:
                cw=[0.3*inch,2.55*inch,0.5*inch,0.42*inch,0.85*inch,0.7*inch,0.9*inch]
                _hdrs=['#','Descripción','Cant.','Und.','V. Unit.','Desc.','Total']
            else:
                cw=[0.3*inch,3.15*inch,0.5*inch,0.42*inch,0.95*inch,0.9*inch]
                _hdrs=['#','Descripción','Cant.','Und.','V. Unit.','Total']
        elif has_disc:
            cw=[0.3*inch,2.05*inch,0.5*inch,0.42*inch,0.72*inch,0.62*inch,0.65*inch,0.72*inch,0.78*inch]
            _hdrs=['#','Descripción','Cant.','Und.','V. Unit.','Desc.','Imp.$','%Imp.','Total']
        else:
            cw=[0.3*inch,2.65*inch,0.5*inch,0.42*inch,0.80*inch,0.65*inch,0.72*inch,0.78*inch]
            _hdrs=['#','Descripción','Cant.','Und.','V. Unit.','Imp.$','%Imp.','Total']
        td=[_hdrs]
        sub_acc=tax_acc=0.0; tax_by_type={}
        for idx,ln in enumerate(lines_d,1):
            qty=float(ln.get("quantity",1)); up=float(ln.get("unit_price",0))
            tr=float(ln.get("tax_rate",0)); tt2=ln.get("tax_type","01")
            dp=float(ln.get("discount_percent",0)); gross=qty*up; disc=gross*dp/100
            taxable=gross-disc; tax_a=0.0 if iva_manual else (taxable*tr/100 if tt2 not in ("ZA","ZY") else 0.0)
            lt=taxable+tax_a; sub_acc+=taxable; tax_acc+=tax_a
            if tax_a>0:
                tlbl=TAX_TYPE_LABELS.get(tt2,tt2)
                tax_by_type[tlbl]=tax_by_type.get(tlbl,0.0)+tax_a
            tr_str=(str(int(tr)) if tr==int(tr) else _fmt_num(tr,1))
            tl=f"{TAX_TYPE_LABELS.get(tt2,tt2)} {tr_str}%" if tax_a else TAX_TYPE_LABELS.get(tt2,'Excl.')
            uc_raw = ln.get("unit_code","EA")
            uc_lbl = UNIT_CODE_LABELS.get(uc_raw, uc_raw)
            # BUG CORREGIDO (2026-08-31): se truncaba la descripción a 80 caracteres con
            # [:80] aunque ya va dentro de un Paragraph (que hace wrap de texto solo,
            # respetando el ancho de columna). Con nombres de servicio largos (ej. CUPS
            # 890352 "CONSULTA DE CONTROL O DE SEGUIMIENTO POR ESPECIALISTA EN HEMATOLOGIA
            # PEDIATRICA") el corte a 80 caracteres cortaba el texto a mitad de palabra
            # ("...HEMATOLOGIA PE"). Se quita el truncado y se deja que Paragraph envuelva
            # el texto completo en varias líneas dentro de la celda.
            # BUG CORREGIDO (2026-08-31): desde SAL-020 el número de autorización de
            # cada servicio dejó de ir concatenado en la descripción (ahora va aparte,
            # en authorization_number, para BuyersItemIdentification en el XML) — pero
            # el PDF nunca se actualizó para mostrarlo por otro lado, así que dejó de
            # verse la autorización por ítem. Se muestra de nuevo, como segunda línea
            # dentro de la misma celda de descripción (respeta la autorización propia
            # del servicio si la tiene, o la del paciente si no — ver svcAuthNum en
            # dian-payload.utils.ts).
            _desc_txt = str(ln.get("description",""))
            _auth_num = ln.get("authorization_number")
            if _auth_num:
                _desc_txt += f'<br/><font size="6" color="#6B5F7A">Autorización: {_auth_num}</font>'
            _row=[str(idx),Paragraph(_desc_txt,s['Tiny']),
                _fmt_num(qty,0), uc_lbl, _fmt_cur(up)]
            if has_disc: _row.append(_fmt_cur(disc) if disc>0 else "—")
            if not iva_manual: _row += [_fmt_cur(tax_a) if tax_a>0 else "—",tl]
            _row += [_fmt_cur(lt)]
            td.append(_row)
        it=Table(td,colWidths=cw,repeatRows=1)
        it.setStyle(TableStyle([
            # Header: fondo blanco, texto oscuro, borde accent arriba y abajo
            ('BACKGROUND',(0,0),(-1,0),colors.white),
            ('TEXTCOLOR',(0,0),(-1,0),colors.HexColor(c_dark)),
            ('LINEABOVE',(0,0),(-1,0),1.5,ca_obj),
            ('LINEBELOW',(0,0),(-1,0),1.5,ca_obj),
            ('FONTNAME',(0,0),(-1,0),_FONT_BOLD),('FONTSIZE',(0,0),(-1,0),6.5),('ALIGN',(0,0),(-1,0),'CENTER'),
            # Datos
            ('FONTNAME',(0,1),(-1,-1),_FONT_REG),('FONTSIZE',(0,1),(-1,-1),7),
            ('ALIGN',(2,1),(-1,-1),'RIGHT'),('ALIGN',(0,1),(1,-1),'LEFT'),('ALIGN',(3,1),(3,-1),'CENTER'),
            ('VALIGN',(0,0),(-1,-1),'MIDDLE'),
            ('GRID',(0,0),(-1,-1),0.3,cbr_obj),
            # Filas alternadas con tinte muy suave
            ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,cal2_obj]),
            ('TOPPADDING',(0,0),(-1,-1),3),('BOTTOMPADDING',(0,0),(-1,-1),3),
            ('LEFTPADDING',(0,0),(-1,-1),3),('RIGHTPADDING',(0,0),(-1,-1),3),
            # Total de cada ítem en bold y color de marca
            ('FONTNAME',(-1,1),(-1,-1),_FONT_BOLD),('TEXTCOLOR',(-1,1),(-1,-1),cd_obj)]))
        story.append(it); story.append(Spacer(1,3*mm))

        # ── TOTALES ───────────────────────────────────────────────────────────
        if iva_manual:
            _iva_manual_val = float(payload.get('iva_total', 0) or 0)
            tax_by_type['IVA'] = tax_by_type.get('IVA', 0.0) + _iva_manual_val
            tax_acc += _iva_manual_val
        grand=sub_acc+tax_acc
        _tax_rows=[[Paragraph("Subtotal",s['TotLbl']),Paragraph(_fmt_cur(sub_acc),s['TotVal'])]]
        for _tlbl in ['IVA','INC','ICA'] + [k for k in sorted(tax_by_type) if k not in ('IVA','INC','ICA','Excl.')]:
            _tamt=tax_by_type.get(_tlbl,0.0)
            if _tamt>0: _tax_rows.append([Paragraph(_tlbl,s['TotLbl']),Paragraph(_fmt_cur(_tamt),s['TotVal'])])
        # BUG CORREGIDO (2026-08-31): SAL-008 ya restaba el copago/cuota moderadora del
        # PayableAmount en el XML (builder.py), pero el PDF nunca mostraba esa resta —
        # "Total a pagar" mostraba el bruto de la factura (ej. $300.000) en vez de lo que
        # realmente le queda por pagar a la EPS (ej. $295.000, ya en el XML firmado).
        # Se agrega la línea de descuento y "grand" pasa a ser el neto, para que el PDF
        # coincida con el PayableAmount del XML.
        _health_pp   = (payload.get('health') or {}).get('prepaid_payment') or {}
        _prepaid_amt = float(_health_pp.get('paid_amount') or 0)
        if _prepaid_amt > 0:
            _tipo_cobro = _health_pp.get('tipo_cobro_usuario') or 'cuota_moderadora'
            if _tipo_cobro == 'copago':
                _pct = _health_pp.get('porcentaje')
                _pp_lbl = f"Copago ({_pct:g}%) — pagado por el usuario" if _pct not in (None, '') else "Copago — pagado por el usuario"
            else:
                _pp_lbl = "Cuota moderadora — pagada por el usuario"
            _tax_rows.append([
                Paragraph(f'<font color="#0F766E"><b>{_pp_lbl}</b></font>', s['TotLbl']),
                Paragraph(f'<font color="#0F766E"><b>-{_fmt_cur(_prepaid_amt)}</b></font>', s['TotVal'])
            ])
            grand = grand - _prepaid_amt
        # Retención en la fuente (informativa)
        _tiene_ret = bool(payload.get("tiene_retencion", False))
        _valor_ret = float(payload.get("valor_retencion", 0) or 0)
        _tarifa_ret= float(payload.get("tarifa_retencion", 0) or 0)
        _concepto_ret = str(payload.get("concepto_retencion","") or "")
        if _tiene_ret and _valor_ret > 0:
            _ret_lbl = _concepto_ret if _concepto_ret else f"Retención en la fuente ({_tarifa_ret:g}%)"
            _tax_rows.append([
                Paragraph(f'<font color="#D97706"><b>{_ret_lbl}</b></font>', s['TotLbl']),
                Paragraph(f'<font color="#D97706"><b>-{_fmt_cur(_valor_ret)}</b></font>', s['TotVal'])
            ])
        sub_t=Table(_tax_rows,colWidths=[5.5*inch,1.3*inch])
        sub_t.setStyle(TableStyle([('ALIGN',(0,0),(-1,-1),'RIGHT'),('TOPPADDING',(0,0),(-1,-1),2),('BOTTOMPADDING',(0,0),(-1,-1),2)]))
        story.append(sub_t); story.append(Spacer(1,1*mm))
        # Total a pagar: borde izquierdo grueso accent + texto en colores de marca
        tot_t=Table([[Paragraph("Total a pagar",s['TotBoxLbl']),Paragraph(_fmt_cur(grand),s['TotBoxVal'])]],
                    colWidths=[4.5*inch,2.3*inch])
        tot_t.setStyle(TableStyle([
            ('BACKGROUND',(0,0),(-1,-1),colors.white),
            ('LINEBEFORE',(0,0),(0,0),4.5,ca_obj),
            ('LINEABOVE',(0,0),(-1,0),0.8,cbr_obj),
            ('LINEBELOW',(0,0),(-1,0),0.8,cbr_obj),
            ('BOX',(0,0),(-1,-1),0.5,cbr_obj),
            ('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),8),
            ('LEFTPADDING',(0,0),(0,0),12),('RIGHTPADDING',(1,0),(1,0),10),
            ('VALIGN',(0,0),(-1,-1),'MIDDLE')]))
        story.append(tot_t)
        # Neto a recibir (si hay retención)
        if _tiene_ret and _valor_ret > 0:
            neto = grand - _valor_ret
            neto_t=Table([[
                Paragraph("<font color='#D97706'><b>Neto a recibir (después de retención)</b></font>",s['TotBoxLbl']),
                Paragraph(f"<font color='#D97706'><b>{_fmt_cur(neto)}</b></font>",s['TotBoxVal'])
            ]],colWidths=[4.5*inch,2.3*inch])
            neto_t.setStyle(TableStyle([
                ('BACKGROUND',(0,0),(-1,-1),colors.HexColor('#FFFBEB')),
                ('LINEBEFORE',(0,0),(0,0),4.5,colors.HexColor('#D97706')),
                ('BOX',(0,0),(-1,-1),0.5,colors.HexColor('#FCD34D')),
                ('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6),
                ('LEFTPADDING',(0,0),(0,0),12),('RIGHTPADDING',(1,0),(1,0),10),
                ('VALIGN',(0,0),(-1,-1),'MIDDLE')]))
            story.append(Spacer(1,2*mm)); story.append(neto_t)
        story.append(Spacer(1,3*mm))
        # SAL-010: "VALOR EN LETRAS" en vez de "Son:" — bloque compartido por
        # todos los tipos de documento (factura de venta, salud, NC, ND, etc.).
        son_t=Table([[Paragraph(f'<b>VALOR EN LETRAS:</b>  <i>{_numero_a_letras(grand)}</i>',s['SonS'])]],colWidths=[6.8*inch])
        son_t.setStyle(TableStyle([
            ('BACKGROUND',(0,0),(0,0),colors.white),
            ('LINEBEFORE',(0,0),(0,0),3.5,ca_obj),
            ('BOX',(0,0),(0,0),0.3,cbr_obj),
            ('TOPPADDING',(0,0),(0,0),6),('BOTTOMPADDING',(0,0),(0,0),6),
            ('LEFTPADDING',(0,0),(0,0),10),('RIGHTPADDING',(0,0),(0,0),8)]))
        story.append(son_t); story.append(Spacer(1,5*mm))

        # ── NOTAS / OBSERVACIONES ────────────────────────────────────────────
        if note_text.strip():
            ca_hex2=c_acc.lstrip('#')
            note_label=f'<font color="#{ca_hex2}"><b>Notas / Observaciones</b></font>'
            note_t=Table(
                [[Paragraph(f'{note_label}<br/><font size="8.5">{note_text}</font>',s['NoteS'])]],
                colWidths=[6.8*inch])
            note_t.setStyle(TableStyle([
                ("BACKGROUND",(0,0),(0,0),colors.white),
                ("LINEBEFORE",(0,0),(0,0),3.5,ca_obj),
                ("BOX",(0,0),(0,0),0.5,cbr_obj),
                ("TOPPADDING",(0,0),(0,0),8),("BOTTOMPADDING",(0,0),(0,0),8),
                ("LEFTPADDING",(0,0),(0,0),10),("RIGHTPADDING",(0,0),(0,0),10)]))
            story.append(note_t); story.append(Spacer(1,4*mm))

        # ── QR / CUFE / FIRMA ─────────────────────────────────────────────────
        # Para Factura de Compra sin CUFE, omitir la sección entera
        _show_cufe_section = not (is_compra and not cufe)
        qr_bytes=_get_qr(cufe,environment) if _show_cufe_section else None
        sig_value=_extract_signature(signed_xml_b64) if (signed_xml_b64 and _show_cufe_section) else ''
        ca_hex=c_acc.lstrip('#')
        if qr_bytes:
            qr_img=Image(io.BytesIO(qr_bytes),width=54,height=54)
            right_parts=[]
            if sig_value:
                chunks=[sig_value[i:i+88] for i in range(0,min(len(sig_value),88*3),88)]
                right_parts.append(f"<b><font color='#{ca_hex}'>Firma Digital Electrónica</font></b><br/><font face='Courier' size='5.5'>{'<br/>'.join(chunks)}</font>")
            right_parts.append(f"<b><font color='#{ca_hex}'>{cufe_label}</font></b><br/><font face='Courier' size='5.5'>{cufe}</font>")
            firma_t=Table([[qr_img,Paragraph("<br/><br/>".join(right_parts),s['FirmaCell'])]],colWidths=[0.95*inch,5.85*inch])
            firma_t.setStyle(TableStyle([
                ('VALIGN',(0,0),(-1,-1),'TOP'),
                ('BACKGROUND',(0,0),(-1,-1),colors.white),
                ('BOX',(0,0),(-1,-1),0.5,cbr_obj),
                ('LINEABOVE',(0,0),(-1,0),2,ca_obj),
                ('LINEBEFORE',(1,0),(1,0),0.5,cbr_obj),
                ('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6),
                ('LEFTPADDING',(0,0),(0,0),4),('RIGHTPADDING',(0,0),(0,0),6),
                ('LEFTPADDING',(1,0),(1,0),8),('RIGHTPADDING',(1,0),(1,0),6),
                ('ALIGN',(0,0),(0,0),'CENTER')]))
            story.append(firma_t)
        elif _show_cufe_section:
            if sig_value:
                chunks=[sig_value[i:i+88] for i in range(0,min(len(sig_value),88*3),88)]
                sig_t=Table([[Paragraph(f"<b><font color='#{ca_hex}'>Firma Digital</font></b><br/><font face='Courier' size='5.5'>{'<br/>'.join(chunks)}</font>",s['FirmaCell'])]],colWidths=[6.8*inch])
                sig_t.setStyle(TableStyle([
                    ("BACKGROUND",(0,0),(0,0),colors.white),
                    ("BOX",(0,0),(0,0),0.5,cbr_obj),
                    ("LINEABOVE",(0,0),(0,0),2,ca_obj),
                    ("TOPPADDING",(0,0),(0,0),5),("BOTTOMPADDING",(0,0),(0,0),5),("LEFTPADDING",(0,0),(0,0),8)]))
                story.append(sig_t); story.append(Spacer(1,2*mm))
            story.append(Paragraph(f"<b>{cufe_label}:</b>",s['SecHdr'])); story.append(Paragraph(cufe,s['CufeS']))
        story.append(Spacer(1,4*mm))

        # ── AVISOS LEGALES ────────────────────────────────────────────────────
        # Nota: se mantiene exactamente el mismo texto/comportamiento para todos los
        # tipos de documento existentes (invoice/credit_note/debit_note/compra); solo
        # se agrega el aviso legal específico del Documento Soporte cuando is_ds.
        if is_ds:
            story.append(Paragraph("Documento soporte en adquisiciones efectuadas a no obligados a facturar · Resolución DIAN 0167 de 2021 · Art. 771-2 E.T.",s['Legal']))
        else:
            story.append(Paragraph("Esta factura se asimila en todos sus efectos legales a una letra de cambio según el Art. 774 del Código de Comercio y cumple con lo estipulado conforme al Artículo 617 del Estatuto Tributario.",s['Legal']))
        story.append(Spacer(1,2*mm))
        env_txt="PRODUCCIÓN" if environment=="1" else "HABILITACIÓN"

        doc.build(story); buf.seek(0); return buf.read()
    except Exception as exc:
        import traceback as _tb, sys
        print(json.dumps({"success":False,"error":str(exc),"traceback":_tb.format_exc()}),file=sys.stderr)
        raise


# ═══════════════════════════════════════════════════════════════════════════
# TIRILLA POS — recibo termico 80mm (modulo "Facturas Clientes" / Salud)
# Estilo aprobado: "Clasica POS" — monoespaciada, divisores punteados.
# ═══════════════════════════════════════════════════════════════════════════

_TIRILLA_WIDTH = 80 * mm


def _tirilla_styles():
    s = getSampleStyleSheet()
    black = colors.HexColor('#1A1028')

    def _add(name, **kw):
        s.add(ParagraphStyle(name=name, **kw))

    _add('TCenter', fontName='Courier-Bold', fontSize=11, leading=13,
         alignment=TA_CENTER, textColor=black)
    _add('TCenterSm', fontName='Courier', fontSize=8, leading=10.5,
         alignment=TA_CENTER, textColor=black)
    _add('TBody', fontName='Courier', fontSize=8.3, leading=11, textColor=black)
    _add('TBodyB', fontName='Courier-Bold', fontSize=8.3, leading=11, textColor=black)
    _add('TItemHdr', fontName='Courier-Bold', fontSize=7.5, leading=10, textColor=black)
    _add('TItemCell', fontName='Courier', fontSize=7.8, leading=10, textColor=black)
    _add('TCufe', fontName='Courier', fontSize=6.3, leading=8.5,
         alignment=TA_CENTER, textColor=colors.HexColor('#3D3550'), wordWrap='CJK')
    _add('TFooter', fontName='Courier-Bold', fontSize=8.5, leading=11,
         alignment=TA_CENTER, textColor=black)
    return s


def _tirilla_dashed():
    return HRFlowable(width='100%', thickness=0.7, color=colors.HexColor('#444444'),
                       spaceBefore=3, spaceAfter=3, dash=(2, 2))


def _measure_story_height(story, frame_width):
    """Suma la altura real que ocupa cada flowable para poder generar una
    página con el alto justo (como un rollo de papel termico), en vez de una
    página de largo fijo con un espacio en blanco enorme al final.

    Bug corregido: wrap() solo devuelve el alto propio del flowable, pero
    Platypus también reserva el spaceBefore/spaceAfter de cada uno (por
    ejemplo, los separadores punteados usan spaceBefore=3/spaceAfter=3) al
    momento de armar la página real — esos puntos no se estaban sumando
    aquí, así que el alto calculado quedaba corto y el contenido final
    (QR/CUFE/pie) se recorría a una segunda página en vez de partir la
    tirilla exactamente donde debía, dejando además espacio de sobra en la
    primera página.
    """
    total = 0.0
    for f in story:
        try:
            _, h = f.wrap(frame_width, 5000 * mm)
            total += h
            total += getattr(f, 'spaceBefore', 0) or 0
            total += getattr(f, 'spaceAfter', 0) or 0
        except Exception:
            pass
    return total


def build_tirilla_pdf(payload, cufe, environment="test"):
    """Genera la tirilla POS (recibo termico 80mm) de una Factura Cliente de salud.

    payload esperado (claves planas, independientes del payload XML/DIAN):
      company_name, company_nit, company_address, company_city,
      sede_nombre,
      resolution_number, prefix, number, issue_datetime,
      cajero_nombre,
      paciente_nombre, paciente_doc, contrato_nombre,
      items: [{descripcion, cantidad}]  (sin valor: precio EPS, no se muestra al paciente),
      cargo_usuario: {descripcion, valor} | None  (copago/cuota moderadora, unica linea con valor
        de servicios; si es None, la tirilla no tiene cobro aparte al usuario),
      subtotal (opcional; se omite si hay cargo_usuario), total,
      payment_method_label, valor_recibido, valor_cambio,
      cufe (opcional, tambien se recibe como parametro aparte)
    """
    try:
        s = _tirilla_styles()

        # SAL (tirilla partida en 2 páginas): armar la lista de flowables en una
        # función local que se puede volver a llamar para obtener una lista
        # NUEVA cada vez. Reutilizar los mismos objetos Flowable entre varios
        # doc.build() (como se hacía antes) es inseguro: algunos flowables
        # (en particular Table) mutan su estado interno cuando Platypus los
        # tiene que partir entre páginas, y reutilizarlos en un segundo build
        # producía un PDF corrupto/vacío en vez de uno bien armado.
        def _build_story():
            story = []

            company_name = _safe_str(payload.get('company_name', '') or '')
            company_nit = _safe_str(payload.get('company_nit', '') or '')
            company_address = _safe_str(payload.get('company_address', '') or '')
            company_city = _safe_str(payload.get('company_city', '') or '')
            sede_nombre = _safe_str(payload.get('sede_nombre', '') or '')

            story.append(Paragraph(company_name.upper() or 'EMPRESA', s['TCenter']))
            addr_lines = []
            if company_nit:
                addr_lines.append(f"NIT {company_nit}")
            if company_address or company_city:
                addr_lines.append(", ".join([p for p in [company_address, company_city] if p]))
            if sede_nombre:
                addr_lines.append(f"Sede: {sede_nombre}")
            if addr_lines:
                story.append(Paragraph("<br/>".join(addr_lines), s['TCenterSm']))

            story.append(_tirilla_dashed())

            resolution_number = _safe_str(payload.get('resolution_number', '') or '')
            prefix = _safe_str(payload.get('prefix', '') or '')
            number = payload.get('number', '')
            issue_dt = _safe_str(payload.get('issue_datetime', '') or '')
            cajero_nombre = _safe_str(payload.get('cajero_nombre', '') or '')

            hdr_lines = []
            if resolution_number:
                hdr_lines.append(f"Res. DIAN {resolution_number}")
            hdr_lines.append(f"Prefijo: {prefix}   No: {number}")
            if issue_dt:
                hdr_lines.append(f"Fecha: {issue_dt}")
            if cajero_nombre:
                hdr_lines.append(f"Cajero: {cajero_nombre}")
            story.append(Paragraph("<br/>".join(hdr_lines), s['TBody']))

            story.append(_tirilla_dashed())

            paciente_nombre = _safe_str(payload.get('paciente_nombre', '') or '')
            paciente_doc = _safe_str(payload.get('paciente_doc', '') or '')
            contrato_nombre = _safe_str(payload.get('contrato_nombre', '') or '')

            pac_lines = []
            if paciente_nombre:
                pac_lines.append(f"Paciente: {paciente_nombre}")
            if paciente_doc:
                pac_lines.append(paciente_doc)
            if contrato_nombre:
                pac_lines.append(f"Contrato: {contrato_nombre}")
            if pac_lines:
                story.append(Paragraph("<br/>".join(pac_lines), s['TBody']))
                story.append(_tirilla_dashed())

            # ── Servicios prestados ─────────────────────────────────────────
            # Informativa únicamente: NO se muestra el valor de cada servicio,
            # porque ese es el valor negociado con la EPS y el paciente no debe
            # verlo. El único valor que ve el paciente es el del cobro que se le
            # hace a él (ver bloque "cargo_usuario" más abajo), o el total cuando
            # no hay cobro aparte.
            items = payload.get('items') or []
            story.append(Paragraph('Servicios prestados', s['TItemHdr']))
            rows = [[Paragraph('Item', s['TItemHdr']), Paragraph('Cant', s['TItemHdr'])]]
            for it in items:
                desc = _safe_str(str(it.get('descripcion', '') or ''))[:34]
                qty = it.get('cantidad', 1)
                rows.append([Paragraph(desc, s['TItemCell']),
                             Paragraph(_fmt_num(float(qty or 0), 0), s['TItemCell'])])
            it_t = Table(rows, colWidths=[2.4 * inch, 0.45 * inch])
            it_t.setStyle(TableStyle([
                ('ALIGN', (1, 0), (-1, -1), 'RIGHT'),
                ('ALIGN', (0, 0), (0, -1), 'LEFT'),
                ('LINEBELOW', (0, 0), (-1, 0), 0.5, colors.HexColor('#333333')),
                ('TOPPADDING', (0, 0), (-1, -1), 1.5),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 1.5),
                ('LEFTPADDING', (0, 0), (-1, -1), 0),
                ('RIGHTPADDING', (0, 0), (-1, -1), 0),
            ]))
            story.append(it_t)
            story.append(_tirilla_dashed())

            # ── Detalle del cobro al paciente ────────────────────────────────
            # Solo aparece cuando el contrato tiene "pago por usuario" (copago o
            # cuota moderadora) — es la misma línea/valor genérico que ya se
            # imprime en la factura de pago por usuario, para que ambos documentos
            # coincidan.
            cargo_usuario = payload.get('cargo_usuario')
            if cargo_usuario and cargo_usuario.get('descripcion'):
                story.append(Paragraph('Detalle del cobro', s['TItemHdr']))
                cargo_desc = _safe_str(str(cargo_usuario.get('descripcion', '') or ''))
                cargo_val = _fmt_cur(cargo_usuario.get('valor', 0))
                cargo_rows = [[Paragraph(cargo_desc, s['TItemCell']), Paragraph(cargo_val, s['TItemCell'])]]
                cargo_t = Table(cargo_rows, colWidths=[1.95 * inch, 0.9 * inch])
                cargo_t.setStyle(TableStyle([
                    ('ALIGN', (1, 0), (1, -1), 'RIGHT'),
                    ('ALIGN', (0, 0), (0, -1), 'LEFT'),
                    ('LINEBELOW', (0, 0), (-1, 0), 0.5, colors.HexColor('#333333')),
                    ('TOPPADDING', (0, 0), (-1, -1), 1.5),
                    ('BOTTOMPADDING', (0, 0), (-1, -1), 1.5),
                    ('LEFTPADDING', (0, 0), (-1, -1), 0),
                    ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                ]))
                story.append(cargo_t)
                story.append(_tirilla_dashed())

            # ── Totales ──────────────────────────────────────────────────────
            subtotal = payload.get('subtotal')
            total = payload.get('total', 0)
            tot_rows = []
            if subtotal is not None and subtotal != '':
                tot_rows.append([Paragraph('Subtotal', s['TBody']), Paragraph(_fmt_cur(subtotal), s['TBody'])])
            tot_rows.append([Paragraph('TOTAL A PAGAR', s['TBodyB']), Paragraph(_fmt_cur(total), s['TBodyB'])])
            tot_t = Table(tot_rows, colWidths=[1.95 * inch, 0.9 * inch])
            tot_t.setStyle(TableStyle([
                ('ALIGN', (1, 0), (1, -1), 'RIGHT'),
                ('TOPPADDING', (0, 0), (-1, -1), 1.5),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 1.5),
                ('LEFTPADDING', (0, 0), (-1, -1), 0),
                ('RIGHTPADDING', (0, 0), (-1, -1), 0),
            ]))
            story.append(tot_t)
            story.append(_tirilla_dashed())

            # ── Forma de pago / recibido / cambio ──────────────────────────────
            method_label = _safe_str(payload.get('payment_method_label', '') or '')
            recibido = payload.get('valor_recibido')
            cambio = payload.get('valor_cambio')
            pay_lines = []
            if method_label:
                pay_lines.append(f"Forma de pago: {method_label.upper()}")
            if recibido is not None and recibido != '':
                pay_lines.append(f"Recibido:    {_fmt_cur(recibido)}")
            if cambio is not None and cambio != '':
                pay_lines.append(f"Cambio:      {_fmt_cur(cambio)}")
            if pay_lines:
                story.append(Paragraph("<br/>".join(pay_lines), s['TBody']))
                story.append(_tirilla_dashed())

            # ── QR / CUFE ────────────────────────────────────────────────────
            cufe_val = cufe or payload.get('cufe', '')
            qr_bytes = _get_qr(cufe_val, environment) if cufe_val else None
            if qr_bytes:
                qr_img = Image(io.BytesIO(qr_bytes), width=56, height=56)
                qr_img.hAlign = 'CENTER'
                story.append(qr_img)
                story.append(Spacer(1, 1.5 * mm))
            if cufe_val:
                story.append(Paragraph(f"CUFE: {cufe_val}", s['TCufe']))
                story.append(Spacer(1, 2 * mm))

            story.append(Paragraph('*** Gracias por su pago ***', s['TFooter']))

            return story

        # ── Alto de página dinámico ─────────────────────────────────────────
        # Antes se usaba un alto fijo de 297mm (tamaño carta) sin importar
        # cuánto contenido hubiera, dejando un espacio en blanco grande al
        # final. Aquí medimos lo que realmente ocupa el contenido y le damos
        # a la página justo ese alto (mas los márgenes y un pequeño colchón),
        # como una tirilla real de rollo termico.
        left_margin, right_margin = 3 * mm, 3 * mm
        top_margin, bottom_margin = 4 * mm, 4 * mm
        frame_width = _TIRILLA_WIDTH - left_margin - right_margin
        content_height = _measure_story_height(_build_story(), frame_width)
        page_height = max(80 * mm, content_height + top_margin + bottom_margin + 4 * mm)

        # _measure_story_height es solo una ESTIMACIÓN inicial (sigue sin capturar
        # con exactitud cosas como el espaciado entre flowables que Platypus decide
        # en tiempo de armado real de la página). Si la estimación quedó corta, el
        # contenido se recorre a una segunda página — antes eso pasaba silenciosamente
        # y la tirilla salía partida en dos, con la primera página además con un
        # espacio en blanco de sobra. Para garantizar que la tirilla NUNCA se parta
        # (independiente de cuántos ítems tenga) sin dejar espacio de sobra, se
        # arma la página real y, si Platypus la partió en más de una, se agranda el
        # alto en incrementos pequeños y se vuelve a armar hasta que quepa en una
        # sola página. En cada intento se vuelve a llamar _build_story() para
        # obtener objetos Flowable NUEVOS — reutilizar los mismos entre varios
        # doc.build() es inseguro (ver comentario arriba de _build_story).
        max_intentos = 8
        incremento = 12 * mm
        pdf_bytes = None
        for intento in range(max_intentos):
            story = _build_story()
            buf = io.BytesIO()
            doc = BaseDocTemplate(
                buf, pagesize=(_TIRILLA_WIDTH, page_height),
                leftMargin=left_margin, rightMargin=right_margin,
                topMargin=top_margin, bottomMargin=bottom_margin,
            )
            frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id='tirilla')
            doc.addPageTemplates([PageTemplate(id='T', frames=[frame])])
            doc.build(story)
            if doc.page <= 1 or intento == max_intentos - 1:
                pdf_bytes = buf.getvalue()
                break
            page_height += incremento
        buf = io.BytesIO(pdf_bytes)
        buf.seek(0)
        return buf.read()
    except Exception as exc:
        import traceback as _tb, sys
        print(json.dumps({"success": False, "error": str(exc), "traceback": _tb.format_exc()}), file=sys.stderr)
        raise
