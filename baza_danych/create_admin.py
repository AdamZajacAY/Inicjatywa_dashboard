#!/usr/bin/env python3
"""
Tworzy pierwsze konto COO/Admin - jednorazowy krok po dodaniu logowania,
zeby bylo jak sie w ogole pierwszy raz zalogowac (bootstrap problem: bez
tego konta nikt nie zaloguje sie, zeby przez UI utworzyc kolejne).

Interaktywny, pyta o e-mail / imie i nazwisko / haslo (getpass, bez echo).
Nie importuje server.py (unika efektow ubocznych importu, np. tworzenia
pliku sekretu sesji) - laczy sie z baza bezposrednio przez sqlite3, tak
samo jak excel_to_sqlite.py.

Uruchomienie:  python3 baza_danych/create_admin.py
"""

import datetime
import getpass
import os
import re
import sqlite3
import sys

from werkzeug.security import generate_password_hash

# hashlib.scrypt (domyslna metoda generate_password_hash) nie istnieje na macOS
# system Python linkowanym z LibreSSL - zweryfikowane bezposrednio. pbkdf2:sha256
# dziala wszedzie, wiec jest jedyna dopuszczalna metoda (patrz tez server.py).
PASSWORD_HASH_METHOD = "pbkdf2:sha256"

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DATABASE_PATH", os.path.join(ROOT, "baza_projektow.db"))


def next_user_id(conn):
    pattern = re.compile(r"^USR(\d+)$")
    max_n = 0
    for row in conn.execute("SELECT ID_Uzytkownika FROM users").fetchall():
        m = pattern.match(str(row[0] or ""))
        if m:
            max_n = max(max_n, int(m.group(1)))
    return f"USR{str(max_n + 1).zfill(3)}"


def main():
    if not os.path.exists(DB_PATH):
        print(f"Brak bazy danych: {DB_PATH}")
        print("Uruchom najpierw: python3 baza_danych/excel_to_sqlite.py")
        sys.exit(1)

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    existing_admins = conn.execute("SELECT Email FROM users WHERE Rola IN ('COO', 'Admin')").fetchall()
    if existing_admins:
        print("Konta COO/Admin juz istnieja:")
        for row in existing_admins:
            print(f"  - {row['Email']}")
        if input("Utworzyc mimo to kolejne konto Admin? [t/N]: ").strip().lower() not in ("t", "tak", "y", "yes"):
            print("Przerwano.")
            return

    email = input("E-mail: ").strip().lower()
    if not email or "@" not in email:
        print("Nieprawidlowy e-mail.")
        sys.exit(1)
    if conn.execute("SELECT 1 FROM users WHERE lower(Email) = ?", (email,)).fetchone():
        print(f"Konto z e-mailem {email} juz istnieje.")
        sys.exit(1)

    name = input("Imie i nazwisko: ").strip()

    password = getpass.getpass("Haslo (min. 8 znakow): ")
    if len(password) < 8:
        print("Haslo musi miec co najmniej 8 znakow.")
        sys.exit(1)
    password_confirm = getpass.getpass("Powtorz haslo: ")
    if password != password_confirm:
        print("Hasla sie nie zgadzaja.")
        sys.exit(1)

    uid = next_user_id(conn)
    conn.execute(
        "INSERT INTO users (ID_Uzytkownika, Email, Imie_i_nazwisko, Haslo_Hash, Rola, Aktywny, Data_utworzenia) "
        "VALUES (?, ?, ?, ?, 'Admin', 1, ?)",
        (uid, email, name, generate_password_hash(password, method=PASSWORD_HASH_METHOD),
         datetime.datetime.now().isoformat(timespec="seconds")),
    )
    conn.commit()
    conn.close()
    print(f"Utworzono konto Admin: {uid} <{email}>")


if __name__ == "__main__":
    main()
