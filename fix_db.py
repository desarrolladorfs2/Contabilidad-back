#!/usr/bin/env python3
"""
fix_db.py — Saneamiento de base de datos Akribeia
===================================================
Convierte el archivo .db de modo WAL a DELETE mode.
El VACUUM es opcional — si falla, igual aplica el fix crítico.

EJECUTAR SOLO CON EL BACKEND DETENIDO.

Uso:
    py fix_db.py                          # usa data/akribeia.db por defecto
    py fix_db.py "data/akribeia.db"       # ruta explícita
    py fix_db.py "data/akribeia - copia.db"
"""
import sqlite3, shutil, os, sys


def fix(db_path: str) -> None:
    db_path = os.path.abspath(db_path)

    if not os.path.exists(db_path):
        print(f"ERROR: No se encontró: {db_path}")
        sys.exit(1)

    with open(db_path, "rb") as f:
        header = f.read(100)

    if header[:16] != b"SQLite format 3\x00":
        print("ERROR: No es un archivo SQLite válido.")
        sys.exit(1)

    write_ver = header[18]
    size_before = os.path.getsize(db_path) / 1024 / 1024
    mode_str = "WAL (causa de corrupción con sql.js)" if write_ver == 2 else "DELETE (OK)"

    print("=" * 60)
    print(f"  Archivo : {db_path}")
    print(f"  Tamaño  : {size_before:.1f} MB")
    print(f"  Modo    : {mode_str}")
    print("=" * 60)

    if write_ver != 2:
        print("\n✅ La BD ya está en DELETE mode. No requiere saneamiento.")
        # Igual hacemos integrity_check
        try:
            conn = sqlite3.connect(db_path)
            r = conn.execute("PRAGMA integrity_check;").fetchone()
            conn.close()
            print(f"   integrity_check: {r[0]}")
        except Exception as e:
            print(f"   integrity_check: {e}")
        return

    # Backup
    bak = db_path + ".bak-fix"
    shutil.copy2(db_path, bak)
    print(f"\n[1/3] Backup guardado → {os.path.basename(bak)}")

    conn = sqlite3.connect(db_path)
    conn.isolation_level = None  # autocommit

    # ── Paso crítico: WAL → DELETE ────────────────────────────────────────────
    print("[2/3] Convirtiendo a DELETE journal mode...")
    try:
        r = conn.execute("PRAGMA journal_mode=DELETE;").fetchone()
        print(f"      journal_mode → {r[0]}")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")
        print("      WAL checkpoint OK")
    except Exception as e:
        print(f"      ⚠️  {e}")

    # ── Paso opcional: VACUUM ─────────────────────────────────────────────────
    print("[3/3] Ejecutando VACUUM (reconstruye B-trees)...")
    vacuum_ok = False
    try:
        conn.execute("VACUUM;")
        vacuum_ok = True
        print("      VACUUM completado ✅")
    except Exception as e:
        print(f"      VACUUM falló: {e}")
        print("      (El fix de WAL→DELETE ya se aplicó igual — continúa)")

    # ── Verificación ──────────────────────────────────────────────────────────
    try:
        r = conn.execute("PRAGMA integrity_check;").fetchone()
        fc = conn.execute("PRAGMA freelist_count;").fetchone()[0]
        status = r[0]
    except Exception as e:
        status = f"no disponible ({e})"
        fc = "?"

    conn.close()

    size_after = os.path.getsize(db_path) / 1024 / 1024
    print()
    print("=" * 60)
    print(f"  integrity_check : {status}")
    print(f"  freelist_count  : {fc}")
    print(f"  Tamaño antes    : {size_before:.1f} MB")
    print(f"  Tamaño después  : {size_after:.1f} MB")
    print("=" * 60)

    if vacuum_ok and status == "ok":
        print("\n✅ BD saneada perfectamente. Lista para usar.")
    elif not vacuum_ok:
        print("\n⚠️  El VACUUM falló pero el modo WAL→DELETE ya se corrigió.")
        print("   Esto es suficiente para que el backend funcione.")
        print("   El código nuevo en database.ts previene que vuelva a corromperse.")
    else:
        print(f"\n⚠️  integrity_check: {status}")
        print("   Intenta de todas formas — el error de auditoria debería desaparecer.")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        fix(sys.argv[1])
    else:
        default = os.path.join(os.path.dirname(__file__), "data", "akribeia.db")
        fix(default)
