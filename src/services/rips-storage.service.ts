import * as fs from 'fs';
import * as path from 'path';
import { resolveUploadPath } from './uploads.service';

/**
 * Guarda el RIPS JSON de una factura de salud en disco (en vez de en la
 * base de datos): un RIPS puede tener miles de pacientes/servicios y pesar
 * varios MB o incluso decenas de MB en JSON — eso no tiene sentido cargarlo
 * en una columna de la base ni arriesga límites de tamaño de fila/paquete
 * (como max_allowed_packet en MariaDB). Mismo patrón que ya se usa para
 * certificados y logos (ver certificate.service.ts).
 *
 * Retorna la ruta RELATIVA a la carpeta de uploads (ej. "rips/xxx.json"),
 * no absoluta — así el valor que queda en rips_json_path sirve sin cambios
 * sin importar en qué servidor corra la app después (ver uploads.service.ts).
 */
export function saveRipsJson(companyId: string, invoiceId: string, jsonString: string): string {
  const ripsDir = resolveUploadPath('rips');
  if (!fs.existsSync(ripsDir)) {
    fs.mkdirSync(ripsDir, { recursive: true });
  }
  const safeName = `${companyId}_${invoiceId}.json`;
  fs.writeFileSync(path.join(ripsDir, safeName), jsonString, 'utf8');
  // "/" explícito (no path.join) — mismo motivo que en certificate.service.ts:
  // path.join() usaría "\\" en Windows, y ese valor guardado en BD no se
  // resolvería bien si la app corre luego en un servidor Linux.
  return `rips/${safeName}`;
}

/** Lee el RIPS JSON guardado en disco. Acepta ruta relativa (nueva) o
 *  absoluta (datos de antes de este cambio). Retorna null si no existe. */
export function readRipsJson(ripsPath: string): string | null {
  try {
    const abs = resolveUploadPath(ripsPath);
    if (!fs.existsSync(abs)) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** Elimina el RIPS JSON de disco (ej. si se anula/borra la factura). */
export function deleteRipsJson(ripsPath: string): void {
  try {
    const abs = resolveUploadPath(ripsPath);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch { /* ignorar si no existe */ }
}
