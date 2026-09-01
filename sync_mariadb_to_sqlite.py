#!/usr/bin/env python3
"""
Sincroniza TODAS las tablas de la base MariaDB/MySQL de producción (FEV, definida
en backend/.env) hacia un archivo SQLite local nuevo (backend/data/akribeia.db).

Uso (desde la carpeta backend/, o pasando la ruta del .env con --env):
    pip install pymysql
    python sync_mariadb_to_sqlite.py

Qué hace:
  1. Lee las credenciales de conexión desde backend/.env (DB_HOST, DB_PORT,
     DB_USERNAME, DB_PASSWORD, DB_DATABASE).
  2. Se conecta a esa base MariaDB/MySQL (esto SOLO funciona corriendo el script
     desde una máquina que sí tenga red hacia el RDS — tu PC o el servidor,
     nunca desde el sandbox de Claude).
  3. Lista todas las tablas y, para cada una, trae todas las filas.
  4. Crea un archivo SQLite nuevo (backend/data/akribeia.db) con una tabla por
     cada tabla de origen (columnas genéricas TEXT/INTEGER/REAL/BLOB — no se
     replican claves foráneas ni índices, esto es solo un espejo de lectura
     para pruebas/lookups locales, no un reemplazo funcional de la app).
  5. El archivo anterior (si existía) se renombra a akribeia.db.bak-<timestamp>
     en vez de borrarse, por si hay que volver atrás.

No borra ni modifica NADA en la base de producción — es de solo lectura hacia
MariaDB y de solo escritura hacia el SQLite nuevo.
"""
import argparse
import datetime
import os
import re
import sqlite3
import sys


def load_env(env_path: str) -> dict:
    values = {}
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            values[key.strip()] = val.strip().strip('"').strip("'")
    return values


def sqlite_type_for(field_type_code, field) -> str:
    # pymysql/MySQLdb field.type_code numeric constants → afinidad SQLite genérica.
    # No hace falta ser exhaustivo: SQLite tiene tipado dinámico, así que basta
    # con una afinidad razonable por columna.
    import pymysql

    FT = pymysql.constants.FIELD_TYPE
    integer_types = {
        FT.TINY, FT.SHORT, FT.LONG, FT.LONGLONG, FT.INT24, FT.YEAR,
    }
    real_types = {FT.FLOAT, FT.DOUBLE, FT.DECIMAL, FT.NEWDECIMAL}
    blob_types = {FT.BLOB, FT.TINY_BLOB, FT.MEDIUM_BLOB, FT.LONG_BLOB}

    if field_type_code in integer_types:
        return "INTEGER"
    if field_type_code in real_types:
        return "REAL"
    if field_type_code in blob_types:
        return "BLOB"
    return "TEXT"


def coerce_value(v):
    if isinstance(v, (datetime.datetime, datetime.date, datetime.time)):
        return v.isoformat()
    if isinstance(v, (bytes, bytearray)):
        return bytes(v)
    try:
        import decimal
        if isinstance(v, decimal.Decimal):
            return float(v)
    except ImportError:
        pass
    return v


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", default=os.path.join(os.path.dirname(__file__), ".env"),
                         help="Ruta al .env del backend (default: ./  .env junto a este script)")
    parser.add_argument("--out", default=None,
                         help="Ruta de salida del sqlite (default: <backend>/data/akribeia.db)")
    args = parser.parse_args()

    try:
        import pymysql
    except ImportError:
        print("Falta la librería pymysql. Instálala con:\n    pip install pymysql")
        sys.exit(1)

    env_path = os.path.abspath(args.env)
    if not os.path.isfile(env_path):
        print(f"No encontré el .env en {env_path}. Pasa la ruta correcta con --env")
        sys.exit(1)

    env = load_env(env_path)
    host = env.get("DB_HOST")
    port = int(env.get("DB_PORT", "3306"))
    user = env.get("DB_USERNAME")
    password = env.get("DB_PASSWORD")
    database = env.get("DB_DATABASE")

    if not all([host, user, database]):
        print("Faltan variables DB_HOST / DB_USERNAME / DB_DATABASE en el .env")
        sys.exit(1)

    out_path = args.out or os.path.join(os.path.dirname(env_path), "data", "akribeia.db")
    out_path = os.path.abspath(out_path)

    print(f"Conectando a MariaDB {host}:{port}/{database} como {user} ...")
    conn = pymysql.connect(host=host, port=port, user=user, password=password,
                            database=database, connect_timeout=10, charset="utf8mb4")
    cur = conn.cursor()
    cur.execute("SHOW TABLES")
    tablas = [r[0] for r in cur.fetchall()]
    print(f"{len(tablas)} tablas encontradas en {database}.")

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    if os.path.isfile(out_path):
        ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_path = f"{out_path}.bak-{ts}"
        os.rename(out_path, backup_path)
        print(f"Archivo sqlite anterior respaldado en: {backup_path}")

    sconn = sqlite3.connect(out_path)
    scur = sconn.cursor()
    scur.execute("PRAGMA journal_mode=WAL")

    total_filas = 0
    for i, tabla in enumerate(tablas, start=1):
        cur.execute(f"SELECT * FROM `{tabla}`")
        cols = [d[0] for d in cur.description]
        col_types = [sqlite_type_for(d[1], d) for d in cur.description]

        col_defs = ", ".join(f'"{c}" {t}' for c, t in zip(cols, col_types))
        scur.execute(f'DROP TABLE IF EXISTS "{tabla}"')
        scur.execute(f'CREATE TABLE "{tabla}" ({col_defs})')

        placeholders = ", ".join(["?"] * len(cols))
        quoted_cols = ", ".join(f'"{c}"' for c in cols)
        insert_sql = f'INSERT INTO "{tabla}" ({quoted_cols}) VALUES ({placeholders})'

        filas = 0
        while True:
            batch = cur.fetchmany(2000)
            if not batch:
                break
            batch = [[coerce_value(v) for v in row] for row in batch]
            scur.executemany(insert_sql, batch)
            filas += len(batch)
        sconn.commit()
        total_filas += filas
        print(f"  [{i}/{len(tablas)}] {tabla}: {filas} filas")

    cur.close()
    conn.close()
    scur.close()
    sconn.close()

    print(f"\nListo. {len(tablas)} tablas, {total_filas} filas totales copiadas a:\n  {out_path}")


if __name__ == "__main__":
    main()
