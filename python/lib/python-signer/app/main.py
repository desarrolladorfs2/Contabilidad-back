"""
Servicio de Firma XAdES para DIAN
Basado en la implementación probada del módulo l10n_co de Odoo.
"""

import base64
import logging
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from app.signer import DIANXMLSigner
from app import constants

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="DIAN XAdES Signer Service",
    description="Servicio de firma XAdES-EPES compatible con DIAN Colombia (basado en xmlsig)",
    version="1.0.0"
)


class SignRequest(BaseModel):
    xml_base64: str
    pfx_base64: str
    password: str


class SignResponse(BaseModel):
    signed_xml_base64: str
    success: bool
    message: Optional[str] = None


@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "dian-xades-signer"}


@app.post("/sign", response_model=SignResponse)
async def sign_dian_xml(request: SignRequest):
    """
    Firma un XML UBL con XAdES-EPES según requerimientos de la DIAN.
    """
    try:
        xml_bytes = base64.b64decode(request.xml_base64)
        pfx_bytes = base64.b64decode(request.pfx_base64)

        signer = DIANXMLSigner(pfx_bytes, request.password)
        signed_xml = signer.sign_document(xml_bytes)

        return SignResponse(
            signed_xml_base64=base64.b64encode(signed_xml).decode(),
            success=True
        )

    except Exception as e:
        logger.exception("Error firmando XML para DIAN")
        raise HTTPException(
            status_code=400,
            detail=f"Error al firmar el documento: {str(e)}"
        )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)