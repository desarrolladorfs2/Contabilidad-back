"""
asignar_cod_servicio_lote2.py

QUE HACE (segunda tanda, sobre los 262 servicios que quedaron pendientes
despues del primer script asignar_cod_servicio.py):

  1) 122 servicios (columna "prefijo_122" en lote2_codServicio.json):
     detectados por el prefijo del codigo CUPS (90xxxx = Laboratorio
     Clinico -> 706; RADIOGRAFIA* = Imagenes Diagnosticas Ionizantes -> 744;
     ECOGRAFIA*/ECOCARDIOGRAMA* = Imagenes Diagnosticas No Ionizantes -> 745).
     Se les asigna cod_servicio.

  2) 136 servicios (columna "grok_136"): mapeo propuesto por Grok para los
     procedimientos de odontologia/cirugia oral/periodoncia/endodoncia y
     demas que quedaban sin clasificar. Revisado contra la tabla oficial
     de SISPRO (TablaReferencia_Servicios.xlsx): 135/136 coinciden exacto
     en codigo+nombre+ambito, 1 con una etiqueta mal puesta mia (747
     Patologia, que si es el codigo correcto). Los 22 codigos usados estan
     todos marcados "Habilitado=SI" en esa tabla oficial. Se les asigna
     cod_servicio.

  3) 4 medicamentos (columna "medicamentos_4"): CUPS que en realidad son
     medicamentos (Fibrogammin P, Xeljanz, Guselkumab, Upadacitinib) pero
     estaban guardados con categoria='procedimientos' por error. A estos
     NO se les asigna cod_servicio (ese campo no aplica a medicamentos);
     solo se les corrige la categoria a 'medicamentos'.

  Solo actualiza filas donde cod_servicio esta vacio/NULL (para 1 y 2) o
  donde categoria='procedimientos' (para 3) - es seguro correrlo mas de
  una vez, no pisa nada que ya este puesto a mano.

  Al final exporta lo que siga sin clasificar (deberian ser los ~136 casos
  de "sin3_criterio" que necesitan criterio clinico, restados los que
  ya se resolvieron con el mapeo de Grok) a
  scripts/_codServicio_pendientes_v3.csv.

COMO CORRERLO:
  1. Cierra el backend (para que no haya dos procesos escribiendo el .db
     a la vez).
  2. Abre una terminal DIRECTAMENTE en tu computador (cmd o PowerShell,
     no a traves de Claude) en la carpeta backend\\scripts.
  3. Corre:  py asignar_cod_servicio_lote2.py
  4. Cuando termine, vuelve a abrir el backend normal.

Hace un backup del .db antes de tocar nada
(data/akribeia.PRE_asignar_codServicio_lote2.bak.db).
"""
import json
import sqlite3
import shutil
import os
import csv

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, '..', 'data', 'akribeia.db')
LOTE2_PATH = os.path.join(HERE, 'lote2_codServicio.json')
SIN_MATCH_PATH = os.path.join(HERE, '_codServicio_sin_match.json')
PENDIENTES_CSV = os.path.join(HERE, '_codServicio_pendientes_v3.csv')

COMPANIES = [
    'd07e83f4-abc1-410b-8837-780a77f4a03c',  # NEURUM SAS
    '4d601ecc-af71-467c-974b-7529971df0bb',  # Neurum AP
]


def main():
    if not os.path.exists(DB_PATH):
        print(f'ERROR: no encuentro la base en {DB_PATH}')
        return

    with open(LOTE2_PATH, encoding='utf-8') as f:
        lote2 = json.load(f)

    updates = {}
    for cups, cod in lote2['prefijo_122']:
        updates[cups] = cod
    for cups, cod in lote2['grok_136']:
        updates[cups] = cod
    meds_cups = set(lote2['medicamentos_4'])

    print(f'Total codServicio a asignar: {len(updates)} CUPS distintos '
          f'({len(lote2["prefijo_122"])} por prefijo + {len(lote2["grok_136"])} del mapeo de Grok), '
          f'en {len(COMPANIES)} empresas.')
    print(f'Total a recategorizar como medicamento: {len(meds_cups)} CUPS.')

    # Backup antes de tocar nada
    backup_path = os.path.join(HERE, '..', 'data', 'akribeia.PRE_asignar_codServicio_lote2.bak.db')
    shutil.copy2(DB_PATH, backup_path)
    print(f'Backup creado: {backup_path}')

    conn = sqlite3.connect(DB_PATH, timeout=20)
    try:
        cur = conn.cursor()

        total_cod = 0
        for cid in COMPANIES:
            for cups, cod in updates.items():
                cur.execute(
                    "UPDATE salud_servicios SET cod_servicio=? "
                    "WHERE company_id=? AND codigo_cups=? "
                    "AND (cod_servicio IS NULL OR cod_servicio='')",
                    (cod, cid, cups),
                )
                total_cod += cur.rowcount
        print(f'Filas con cod_servicio actualizado: {total_cod}')

        total_meds = 0
        for cid in COMPANIES:
            for cups in meds_cups:
                cur.execute(
                    "UPDATE salud_servicios SET categoria='medicamentos' "
                    "WHERE company_id=? AND codigo_cups=? "
                    "AND categoria='procedimientos'",
                    (cid, cups),
                )
                total_meds += cur.rowcount
        print(f'Filas recategorizadas a medicamentos: {total_meds}')

        conn.commit()

        cur.execute("PRAGMA integrity_check")
        print('Integridad de la base:', cur.fetchone()[0])

        cur.execute(
            "SELECT count(*) FROM salud_servicios WHERE cod_servicio IS NOT NULL AND cod_servicio<>''"
        )
        print('Total de servicios con cod_servicio ahora:', cur.fetchone()[0])
    finally:
        conn.close()

    # Exportar lo que siga sin clasificar
    with open(SIN_MATCH_PATH, encoding='utf-8') as f:
        sin_match = json.load(f)  # [id, codigo_cups, nombre, categoria]
    ya_resueltos = set(updates.keys()) | meds_cups
    pendientes = [row for row in sin_match if row[1] not in ya_resueltos]
    with open(PENDIENTES_CSV, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['codigo_cups', 'nombre_servicio', 'categoria'])
        for row in pendientes:
            w.writerow([row[1], row[2], row[3]])
    print(f'Exportados {len(pendientes)} servicios que siguen sin clasificar a: {PENDIENTES_CSV}')
    print('Listo. Ya puedes volver a abrir el backend.')


if __name__ == '__main__':
    main()
