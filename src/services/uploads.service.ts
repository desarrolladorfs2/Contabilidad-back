import * as path from 'path';

/**
 * Ayuda a que las rutas de archivos subidos (logos, certificados, RIPS, etc.)
 * sean PORTÁTILES entre entornos — el bug que hacía que el logo (y en teoría
 * también el certificado DIAN) dejara de cargar al desplegar en otro
 * servidor: se guardaba en la base la ruta ABSOLUTA calculada en el momento
 * de subir el archivo (ej. "C:\Users\...\backend\uploads\logos\x.png" o
 * "/home/otro-usuario/app/uploads/logos/x.png"), y esa ruta exacta
 * normalmente no existe en el servidor nuevo.
 *
 * La solución: guardar en la base solo la ruta RELATIVA a la carpeta de
 * uploads (ej. "logos/x.png"), y resolverla a una ruta absoluta recién en el
 * momento de leer el archivo, usando la carpeta de uploads del entorno
 * ACTUAL (UPLOADS_DIR). Así el mismo valor guardado en la base sirve sin
 * cambios sin importar en qué servidor/carpeta corra la app.
 *
 * resolveUploadPath() sigue funcionando igual con valores viejos que ya
 * quedaron guardados como ruta absoluta (path.resolve con un segundo
 * argumento absoluto simplemente devuelve ese absoluto), así que no rompe
 * nada mientras se migran los datos existentes.
 */
export function uploadsRoot(): string {
  return path.resolve(process.env.UPLOADS_DIR || './uploads');
}

export function resolveUploadPath(relativeOrAbsolute: string): string {
  // Normaliza separadores: algunos registros viejos se guardaron con "\\"
  // (generados con path.join() mientras el backend corría en Windows). En
  // Windows eso no daba problema (path.resolve entiende ambos separadores
  // ahí), pero si la app se despliega en un servidor Linux, path.resolve NO
  // trata "\\" como separador — buscaría un archivo llamado literalmente
  // "certificates\\xxx.pfx" en vez de entrar a la carpeta "certificates".
  // Convertir a "/" antes de resolver hace que el mismo valor guardado sirva
  // sin importar en qué sistema operativo corra la app.
  const normalizado = relativeOrAbsolute.replace(/\\/g, '/');
  return path.resolve(uploadsRoot(), normalizado);
}

/** Convierte una ruta guardada (relativa o, por datos viejos, absoluta) en la
 *  URL pública que sirve app.ts bajo /uploads. */
export function toUploadUrl(relativeOrAbsolute: string): string {
  const abs = resolveUploadPath(relativeOrAbsolute);
  const rel = path.relative(uploadsRoot(), abs).replace(/\\/g, '/');
  return `/uploads/${rel}`;
}
