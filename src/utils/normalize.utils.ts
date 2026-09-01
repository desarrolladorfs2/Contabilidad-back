/**
 * Utilidades de normalización compartidas — hallazgo #1 (Facturas) / #15 (Terceros).
 *
 * Los snapshots desnormalizados de cliente/proveedor (Factura.cliente_nit,
 * Factura.cliente_correo, y equivalentes en otros documentos) no pasan por la
 * entidad `Tercero` ni su hook @BeforeInsert/@BeforeUpdate, así que necesitan
 * normalizarse explícitamente en el punto donde se arma el registro.
 */

/** Trim + minúsculas. Devuelve undefined si queda vacío (para no guardar ''). */
export function normalizeEmail(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const v = String(raw).trim().toLowerCase();
  return v || undefined;
}

/**
 * Deja solo dígitos (quita puntos, espacios, guiones) para que la comparación/
 * unicidad por NIT sea confiable. Si el valor no tiene ningún dígito, se
 * conserva el original recortado en vez de perderlo.
 */
export function normalizeNit(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const soloDigitos = String(raw).replace(/\D/g, '');
  const result = soloDigitos || String(raw).trim();
  return result || undefined;
}
