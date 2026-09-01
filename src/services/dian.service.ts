/**
 * dian.service.ts
 *
 * Reemplaza las llamadas HTTP a los microservicios Python con child_process.spawn.
 * Los scripts CLI leen JSON por stdin y escriben JSON por stdout.
 *
 * Scripts en: SP_Dian_V2/backend/python/
 *   - xml_builder_cli.py   → genera XML DIAN (factura, nota crédito/débito, PDF, evento)
 *   - signer_cli.py        → firma XAdES-BES + empaqueta ZIP
 *   - transmitter_cli.py   → envía a DIAN via SOAP WS-Security
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { CompanySettings } from '../entities/CompanySettings';
import { decryptPassword, readCertificate } from './certificate.service';
import { resolveUploadPath } from './uploads.service';
import { PYTHON_EXEC } from '../utils/python-executable.util';

// ── Resolución de rutas ───────────────────────────────────────────────────────

// __dirname en dev (ts-node): .../SP_Dian_V2/backend/src/services
// __dirname en prod (tsc):    .../SP_Dian_V2/backend/dist/services
// En ambos casos, ../.. llega a .../SP_Dian_V2/backend
const PYTHON_DIR = path.resolve(__dirname, '../..', 'python');

// ── Helper principal: spawn + stdin/stdout JSON ───────────────────────────────

function callPythonCli(
  scriptName: string,
  operation: string,
  payload: unknown,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(PYTHON_DIR, scriptName);
    const input = JSON.stringify(payload);

    const child = spawn(PYTHON_EXEC, [scriptPath, operation], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Forzar UTF-8 en stdin/stdout de Python para evitar corrupción de tildes
      // en Windows (cp1252 por defecto).
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      if (code !== 0 && !stdout) {
        const errMsg = stderr.trim() || `Python exited with code ${code}`;
        console.error(`[DIAN] ${scriptName}/${operation} stderr:`, stderr.slice(0, 500));
        return reject(new Error(errMsg));
      }

      // El script siempre debe escribir JSON válido en stdout
      const raw = stdout.trim();
      const jsonStart = raw.indexOf('{');
      const jsonStr = jsonStart >= 0 ? raw.slice(jsonStart) : raw;

      try {
        const result = JSON.parse(jsonStr) as Record<string, unknown>;

        if (result.success === false && result.error) {
          console.error(`[DIAN] ${scriptName}/${operation} error:`, result.error);
          if (result.traceback) console.error((result.traceback as string).slice(0, 1000));
        }

        resolve(result);
      } catch (e) {
        console.error(`[DIAN] ${scriptName}/${operation} output no es JSON válido:`, raw.slice(0, 500));
        reject(new Error(`Respuesta Python inválida: ${raw.slice(0, 200)}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`No se pudo iniciar Python (${PYTHON_EXEC}): ${err.message}`));
    });

    // Enviar payload por stdin
    child.stdin.write(input);
    child.stdin.end();
  });
}

// ── Certificado ──────────────────────────────────────────────────────────────

export function getCertCredentials(settings: CompanySettings): {
  pfxBase64: string | null;
  password: string | null;
} {
  if (!settings.cert_path || !settings.cert_password_encrypted) {
    return { pfxBase64: null, password: null };
  }
  try {
    const pfxBuffer = readCertificate(settings.cert_path, !!settings.cert_encrypted_at_rest);
    const pfxBase64 = pfxBuffer.toString('base64');
    const password  = decryptPassword(settings.cert_password_encrypted);
    return { pfxBase64, password };
  } catch (e) {
    console.error('[DIAN] Error leyendo certificado:', e);
    return { pfxBase64: null, password: null };
  }
}

// ── XML Builder ──────────────────────────────────────────────────────────────

export async function generateInvoiceXml(payload: unknown): Promise<unknown> {
  return callPythonCli('xml_builder_cli.py', 'generate-invoice', payload);
}

export async function generateCreditNoteXml(payload: unknown): Promise<unknown> {
  return callPythonCli('xml_builder_cli.py', 'generate-credit-note', payload);
}

export async function generateDebitNoteXml(payload: unknown): Promise<unknown> {
  return callPythonCli('xml_builder_cli.py', 'generate-debit-note', payload);
}

export async function generateEventXml(payload: unknown): Promise<unknown> {
  return callPythonCli('xml_builder_cli.py', 'generate-event', payload);
}

export async function generateInvoicePdf(payload: unknown): Promise<unknown> {
  return callPythonCli('xml_builder_cli.py', 'generate-invoice-pdf', payload);
}

export async function generateCreditNotePdf(payload: unknown): Promise<unknown> {
  return callPythonCli('xml_builder_cli.py', 'generate-credit-note-pdf', payload);
}

export async function generateDebitNotePdf(payload: unknown): Promise<unknown> {
  return callPythonCli('xml_builder_cli.py', 'generate-debit-note-pdf', payload);
}

/** Genera la tirilla POS (recibo termico 80mm) de una Factura Cliente de salud. */
export async function generateTirillaPdf(payload: unknown): Promise<unknown> {
  return callPythonCli('xml_builder_cli.py', 'generate-tirilla-pdf', payload);
}


export async function signXml(
  xmlBase64: string,
  meta: Record<string, unknown>,
  settings: CompanySettings,
): Promise<unknown> {
  const { pfxBase64, password } = getCertCredentials(settings);
  // signer_cli.py uses 'filename' for the zip entry name
  const filename = (meta['invoice_number'] || meta['credit_note_number'] || meta['debit_note_number'] || 'document') as string;
  return callPythonCli('signer_cli.py', 'sign', {
    xml_base64: xmlBase64,
    filename,
    pfx_base64: pfxBase64 ?? undefined,
    password:   password  ?? undefined,
  });
}

export async function sendToDAIN(
  zipBase64: string,
  signedFilename: string,
  environment: string,
  settings: CompanySettings,
): Promise<unknown> {
  const { pfxBase64, password } = getCertCredentials(settings);
  // transmitter_cli.py operation: 'send-bill-sync', field: 'filename' (not 'signed_filename')
  return callPythonCli('transmitter_cli.py', 'send-bill-sync', {
    zip_base64:  zipBase64,
    filename:    signedFilename,
    environment,
    pfx_base64:  pfxBase64 ?? undefined,
    password:    password  ?? undefined,
  });
}

export async function sendEvent(
  zipBase64: string,
  signedFilename: string,
  environment: string,
  settings: CompanySettings,
): Promise<unknown> {
  const { pfxBase64, password } = getCertCredentials(settings);
  return callPythonCli('transmitter_cli.py', 'send-event', {
    zip_base64:  zipBase64,
    filename:    signedFilename,
    environment,
    pfx_base64:  pfxBase64 ?? undefined,
    password:    password  ?? undefined,
  });
}

export async function getStatusDian(
  cufe: string,
  environment: string,
  settings: CompanySettings,
): Promise<unknown> {
  const { pfxBase64, password } = getCertCredentials(settings);
  return callPythonCli('transmitter_cli.py', 'get-status', {
    track_id:    cufe,
    environment,
    pfx_base64:  pfxBase64 ?? undefined,
    password:    password  ?? undefined,
  });
}
