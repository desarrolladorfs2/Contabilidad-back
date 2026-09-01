"""
Constantes necesarias para la firma XAdES según el estándar DIAN Colombia.
Adaptadas del módulo l10n_co_electronic_invoice_self de Odoo.
"""

DEFAULT_POLICY_ID = (
    "https://facturaelectronica.dian.gov.co/politicadefirma/v2/politicadefirmav2.pdf"
)

DEFAULT_POLICY_NAME = (
    "Política de firma para facturas electrónicas de la República de Colombia"
)

POLICY_HASH_VALUE = "dMoMvtcG5aIzgYo0tIsSQeVJBDnUnfSOfBpxXrmor0Y="

# Namespaces usados en el módulo
NSD = {
    "soap": "http://www.w3.org/2003/05/soap-envelope",
    "wcf": "http://wcf.dian.colombia",
    "wsse": "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd",
    "wsu": "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd",
    "wsa": "http://www.w3.org/2005/08/addressing",
    "ds": "http://www.w3.org/2000/09/xmldsig#",
    "b": "http://schemas.datacontract.org/2004/07/ExchangeEmailResponse",
}
