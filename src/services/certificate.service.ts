import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { resolveUploadPath } from './uploads.service';

const ALGORITHM = 'aes-256-cbc';
const KEY_LENGTH = 32;

function getEncryptionKey(): Buffer {
  const raw = process.env.CERT_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('CERT_ENCRYPTION_KEY no está configurado. Defínelo en el archivo .env antes de encriptar/desencriptar certificados.');
  }
  // Pad or truncate to exactly 32 bytes
  return Buffer.from(raw.padEnd(KEY_LENGTH, '0').slice(0, KEY_LENGTH));
}

/**
 * Encripta la contraseña del certificado antes de guardarla en BD.
 */
export function encryptPassword(plain: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

/**
 * Desencripta la contraseña almacenada en BD.
 */
export function decryptPassword(encrypted: string): string {
  const [ivHex, encHex] = encrypted.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/**
 * Hallazgo #57: cifra el contenido binario del .pfx (AES-256-CBC, misma
 * clave que la contraseña) antes de escribirlo a disco. El IV va como
 * prefijo de 16 bytes del archivo resultante — no hace falta guardarlo aparte.
 */
export function encryptBuffer(buf: Buffer): Buffer {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  return Buffer.concat([iv, cipher.update(buf), cipher.final()]);
}

/** Contraparte de encryptBuffer(): espera el IV como prefijo de 16 bytes. */
export function decryptBuffer(buf: Buffer): Buffer {
  const iv = buf.subarray(0, 16);
  const enc = buf.subarray(16);
  const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

/**
 * Guarda el archivo .pfx CIFRADO en disco y retorna la ruta RELATIVA a la
 * carpeta de uploads (ej. "certificates/xxx.pfx") — así el valor que queda
 * en la base de datos sirve sin cambios sin importar en qué servidor corra
 * la app después (ver services/uploads.service.ts). El .pfx ya no queda en
 * texto plano en disco (hallazgo #57).
 */
export function saveCertificate(
  fileBuffer: Buffer,
  originalName: string,
  companyId: string,
): string {
  const uploadsDir = resolveUploadPath('certificates');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  const safeName = `${companyId}_${Date.now()}_${path.basename(originalName)}`;
  fs.writeFileSync(path.join(uploadsDir, safeName), encryptBuffer(fileBuffer));
  // Se construye con "/" explícito (no path.join, que en Windows usaría "\\")
  // para que el valor guardado en BD sea portátil sin importar en qué
  // sistema operativo corra la app que lo lea después.
  return `certificates/${safeName}`;
}

/**
 * Lee un certificado del disco, desencriptándolo si fue guardado cifrado
 * (`cert_encrypted_at_rest === true`). Certificados subidos antes de este
 * cambio siguen en texto plano y se leen sin transformar, para no romper
 * la firma de facturas con certificados ya cargados.
 */
export function readCertificate(certPath: string, encryptedAtRest: boolean): Buffer {
  const raw = fs.readFileSync(resolveUploadPath(certPath));
  return encryptedAtRest ? decryptBuffer(raw) : raw;
}

/**
 * Elimina un certificado anterior del disco. Acepta tanto la ruta relativa
 * nueva como una ruta absoluta vieja (datos de antes de este cambio).
 */
export function deleteCertificate(certPath: string): void {
  try {
    const abs = resolveUploadPath(certPath);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (_) { /* ignorar si no existe */ }
}

/**
 * Guarda el logo de empresa en disco y retorna la ruta RELATIVA a la carpeta
 * de uploads (ej. "logos/xxx.png") — mismo motivo que saveCertificate().
 */
export function saveLogo(
  fileBuffer: Buffer,
  originalName: string,
  companyId: string,
): string {
  const logosDir = resolveUploadPath('logos');
  if (!fs.existsSync(logosDir)) {
    fs.mkdirSync(logosDir, { recursive: true });
  }
  const ext      = path.extname(originalName) || '.png';
  const safeName = `${companyId}_logo${ext}`;
  fs.writeFileSync(path.join(logosDir, safeName), fileBuffer);
  // Mismo motivo que en saveCertificate(): "/" explícito, no path.join().
  return `logos/${safeName}`;
}
