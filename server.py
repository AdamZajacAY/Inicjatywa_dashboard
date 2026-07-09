#!/usr/bin/env python3
"""
Backend dashboardu Inicjatywa Projektowa - Flask + SQLite.

Zastepuje serve.py (goly serwer plikow statycznych) i cala warstwe
Excel/localStorage w dashboard/app.js. Ten proces:
  - serwuje pliki statyczne dashboardu (dashboard/index.html, app.js, style.css, vendor/*),
  - wystawia REST API pod /api/* trzymajace dane w baza_danych/baza_projektow.db.

Baza danych musi istniec przed pierwszym uruchomieniem - patrz
baza_danych/excel_to_sqlite.py (jednorazowa migracja z Baza_Projektow.xlsx)
albo baza_danych/schema.sql (pusty schemat).

Uruchomienie:  python3 server.py
Otwiera:       http://localhost:8000/dashboard/index.html
Zatrzymanie:   Ctrl+C
"""

import os
import re
import sqlite3
import sys
import webbrowser

from flask import Flask, abort, g, jsonify, request, send_from_directory

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(ROOT, "baza_danych", "baza_projektow.db")
PORT = 8000

app = Flask(__name__, static_folder=None)

# tabela -> (kolumna klucza glownego, prefiks generowanych ID, szerokosc zer wiodacych)
# prefix=None oznacza autoincrement SQLite (np. raporty_statusowe, ktore w Excelu
# nie mialy naturalnego unikalnego ID)
TABLES = {
    "projekty": ("ID_Projektu", "PRJ", 3),
    "zespol": ("ID_Osoby", "P", 2),
    "przypisania": ("ID_Przypisania", "ASG", 3),
    "harmonogram": ("ID_Zadania", "ZAD", 3),
    "zadania_tickety": ("ID_Tickietu", "TCK", 3),
    "kamienie_milowe": ("ID_Kamienia", "MIL", 3),
    "ryzyka_i_problemy": ("ID", "RYZ", 3),
    "raporty_statusowe": ("id", None, None),
    "podwykonawcy": ("ID_Podwykonawcy", "SUB", 3),
    "przypisania_podwykonawcow": ("ID_Przypisania_Podw", "SUBA", 3),
}

# tabela SQL -> klucz w odpowiedzi /api/bootstrap (nazwy pol STATE.* w dashboard/app.js)
BOOTSTRAP_KEYS = {
    "projekty": "projects", "zespol": "team", "przypisania": "assignments",
    "harmonogram": "tasks", "zadania_tickety": "tickets", "kamienie_milowe": "milestones",
    "ryzyka_i_problemy": "risks", "raporty_statusowe": "statusReports",
    "podwykonawcy": "subcontractors", "przypisania_podwykonawcow": "subcontractorAssignments",
}


def get_db():
    # Jedno polaczenie na request (flask.g), zamykane automatycznie w teardown_appcontext
    # ponizej - dziala tez gdy widok rzuci wyjatek inny niz zlapany sqlite3.IntegrityError
    # (np. "database is locked" przy wspolbieznym dostepie), co reczne conn.close() na
    # kazdym return nie pokrywalo.
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


_table_columns_cache = {}


def table_columns(conn, table):
    # Schemat jest stary na cale zycie procesu (TABLES sie nie zmienia w locie) - PRAGMA
    # table_info wystarczy odpytac raz na tabele, a nie przy kazdym POST/PUT.
    if table not in _table_columns_cache:
        _table_columns_cache[table] = [row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    return _table_columns_cache[table]


def fetch_row(conn, table, pk, pk_val):
    row = conn.execute(f"SELECT * FROM {table} WHERE {pk} = ?", (pk_val,)).fetchone()
    return dict(row) if row else None


def next_id(conn, table, pk, prefix, width):
    pattern = re.compile(rf"^{re.escape(prefix)}(\d+)$")
    max_n = 0
    for row in conn.execute(f"SELECT {pk} FROM {table}").fetchall():
        m = pattern.match(str(row[pk] or ""))
        if m:
            max_n = max(max_n, int(m.group(1)))
    return f"{prefix}{str(max_n + 1).zfill(width)}"


def parse_payload(conn, table, exclude=()):
    data = request.get_json(force=True, silent=True) or {}
    valid_cols = table_columns(conn, table)
    return {k: v for k, v in data.items() if k in valid_cols and k not in exclude}


@app.route("/api/bootstrap")
def bootstrap():
    conn = get_db()
    result = {}
    for table, key in BOOTSTRAP_KEYS.items():
        rows = conn.execute(f"SELECT * FROM {table}").fetchall()
        result[key] = [dict(r) for r in rows]
    return jsonify(result)


@app.route("/api/<table>", methods=["GET", "POST"])
def collection(table):
    if table not in TABLES:
        abort(404)
    pk, prefix, width = TABLES[table]
    conn = get_db()

    if request.method == "GET":
        rows = conn.execute(f"SELECT * FROM {table}").fetchall()
        return jsonify([dict(r) for r in rows])

    data = parse_payload(conn, table)
    if prefix:
        data[pk] = next_id(conn, table, pk, prefix, width)
    cols = list(data.keys())
    try:
        cur = conn.execute(
            f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
            [data[c] for c in cols],
        )
        conn.commit()
    except sqlite3.IntegrityError as e:
        return jsonify({"error": str(e)}), 409
    pk_val = data.get(pk) or cur.lastrowid
    return jsonify(fetch_row(conn, table, pk, pk_val)), 201


@app.route("/api/<table>/<path:item_id>", methods=["PUT", "DELETE"])
def item(table, item_id):
    if table not in TABLES:
        abort(404)
    pk, _prefix, _width = TABLES[table]
    conn = get_db()

    if request.method == "DELETE":
        try:
            cur = conn.execute(f"DELETE FROM {table} WHERE {pk} = ?", (item_id,))
            conn.commit()
        except sqlite3.IntegrityError as e:
            return jsonify({"error": f"Nie można usunąć — rekord jest nadal używany gdzie indziej ({e})"}), 409
        if cur.rowcount == 0:
            abort(404)
        return "", 204

    data = parse_payload(conn, table, exclude={pk})
    if not data:
        return jsonify({"error": "Brak pól do aktualizacji"}), 400
    set_clause = ", ".join(f"{c} = ?" for c in data.keys())
    try:
        cur = conn.execute(f"UPDATE {table} SET {set_clause} WHERE {pk} = ?", [*data.values(), item_id])
        conn.commit()
    except sqlite3.IntegrityError as e:
        return jsonify({"error": str(e)}), 409
    if cur.rowcount == 0:
        abort(404)
    return jsonify(fetch_row(conn, table, pk, item_id))


@app.errorhandler(404)
def not_found(_e):
    return jsonify({"error": "not found"}), 404


def _serve(path):
    resp = send_from_directory(ROOT, path)
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return resp


@app.route("/")
def index():
    # Osobny endpoint (nie redirect!) - inaczej Werkzeug traktuje "/" i
    # "/dashboard/index.html" jako ten sam endpoint i przekierowuje 308 do "/",
    # co psuje wzgledne sciezki zasobow w index.html (style.css, app.js, vendor/...).
    return _serve("dashboard/index.html")


@app.route("/<path:path>")
def static_files(path):
    return _serve(path)


def main():
    if not os.path.exists(DB_PATH):
        print(f"Brak bazy danych: {DB_PATH}")
        print("Uruchom najpierw: python3 baza_danych/excel_to_sqlite.py")
        sys.exit(1)

    url = f"http://localhost:{PORT}/dashboard/index.html"
    print("=" * 60)
    print("Serwer działa. Dashboard:")
    print(f"  {url}")
    print(f"Baza danych: {DB_PATH}")
    print("Zatrzymanie: Ctrl+C")
    print("=" * 60)
    webbrowser.open(url)
    app.run(port=PORT, debug=False)


if __name__ == "__main__":
    main()
