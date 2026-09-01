"""
Constantes DIAN y UBL para generación de facturas electrónicas.
Extraídas y adaptadas de la implementación de Odoo l10n_co_electronic_invoice_self
y del Anexo Técnico v1.9.
"""

# Namespaces principales
# Para lxml usamos None como clave para el namespace por defecto (recomendado)
NS_MAP = {
    None: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
    "cac": "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
    "cbc": "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
    "ext": "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2",
    "ds": "http://www.w3.org/2000/09/xmldsig#",
    "xades": "http://uri.etsi.org/01903/v1.3.2#",
    "xades141": "http://uri.etsi.org/01903/v1.4.1#",
    "sts": "dian:gov:co:facturaelectronica:Structures-2-1",
    "xsi": "http://www.w3.org/2001/XMLSchema-instance",
}

# Versión string para cuando se necesita el namespace por defecto explícitamente
INVOICE_NS = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"

# Códigos de impuesto DIAN (según l10n_co_tax_type.xml + Anexo Técnico)
TAX_CODES = {
    "01": "IVA",
    "03": "ICA",
    "04": "INC",
    "05": "ReteIVA",
    "06": "ReteFuente",
    "07": "ReteICA",
    "20": "FtoHorticultura",
    "21": "Timbre",
    "22": "Bolsas",
    "23": "INCarbono",
    "24": "INCombustibles",
    "25": "Sobretasa Combustibles",
    "26": "Sordicom",
    "32": "Impuesto al consumo de licores, vinos, aperitivos y similares",
    "34": "Impuesto al consumo de cervezas, sifones, refajos y mezclas / IBUA",
    "35": "ICUI (Impuesto Saludable)",
    "ZA": "IVA Excluido",
    "ZY": "No Aplica",
    "ZZ": "Nombre de la figura tributaria",
}

# Códigos de impuesto que son retenciones (no van en TaxTotal normal)
WITHHOLDING_TAX_CODES = {"05", "06", "07", "08"}

# Códigos de impuesto que usan PerUnitAmount + BaseUnitMeasure (no porcentaje)
PER_UNIT_TAX_CODES = {"22", "23", "24", "25", "32", "34"}

# Política de firma DIAN (v2 - actual)
DEFAULT_POLICY_ID = "https://facturaelectronica.dian.gov.co/politicadefirma/v2/politicadefirmav2.pdf"
POLICY_HASH_VALUE = "dMoMvtcG5aIzgYo0tIsSQeVJBDnUnfSOfBpxXrmor0Y="

# Tipo de ambiente
TIPO_AMBIENTE = {
    "1": "Producción",
    "2": "Pruebas / Habilitación",
}

# Moneda por defecto
DEFAULT_CURRENCY = "COP"

# Esquema de identificación fiscal Colombia
SCHEME_ID_FISCAL = "31"  # NIT

# Agency ID DIAN
AGENCY_ID_DIAN = "195"
# === VALORES EXACTOS QUE LA DIAN EXIGE (definidos una sola vez) ===
# Estos son los literales que deben aparecer TAL CUAL en el XML final.
CORRECT_PROFILE_ID = "DIAN 2.1: Factura Electrónica de Venta"
CORRECT_DIAN_AGENCY = "CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)"

# Bytes UTF-8 correctos (para sanitización por bytes - la forma más confiable)
CORRECT_PROFILE_ID_BYTES = b"DIAN 2.1: Factura Electr\xc3\xb3nica de Venta"
CORRECT_DIAN_AGENCY_BYTES = b"CO, DIAN (Direcci\xc3\xb3n de Impuestos y Aduanas Nacionales)"

# Alias para compatibilidad
AGENCY_NAME_DIAN = CORRECT_DIAN_AGENCY
PROFILE_ID_LITERAL = CORRECT_PROFILE_ID
COUNTRY_NAME_ES = "Colombia"
