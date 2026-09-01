"""
asignar_cod_servicio.py

QUE HACE:
  Asigna el campo cod_servicio (codigo de habilitacion REPS del servicio,
  ver Cambios/54_fixes_rips_validador_real_PRUE60.txt) a los servicios del
  catalogo (tabla salud_servicios) que aun no lo tienen, tanto en Neurum AP
  como en Neurum SAS.

  - Los 88 servicios en _codServicio_matched.json: se les asigna el codigo
    detectado por especialidad (ver propuesta_codServicio.csv que ya
    revisaste).
  - 10 consultas adicionales (Trabajo Social, Fonoaudiologia, Equipo
    Interdisciplinario, Alergologia, Hepatologia): se les asigna 356
    ("Otras consultas de especialidad"), por instruccion tuya.
  - Los 262 restantes (mayoria procedimientos de odontologia/medicamentos
    mal categorizados) quedan SIN TOCAR - se exportan a
    scripts/_codServicio_pendientes.csv para clasificarlos despues.

  Solo actualiza filas donde cod_servicio esta vacio/NULL - es seguro
  correrlo mas de una vez (no pisa nada que ya este puesto a mano).

COMO CORRERLO:
  1. Cierra el backend (para que no haya dos procesos escribiendo el .db
     a la vez).
  2. Abre una terminal (cmd o PowerShell) DIRECTAMENTE en tu computador
     (no a traves de Claude) en la carpeta backend\\scripts.
  3. Corre:  python asignar_cod_servicio.py
  4. Cuando termine, vuelve a abrir el backend normal.

Hace un backup del .db antes de tocar nada (data/akribeia.PRE_asignar_codServicio.bak.db).
"""
import json
import sqlite3
import shutil
import os
import csv
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, '..', 'data', 'akribeia.db')
MATCHED_PATH = os.path.join(HERE, '_codServicio_matched.json')
SIN_MATCH_PATH = os.path.join(HERE, '_codServicio_sin_match.json')
PENDIENTES_CSV = os.path.join(HERE, '_codServicio_pendientes.csv')

COMPANIES = [
    'd07e83f4-abc1-410b-8837-780a77f4a03c',  # NEURUM SAS
    '4d601ecc-af71-467c-974b-7529971df0bb',  # Neurum AP
]

# 10 consultas sin match claro en la tabla de referencia -> "Otras consultas
# de especialidad" (356), por instruccion del usuario.
EXTRA_356 = [
    '890209', '890210', '890215', '890225', '890253',
    '890309', '890310', '890315', '890325', '890353',
]


def main():
    if not os.path.exists(DB_PATH):
        print(f'ERROR: no encuentro la base en {DB_PATH}')
        return

    with open(MATCHED_PATH, encoding='utf-8') as f:
        matched = json.load(f)  # [id, codigo_cups, nombre, categoria, especialidad, codigo]

    updates = {row[1]: row[5] for row in matched}
    for cups in EXTRA_356:
        updates[cups] = '356'
    print(f'Total de codigos a asignar: {len(updates)} CUPS distintos, en {len(COMPANIES)} empresas.')

    # Backup antes de tocar nada
    backup_path = os.path.join(HERE, '..', 'data', 'akribeia.PRE_asignar_codServicio.bak.db')
    shutil.copy2(DB_PATH, backup_path)
    print(f'Backup creado: {backup_path}')

    conn = sqlite3.connect(DB_PATH, timeout=20)
    try:
        cur = conn.cursor()
        total = 0
        for cid in COMPANIES:
            for cups, cod in updates.items():
                cur.execute(
                    "UPDATE salud_servicios SET cod_servicio=? "
                    "WHERE company_id=? AND codigo_cups=? "
                    "AND (cod_servicio IS NULL OR cod_servicio='')",
                    (cod, cid, cups),
                )
                total += cur.rowcount
        conn.commit()
        print(f'Filas actualizadas: {total}')

        cur.execute("PRAGMA integrity_check")
        print('Integridad de la base:', cur.fetchone()[0])

        cur.execute(
            "SELECT count(*) FROM salud_servicios WHERE cod_servicio IS NOT NULL AND cod_servicio<>''"
        )
        print('Total de servicios con cod_servicio ahora:', cur.fetchone()[0])
    finally:
        conn.close()

    # Exportar los que quedaron sin asignar (para clasificar despues)
    with open(SIN_MATCH_PATH, encoding='utf-8') as f:
        sin_match = json.load(f)  # [id, codigo_cups, nombre, categoria]
    pendientes = [row for row in sin_match if row[1] not in EXTRA_356]
    with open(PENDIENTES_CSV, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['codigo_cups', 'nombre_servicio', 'categoria'])
        for row in pendientes:
            w.writerow([row[1], row[2], row[3]])
    print(f'Exportados {len(pendientes)} servicios sin clasificar a: {PENDIENTES_CSV}')
    print('Listo. Ya puedes volver a abrir el backend.')


if __name__ == '__main__':
    main()
