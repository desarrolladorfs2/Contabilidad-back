/**
 * python-executable.util.ts
 *
 * Resuelve el comando con el que se invoca Python al lanzar los CLIs de
 * backend/python/ (xml_builder_cli.py, ds_xml_builder_cli.py, signer_cli.py,
 * transmitter_cli.py) como procesos hijo.
 *
 * - Si la variable de entorno PYTHON_EXECUTABLE está definida, se respeta
 *   siempre (permite override manual en cualquier entorno).
 * - Si no está definida, se detecta automáticamente segun el sistema
 *   operativo: 'py' (Python Launcher) en Windows, 'python3' en cualquier
 *   otro caso (Linux/macOS — los servidores de despliegue típicos).
 *
 * Antes este valor estaba hardcodeado como `process.env.PYTHON_EXECUTABLE
 * || 'py'` de forma independiente en 3 archivos distintos — 'py' no existe
 * en servidores Linux, causando que toda generación de XML/PDF/firma DIAN
 * fallara silenciosamente en producción hasta el primer intento de uso.
 */
export const PYTHON_EXEC: string =
  process.env.PYTHON_EXECUTABLE || (process.platform === 'win32' ? 'py' : 'python3');
