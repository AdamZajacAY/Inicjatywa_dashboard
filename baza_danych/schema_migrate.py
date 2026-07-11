#!/usr/bin/env python3
"""
Jednorazowa, idempotentna migracja istniejacej bazy do schematu z NOT NULL na kluczach
glownych i na kolumnach FK z ON DELETE CASCADE (patrz schema.sql naglowek) - dodane po
audycie, ktory empirycznie potwierdzil, ze bez tego dawalo sie wstawic np. przypisanie
bez ID_Projektu/ID_Osoby, ktore potem staje sie trwale niewidocznym smieciem (kazdy render*
w app.js filtruje po tych polach, wiec taki wiersz nigdy nie pojawia sie w UI, ale zostaje
w bazie na zawsze).

SQLite nie pozwala dopisac NOT NULL do istniejacej kolumny zwyklym ALTER TABLE - jedyny
bezpieczny sposob to standardowa procedura z dokumentacji SQLite: dla kazdej tabeli
zmieniamy nazwe na tymczasowa, tworzymy nowa (z docelowym schematem, wprost z schema.sql,
zeby nie utrzymywac drugiej kopii definicji tabel w dwoch miejscach), kopiujemy dane,
kasujemy tymczasowa. Cala operacja w jednej transakcji z PRAGMA foreign_keys=OFF (zeby
kolejnosc przebudowy tabel nie mialo znaczenia), z PRAGMA foreign_key_check na koniec i
weryfikacja liczby wierszy per tabela przed/po - jesli cokolwiek sie nie zgadza, transakcja
jest wycofywana zamiast cicho zatwierdzic stratna migracje.

Wywolywane automatycznie przy starcie server.py (obok ensure_database_ready()), wiec
dziala tak samo pod "python3 server.py" lokalnie jak i pod gunicornem na Render - nie
wymaga recznego kroku przez Shell. Bezpieczne do wielokrotnego wywolania: jesli migracja
juz zaszla (sprawdzane przez PRAGMA table_info), funkcja natychmiast wraca bez zadnych zmian.
"""

import os
import re
import sqlite3

try:
    from baza_danych.backup_db import create_backup  # importowane z server.py jako pakiet
except ImportError:
    from backup_db import create_backup  # uruchamiane bezposrednio: python3 baza_danych/schema_migrate.py

ROOT = os.path.dirname(os.path.abspath(__file__))
SCHEMA_PATH = os.path.join(ROOT, "schema.sql")

# Kolejnosc nieistotna (PRAGMA foreign_keys=OFF w trakcie), ale trzyma sie kolejnosci z schema.sql
TABLES = [
    "projekty", "zespol", "przypisania", "harmonogram", "podwykonawcy",
    "zadania_tickety", "kamienie_milowe", "ryzyka_i_problemy", "raporty_statusowe",
    "przypisania_podwykonawcow", "users",
]


def _extract_create_statements(schema_sql):
    statements = {}
    for m in re.finditer(r"CREATE TABLE IF NOT EXISTS (\w+) \(.*?\);", schema_sql, re.DOTALL):
        statements[m.group(1)] = m.group(0)
    missing = set(TABLES) - set(statements)
    if missing:
        raise RuntimeError(f"schema_migrate: nie znaleziono CREATE TABLE dla {missing} w schema.sql")
    return statements


def _is_migrated(conn, table="projekty", pk="ID_Projektu"):
    for row in conn.execute(f"PRAGMA table_info({table})").fetchall():
        if row["name"] == pk:
            return bool(row["notnull"])
    return False  # tabeli/kolumny nie ma - traktuj jak "do migracji", CREATE TABLE i tak jest idempotentny


def migrate_schema(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        if _is_migrated(conn):
            return "Schemat juz zaktualizowany (NOT NULL), pomijam migracje."

        # dedykowany backup TEGO KONKRETNEGO pliku (db_path jawnie, nie domyslna sciezka
        # backup_db.py) tuz przed przebudowa tabel - niezalezny od ogolnego backupu startowego
        try:
            safety_backup = create_backup(db_path=db_path)
        except Exception as e:
            raise RuntimeError(f"schema_migrate: nie udalo sie zrobic backupu przed migracja, przerywam: {e}")

        with open(SCHEMA_PATH, encoding="utf-8") as f:
            create_statements = _extract_create_statements(f.read())

        before_counts = {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in TABLES}

        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("BEGIN")
        try:
            for table in TABLES:
                tmp = f"{table}__migrating_old"
                conn.execute(f"ALTER TABLE {table} RENAME TO {tmp}")
                conn.execute(create_statements[table])
                cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
                col_list = ", ".join(cols)
                conn.execute(f"INSERT INTO {table} ({col_list}) SELECT {col_list} FROM {tmp}")
                conn.execute(f"DROP TABLE {tmp}")

            after_counts = {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in TABLES}
            if before_counts != after_counts:
                raise RuntimeError(f"schema_migrate: liczba wierszy nie zgadza sie po migracji - "
                                    f"przed={before_counts} po={after_counts}, wycofuje")

            violations = conn.execute("PRAGMA foreign_key_check").fetchall()
            if violations:
                raise RuntimeError(f"schema_migrate: PRAGMA foreign_key_check znalazl naruszenia po "
                                    f"migracji, wycofuje: {[dict(v) for v in violations]}")

            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.execute("PRAGMA foreign_keys = ON")

        # indeksy (w tym nowy idx_przypisania_osoba) - CREATE INDEX IF NOT EXISTS, bezpieczne po fakcie
        with open(SCHEMA_PATH, encoding="utf-8") as f:
            for stmt in re.findall(r"CREATE INDEX IF NOT EXISTS.*?;", f.read()):
                conn.execute(stmt)
        conn.commit()

        return (f"Zmigrowano schemat (NOT NULL + indeks), backup przed migracja: "
                f"{os.path.basename(safety_backup)} - wiersze zachowane: {after_counts}")
    finally:
        conn.close()


def ensure_komentarze_table(db_path):
    """Dodaje tabele komentarze_tickety (nowa funkcjonalnosc) do baz, ktore powstaly przed jej
    wprowadzeniem. W przeciwienstwie do migrate_schema() powyzej to zwykla NOWA tabela, nie
    retrofit ograniczenia na istniejacej - CREATE TABLE/INDEX IF NOT EXISTS wystarcza, wprost
    z schema.sql (jedno zrodlo definicji), bez przebudowy niczego innego. Bezpieczne do
    wielokrotnego wywolania."""
    conn = sqlite3.connect(db_path)
    try:
        with open(SCHEMA_PATH, encoding="utf-8") as f:
            schema_sql = f.read()
        create_statements = _extract_create_statements(schema_sql)
        conn.execute(create_statements["komentarze_tickety"])
        for stmt in re.findall(r"CREATE INDEX IF NOT EXISTS idx_komentarze_tickiet.*?;", schema_sql):
            conn.execute(stmt)
        conn.commit()
    finally:
        conn.close()


def ensure_ticket_role_columns(db_path):
    """Dodaje ID_Osoby_zglaszajacej/ID_Osoby_wspomagajacej do zadania_tickety w bazach
    powstalych przed ich wprowadzeniem. Zwykly ALTER TABLE ... ADD COLUMN wystarcza (kolumny
    sa nullable, wiec to nie jest retrofit ograniczenia jak w migrate_schema() powyzej) -
    SQLite wspiera ADD COLUMN z klauzula REFERENCES bez przebudowy tabeli. Bezpieczne do
    wielokrotnego wywolania (PRAGMA table_info sprawdza czy kolumna juz istnieje)."""
    conn = sqlite3.connect(db_path)
    try:
        existing_cols = {row[1] for row in conn.execute("PRAGMA table_info(zadania_tickety)").fetchall()}
        new_cols = {
            "ID_Osoby_zglaszajacej": "TEXT REFERENCES zespol(ID_Osoby) ON DELETE SET NULL",
            "ID_Osoby_wspomagajacej": "TEXT REFERENCES zespol(ID_Osoby) ON DELETE SET NULL",
        }
        for col, decl in new_cols.items():
            if col not in existing_cols:
                conn.execute(f"ALTER TABLE zadania_tickety ADD COLUMN {col} {decl}")
        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    import sys
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "baza_projektow.db")
    print(migrate_schema(path))
    print(ensure_komentarze_table(path) or "komentarze_tickety: OK")
    print(ensure_ticket_role_columns(path) or "zadania_tickety role columns: OK")
