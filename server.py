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
Otwiera:       http://localhost:8000/
Zatrzymanie:   Ctrl+C
"""

import datetime
import json
import os
import re
import secrets
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from collections import defaultdict

from flask import Flask, abort, g, jsonify, redirect, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

from baza_danych.backup_db import create_backup, enforce_retention, list_backups
from baza_danych.schema_migrate import migrate_schema, ensure_komentarze_table, ensure_ticket_role_columns

ROOT = os.path.dirname(os.path.abspath(__file__))
# Lokalnie zawsze domyslna sciezka w repo (baza juz tam jest). DATABASE_PATH ustawiane w
# srodowisku - typowo pod Render, gdzie wskazuje na zamontowany "persistent disk", bo
# katalog repo jest tam ulotny i znika przy kazdym redeployu (patrz README, sekcja Render).
DB_PATH = os.environ.get("DATABASE_PATH", os.path.join(ROOT, "baza_danych", "baza_projektow.db"))
PORT = int(os.environ.get("PORT", 8000))


def ensure_database_ready():
    # Wywolywane raz przy imporcie modulu (nie tylko w main()) - gunicorn pod Render
    # importuje "server:app" bezposrednio i nigdy nie woła main(), wiec ten check musi
    # zyc na poziomie modulu, zeby zadzialac tez tam.
    if os.path.exists(DB_PATH):
        return
    if not os.environ.get("DATABASE_PATH"):
        # lokalne uzycie bez jawnie ustawionej zmiennej - najpewniej ktos zapomnial
        # zmigrowac dane; lepiej przerwac z jasna instrukcja niz cicho wystartowac pusto
        print(f"Brak bazy danych: {DB_PATH}")
        print("Uruchom najpierw: python3 baza_danych/excel_to_sqlite.py")
        sys.exit(1)
    # DATABASE_PATH ustawione jawnie (typowo swiezy "persistent disk" na Render) - zainicjuj
    # pusty schemat zamiast wymagac recznego dostepu do powloki przy pierwszym wdrozeniu
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    schema_path = os.path.join(ROOT, "baza_danych", "schema.sql")
    conn = sqlite3.connect(DB_PATH)
    with open(schema_path, encoding="utf-8") as f:
        conn.executescript(f.read())
    conn.close()
    print(f"Zainicjowano pustą bazę danych pod {DB_PATH} (schema.sql) - DATABASE_PATH było ustawione, a plik nie istniał.")


def backup_on_startup():
    # Tak samo jak ensure_database_ready() - zyje na poziomie modulu (nie tylko w main()),
    # zeby zadzialac tez pod gunicornem/Render, ktory main() nigdy nie woła. Dzieki temu kazdy
    # start procesu (w tym automatyczny redeploy po git push) zabezpiecza stan bazy sprzed
    # nowego kodu, zanim ten zdazy cokolwiek zmienic.
    try:
        dest_path = create_backup()
        enforce_retention()
        return f"Backup przy starcie: {os.path.basename(dest_path)}"
    except Exception as e:
        # nieudany backup nie moze zablokowac startu procesu - tylko ostrzezenie
        return f"Backup przy starcie nie powiódł się (proces i tak startuje): {e}"


ensure_database_ready()
SCHEMA_MIGRATION_NOTE = migrate_schema(DB_PATH)  # idempotentny - no-op po pierwszym udanym uruchomieniu
ensure_komentarze_table(DB_PATH)  # jw. - nowa tabela, CREATE TABLE IF NOT EXISTS wiec bezpieczne za kazdym startem
ensure_ticket_role_columns(DB_PATH)  # jw. - nowe nullable kolumny, ALTER TABLE ADD COLUMN bezpieczne za kazdym startem
STARTUP_BACKUP_NOTE = backup_on_startup()
# Wypisane tu, nie tylko w main() ponizej - main() nie jest wolane pod gunicornem/Render
# (ktory tylko importuje "server:app"), wiec bez tego ewentualny nieudany backup przy
# starcie (patrz komentarz w backup_on_startup) przechodzilby produkcyjnie bez sladu w logach.
print(SCHEMA_MIGRATION_NOTE)
print(STARTUP_BACKUP_NOTE)

app = Flask(__name__, static_folder=None)

# Produkcja (Render) jest za Cloudflare (potwierdzone naglowkami odpowiedzi na zywo, audyt
# 2026-07-10) - bez tego request.remote_addr widzialby adres proxy, nie prawdziwy IP klienta,
# co zanizaloby skutecznosc limitu logowan (kazdy klient wygladalby jak ten sam adres) i
# zafalszowywalo dochodzenie po fakcie z logow. x_for=1 zaklada DOKLADNIE jedna warstwe
# proxy przed aplikacja - jesli Render dokłada wlasna, wewnetrzna warstwe posrednia (nie
# potwierdzone stad), ta liczba wymaga korekty; zbyt wysoka wartosc otwiera mozliwosc
# podszycia sie pod inny IP przez naglowek X-Forwarded-For.
if os.environ.get("DATABASE_PATH"):
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)

# python3 na macOS (system Python, linkowany z LibreSSL) nie ma hashlib.scrypt, czyli
# domyslna metoda generate_password_hash() (scrypt) rzuca AttributeError - zweryfikowane
# bezposrednio. pbkdf2:sha256 dziala wszedzie, wiec jest jedyna dopuszczalna metoda w tym pliku.
PASSWORD_HASH_METHOD = "pbkdf2:sha256"
_DUMMY_PASSWORD_HASH = generate_password_hash("nie-jest-to-prawdziwe-haslo", method=PASSWORD_HASH_METHOD)


def _load_or_create_secret_key():
    env_key = os.environ.get("SECRET_KEY")
    if env_key:
        return env_key
    if os.environ.get("DATABASE_PATH"):
        # Wdrozenie (np. Render) - checkout kodu jest ulotny (przebudowywany przy kazdym
        # deployu), wiec cichy fallback do pliku ponizej generowalby NOWY klucz przy kazdym
        # restarcie = wszyscy zalogowani wylogowani bez ostrzezenia, w kolko. render.yaml ma
        # SECRET_KEY z generateValue: true, wiec to dziala "z pudelka" po Blueprint deployu -
        # ten blad chroni przed cichym zepsuciem, gdyby ktos pozniej recznie wyczyscil zmienna.
        raise RuntimeError(
            "SECRET_KEY nie jest ustawione, a DATABASE_PATH wskazuje na wdrozenie produkcyjne - "
            "odmawiam startu z tymczasowym kluczem. Ustaw SECRET_KEY w zmiennych srodowiskowych."
        )
    # Lokalnie: wygodny fallback do pliku obok bazy, zeby nie trzeba bylo recznie ustawiac
    # zmiennej srodowiskowej na laptopie.
    key_path = os.path.join(ROOT, "baza_danych", "secret_key.txt")
    if os.path.exists(key_path):
        with open(key_path, "r", encoding="utf-8") as f:
            return f.read().strip()
    key = secrets.token_hex(32)
    with open(key_path, "w", encoding="utf-8") as f:
        f.write(key)
    return key


app.secret_key = _load_or_create_secret_key()
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    # DATABASE_PATH ustawione = wdrozenie (np. Render, patrz render.yaml), ktore terminuje
    # TLS przed aplikacja - wtedy ciasteczko powinno isc wylacznie po HTTPS. Lokalnie (brak
    # zmiennej, LAN po zwyklym http://) zostaje False - Secure=True zablokowaloby zapisanie
    # ciasteczka bez TLS wcale, czyli login nigdy by sie nie utrzymal.
    SESSION_COOKIE_SECURE=bool(os.environ.get("DATABASE_PATH")),
    # Bez tego Flask i tak odrzuca podpisana ciasteczko po swoim wlasnym domyslnym max_age
    # (31 dni) - jawne 7 dni to swiadomy, krotszy wybor dla appki firmowej, plus
    # session.permanent=True przy logowaniu (patrz auth_login/auth_google_callback), zeby
    # samo ciasteczko tez nioslo realne Max-Age zamiast wygasac dopiero przy zamknieciu
    # przegladarki (ktora wiele osob trzyma otwarta tygodniami).
    PERMANENT_SESSION_LIFETIME=datetime.timedelta(days=7),
)

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
    "users": ("ID_Uzytkownika", "USR", 3),
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
        # Bez tego wspolbiezny zapis (np. dwie osoby zapisuja rozne rekordy w tej samej
        # sekundzie) od razu rzuca nieobslugiwany "database is locked" zamiast poczekac -
        # 5s daje sqlite3 szanse zeby transakcja w toku po prostu sie zakonczyla.
        g.db.execute("PRAGMA busy_timeout = 5000")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


# CSP dopasowane do tego, co appka faktycznie laduje (audyt bezpieczenstwa: zero naglowkow
# bezpieczenstwa wczesniej) - script-src BEZ 'unsafe-inline' dziala, bo caly JS jest w
# plikach (zero inline <script>/onclick, jedyny znaleziony przypadek onclick zostal
# przepisany na delegowany listener przy tej samej okazji). style-src potrzebuje
# 'unsafe-inline' - app.js generuje mnostwo inline style="" na elementach, przepisanie
# tego na klasy CSS to osobny, znacznie wiekszy refaktor. connect-src dopuszcza jawnie
# tylko CEIDG (jedyne zewnetrzne wywolanie fetch() w calej appce, patrz przycisk "Pobierz
# z CEIDG"). frame-ancestors 'none' + X-Frame-Options: DENY = podwojna, nadmiarowa ochrona
# przed clickjackingiem (nowe i stare przegladarki).
_CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; "
    "font-src 'self'; "
    "connect-src 'self' https://dane.biznes.gov.pl; "
    "frame-ancestors 'none'; "
    "base-uri 'self'; "
    "form-action 'self'"
)


@app.after_request
def security_headers(resp):
    resp.headers["Content-Security-Policy"] = _CSP
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "same-origin"
    # HSTS ma sens tylko na wdrozeniu za TLS (DATABASE_PATH ustawione = Render, patrz ta
    # sama konwencja co SESSION_COOKIE_SECURE wyzej) - lokalnie po zwyklym http:// wymuszalby
    # HTTPS na localhost, co zepsuloby dev bez TLS.
    if os.environ.get("DATABASE_PATH"):
        resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return resp


_table_columns_cache = {}


def table_columns(conn, table):
    # Schemat jest stary na cale zycie procesu (TABLES sie nie zmienia w locie) - PRAGMA
    # table_info wystarczy odpytac raz na tabele, a nie przy kazdym POST/PUT.
    if table not in _table_columns_cache:
        _table_columns_cache[table] = [row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    return _table_columns_cache[table]


_column_types_cache = {}


def column_types(conn, table):
    # {nazwa_kolumny: zadeklarowany_typ} wprost z schema.sql (przez PRAGMA table_info) -
    # pozwala walidowac liczby generycznie (kazda kolumna REAL/INTEGER), bez trzymania
    # osobnej, latwej do rozjechania sie listy "ktore pola sa liczbowe" w drugim miejscu.
    if table not in _column_types_cache:
        _column_types_cache[table] = {
            row["name"]: row["type"].upper() for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
        }
    return _column_types_cache[table]


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
    data = request.get_json(force=True, silent=True)
    if data is None:
        data = {}
    elif not isinstance(data, dict):
        # np. cialo JSON to tablica/liczba/string zamiast obiektu - bez tego "".items()
        # nizej rzuca AttributeError, ktory ucieka jako surowy 500 zamiast czytelnego 400.
        abort(400)
    valid_cols = table_columns(conn, table)
    exclude = set(exclude) | set(ALWAYS_STRIP_FIELDS.get(table, ()))
    return {k: v for k, v in data.items() if k in valid_cols and k not in exclude}


# ---------------------------------------------------------------- role i uprawnienia (RBAC)
#
# COO i Admin maja identyczne uprawnienia (ustalone wprost z uzytkownikiem) - rozne etykiety,
# nie rozne prawa. Specjalista i Architekt_PM maja zakres opisany w macierzy w README/planie;
# szczegoly ponizej w can_write(). Kolumna Rola=NULL (konto Oczekujace) nigdy nie dociera tutaj
# jako g.user - before_request blokuje ja wczesniej (patrz load_user).

FULL_ACCESS_ROLES = {"COO", "Admin"}
VALID_ROLES = {None, "Specjalista", "Architekt_PM", "COO", "Admin"}
# Role, ktorych odczyt jest zawezony do wlasnych projektow i pozbawiony pol finansowych
# (patrz scoped_rows()/redact_row()) - jedna definicja zamiast dwoch niezaleznych porownan
# do literalu "Specjalista" (audyt: latwo dopisac druga zawezona role w jednym miejscu
# i przeoczyc drugie).
PORTFOLIO_RESTRICTED_ROLES = {"Specjalista"}

# "global" = ta sama tabela dla wszystkich (np. rejestr zespolu), "root_project" = sama
# tabela projekty (jej wlasny PK ID_Projektu = "czyj to projekt"), "project_scoped" = ma
# kolumne FK ID_Projektu wskazujaca na projekty, "admin_only" = wylacznie COO/Admin.
TABLE_SCOPE = {
    "projekty": "root_project",
    "zespol": "global",
    "podwykonawcy": "global",
    "przypisania": "project_scoped",
    "harmonogram": "project_scoped",
    "zadania_tickety": "project_scoped",
    "kamienie_milowe": "project_scoped",
    "ryzyka_i_problemy": "project_scoped",
    "raporty_statusowe": "project_scoped",
    "przypisania_podwykonawcow": "project_scoped",
    "users": "admin_only",
}

# Pola zerowane w odpowiedzi GET wylacznie dla roli Specjalista (nigdy nie usuwane - fmtMoney()/
# num() w app.js juz renderuja null jako "—", wiec ukrywanie dziala bez zmian frontendu).
FINANCIAL_FIELDS = {
    "projekty": ["Budzet_calkowity", "Budzet_wydany", "Przychod_planowany",
                 "Przychod_rzeczywisty", "Stawka_godzinowa_srednia"],
    "zespol": ["Stawka_godzinowa"],
    "zadania_tickety": ["Wycena_podwykonawcy"],
    "przypisania_podwykonawcow": ["Wartosc_umowy"],
    "raporty_statusowe": ["Budzet_wydany_skumulowany"],
}

# Pola bezwarunkowo usuwane z kazdej odpowiedzi GET i niemozliwe do ustawienia przez
# parse_payload (patrz wyzej) - nawet Admin nie widzi tego w JSON-ie, hasla ustawiaja
# wylacznie dedykowane endpointy /api/auth/change-password i /api/users/<id>/reset-password.
ALWAYS_STRIP_FIELDS = {"users": ["Haslo_Hash", "Google_Sub"]}


def assigned_project_ids(conn, person_id):
    # Kierownik_projektu w tabeli projekty to wolny tekst, nie FK - za mala pewnosc pod
    # uprawnienia. przypisania jest juz poprawnie FK-owane, wiec to ono jest zrodlem prawdy
    # o tym, do jakich projektow dana osoba ma dostep (niezaleznie od Rola_w_projekcie -
    # ograniczenie tylko do "Kierownik projektu" odcieloby PM-owi zarzadzanie projektem
    # kolegi, na ktorym jest czlonkiem wspierajacym).
    if not person_id:
        return set()
    rows = conn.execute("SELECT DISTINCT ID_Projektu FROM przypisania WHERE ID_Osoby = ?", (person_id,)).fetchall()
    return {r["ID_Projektu"] for r in rows}


def scoped_rows(conn, user, table, rows, allowed=None):
    # Specjalista czytal dotad CALY portfel (redagowane byly tylko pola finansowe) - zaweniete
    # na wprost zadanie uzytkownika do wlasnych projektow (przez przypisania), zeby nazwa
    # klienta/opis ryzyka/tresc raportu statusowego projektu, przy ktorym nie pracuje, tez nie
    # wyciekaly. Architekt_PM i COO/Admin maja portfolio-wide odczyt bez zmian (byla to ich
    # wczesniejsza, swiadoma konfiguracja - to zawezenie dotyczy wylacznie Specjalisty).
    # zespol/podwykonawcy (scope "global") i users (scope "admin_only") zostaja bez zmian -
    # to wspoldzielone rejestry, nie dane "nalezace" do jednego projektu.
    # `allowed` opcjonalnie z gory wyliczone przez wolajacego (patrz bootstrap()) - unika
    # przeliczania tego samego SELECT-u raz na kazda z 8 project_scoped/root_project tabel
    # (audyt: 9 identycznych zapytan na jeden bootstrap Specjalisty bez tego).
    if user["Rola"] not in PORTFOLIO_RESTRICTED_ROLES or TABLE_SCOPE.get(table) not in ("root_project", "project_scoped"):
        return rows
    if allowed is None:
        allowed = assigned_project_ids(conn, user["ID_Osoby"])
    return [r for r in rows if r["ID_Projektu"] in allowed]


def can_write(conn, user, action, table, row):
    """action: "create" | "update" | "delete". row: sparsowany payload (create) albo
    istniejacy wiersz z bazy (update/delete) - zawsze dict, nigdy None."""
    if user["Rola"] in FULL_ACCESS_ROLES:
        return True
    scope = TABLE_SCOPE.get(table)
    if scope in ("admin_only", None):
        return False
    if user["Rola"] == "Specjalista":
        if table != "zadania_tickety" or action == "delete":
            return False
        if action == "create":
            return row.get("ID_Projektu") in assigned_project_ids(conn, user["ID_Osoby"])
        # edycja tylko wlasnego ticketu W PROJEKCIE, do ktorego jest przypisany - bez drugiego
        # warunku Specjalista mogl "reparent'owac" wlasny ticket (zmienic ID_Projektu) do
        # DOWOLNEGO projektu w systemie, bo re-check w item() po zmianie zakresu i tak sprawdza
        # tylko ID_Osoby_przypisanej, ktore sie nie zmienia w takim ataku
        return (row.get("ID_Osoby_przypisanej") == user["ID_Osoby"]
                and row.get("ID_Projektu") in assigned_project_ids(conn, user["ID_Osoby"]))
    if user["Rola"] == "Architekt_PM":
        if table == "zespol":
            return False
        if table == "projekty" and action == "delete":
            return False  # kaskadowe usuniecie zbyt ryzykowne nawet dla wlasnego projektu
        if table == "podwykonawcy":
            return action != "delete"  # wspolna biblioteka - usuwanie tylko COO/Admin
        if table == "projekty" and action == "create":
            return True  # nowy projekt - brak jeszcze wlasciciela na tym etapie
        return row.get("ID_Projektu") in assigned_project_ids(conn, user["ID_Osoby"])
    return False


def redact_row(user, table, row):
    if row is None:
        return None
    for field in ALWAYS_STRIP_FIELDS.get(table, ()):
        row.pop(field, None)
    if user["Rola"] in PORTFOLIO_RESTRICTED_ROLES:
        for field in FINANCIAL_FIELDS.get(table, ()):
            if field in row:
                row[field] = None
    return row


# Komunikaty dla konkretnych "table.kolumna" z UNIQUE constraint - dopasowywane przez
# podciag do tekstu sqlite3.IntegrityError. Rejestr zamiast "if table == X" w
# integrity_error_message() (audyt) - kolejny przyjazny komunikat to nowy wpis, nie nowa galaz.
UNIQUE_CONSTRAINT_MESSAGES = {
    "users.Email": "Ten adres e-mail jest już używany przez inne konto.",
}


def integrity_error_message(e, table):
    # Surowy sqlite3.IntegrityError (nazwy tabel/kolumn - szczegoly schematu) nie powinien
    # wyciekac do klienta przez API - loginujemy oryginal server-side i zwracamy czytelny,
    # ogolny komunikat po polsku, ze swiadomymi wyjatkami z UNIQUE_CONSTRAINT_MESSAGES dla
    # najczestszych realnych przypadkow, na ktore warto dac uzytkownikowi konkretna wskazowke.
    print(f"IntegrityError ({table}): {e}")
    for needle, message in UNIQUE_CONSTRAINT_MESSAGES.items():
        if needle in str(e):
            return message
    return "Nie można zapisać — rekord narusza unikalność danych albo relację z innym rekordem."


def validate_user_payload(data, existing):
    if "Rola" in data and data["Rola"] not in VALID_ROLES:
        return "Nieprawidłowa rola."
    merged_role = data["Rola"] if "Rola" in data else (existing.get("Rola") if existing else None)
    merged_person = data["ID_Osoby"] if "ID_Osoby" in data else (existing.get("ID_Osoby") if existing else None)
    if merged_role in ("Specjalista", "Architekt_PM") and not merged_person:
        return "Ta rola wymaga powiązania z osobą z zespołu."
    return None


# Dwa male rejestry zaczepow per-tabela dla collection()/item() - zamiast rozrzuconych
# "if table == X: ..." w generycznej fabryce CRUD (audyt: bylo tak zrobione w 3 miejscach
# dla "users"). Brak wpisu = brak dodatkowego zachowania, wiec collection()/item() nigdy
# nie wymagaja zmiany przy dopisywaniu kolejnej tabeli tutaj.
def _default_zglaszajacy(data, user):
    # Auto-wypelnienie zglaszajacego zalogowana osoba - fallback dla wywolan API z pominietym
    # polem (frontend i tak domyslnie ustawia je na aktualnie zalogowana osobe w dropdownie,
    # patrz openTicketForm w app.js). setdefault() by tu NIE wystarczylo - zadziala tylko gdy
    # klucz jest calkowicie nieobecny, nie gdy jest jawnie null (a serializeForApi() w app.js
    # zamienia "" z niewybranego <select> na null przed wyslaniem), wiec sprawdzamy falszywosc
    # wprost zamiast samej obecnosci klucza.
    if not data.get("ID_Osoby_zglaszajacej") and user.get("ID_Osoby"):
        data["ID_Osoby_zglaszajacej"] = user["ID_Osoby"]


TABLE_VALIDATORS = {
    "users": validate_user_payload,
}
TABLE_CREATE_DEFAULTS = {
    # Konta zakladane przez create_admin.py i logowanie Google juz stempluja to przy INSERT -
    # to domyka trzecia sciezke (COO/Admin tworzy konto w samej appce).
    "users": lambda data, user: data.setdefault("Data_utworzenia", datetime.datetime.now().isoformat(timespec="seconds")),
    "zadania_tickety": _default_zglaszajacy,
}


def _has_full_access(row):
    return row.get("Rola") in FULL_ACCESS_ROLES and int(row.get("Aktywny", 1) or 0) != 0


def guard_last_admin(conn, existing, data=None, deleting=False):
    """Zwraca komunikat bledu (string) albo None. Bez tego dawaloby sie usunac/zdegradowac/
    dezaktywowac OSTATNIE konto COO/Admin (nawet przez inne konto COO/Admin, nie tylko przez
    samego siebie) - appka zostawalaby bez nikogo, kto moze zarzadzac kontami albo odzyskac
    sobie dostep."""
    if not _has_full_access(existing):
        return None
    stays_full_access = False if deleting else _has_full_access({**existing, **(data or {})})
    if stays_full_access:
        return None
    remaining = conn.execute(
        "SELECT COUNT(*) FROM users WHERE Rola IN ('COO', 'Admin') AND Aktywny = 1 AND ID_Uzytkownika != ?",
        (existing["ID_Uzytkownika"],),
    ).fetchone()[0]
    if remaining == 0:
        return "Nie można usunąć/dezaktywować/zdegradować ostatniego konta z pełnym dostępem (COO/Admin)."
    return None


# ---------------------------------------------------------------- walidacja pol (enum + zakresy)
#
# Audyt potwierdzil empirycznie, ze bez tego np. POST /api/projekty {"Status":"asdf"} przechodzi
# bez bledu i wiersz po prostu znika ze wszystkich filtrow/kafelkow w app.js (kazdy byStatus/byRag
# porownuje przez ===) - bez zadnego komunikatu, ze cos poszlo nie tak. Listy ponizej sa 1:1
# skopiowane z odpowiadajacych im stalych w dashboard/app.js (TYPE_ORDER, STATUSES, FAZY, ...) -
# to dwa niezalezne zrodla tej samej prawdy (JS dla <select>, Python dla walidacji zapisu), wiec
# przy dopisywaniu nowej wartosci do dropdowna w UI dopisz ja tez tutaj.
ENUM_FIELDS = {
    "projekty": {
        "Typ_projektu": {"Projekt koncepcyjny", "Analiza urbanistyczna", "Projekt budowlany",
                          "Projekt wykonawczy", "Nadzor autorski", "Konkurs", "Projekt techniczny (PT)", "Inne"},
        "Funkcja_biura": {"Projektant wiodacy", "Nadzor autorski", "Analiza/doradztwo",
                           "Uczestnik konkursu", "Koordynacja branzowa"},
        "Segment": {"Mieszkaniowy", "Komercyjny", "Publiczny", "Zielen"},
        "Status": {"Planowanie", "W realizacji", "Wstrzymany", "Zakonczony", "Anulowany"},
        # "Projektowanie" i "Pozwolenia/Przetarg" swiadomie usuniete (nie dopisane obok) - rozbite
        # na szczegolowe fazy ponizej, na wprost zyczenie uzytkownika (2026-07-10). "Konkurs - etap
        # studialny" zmienione na "... etap I (studialny)" dla symetrii z etapem II - jeden istniejacy
        # projekt produkcyjny mial ta wartosc, wymaga recznej aktualizacji w UI po wdrozeniu.
        "Faza": {"Analiza", "Projekt studialny", "Konkurs jednoetapowy", "Konkurs - etap I (studialny)",
                 "Konkurs - etap II", "Koncepcja", "Projekt budowlany", "Projekt techniczny",
                 "Przetarg", "Projekt wykonawczy", "Budowa", "Nadzor autorski", "Zakonczenie"},
        "Priorytet": {"Wysoki", "Sredni", "Niski"},
        "RAG_Status": {"Zielony", "Zolty", "Czerwony"},
    },
    "zespol": {
        "Dzial": {"Architekci", "Specjalisci", "Kierownictwo projektow", "PMO", "Prawny",
                   "Finansowy", "Marketing/Sprzedaz", "Zarzad"},
        "Aktywny": {"Tak", "Nie"},
    },
    "przypisania": {
        "Rola_w_projekcie": {"Sponsor", "Owner", "Kierownik projektu", "Czlonek zespolu", "Wsparcie/Konsultant"},
        "Status": {"Aktywny", "Zakonczony"},
    },
    "harmonogram": {
        "Kategoria": {"Koncepcja", "Konsultacje", "Projektowanie", "Rysunki wykonawcze",
                       "Dokumentacja przetargowa", "Pozwolenia/Uzgodnienia", "Nadzor autorski",
                       "Koordynacja branzowa", "Wizja lokalna/Spotkanie", "Prezentacja", "Administracja/Inne"},
        "Status": {"Nie rozpoczete", "W trakcie", "Zakonczone", "Opoznione"},
        "Priorytet": {"Wysoki", "Sredni", "Niski"},
        "Kamien_milowy": {"Tak", "Nie"},
    },
    "zadania_tickety": {
        "Priorytet": {"Wysoki", "Sredni", "Niski"},
        "Status": {"Backlog", "W tym tygodniu", "W trakcie", "Do przegladu", "Zrobione",
                    "Zablokowane", "Zarchiwizowane"},
    },
    # Audyt: brakowalo tego wpisu (i calego UI tworzenia/edycji w app.js - patrz commit) mimo
    # ze milestoneStatusBadge() w app.js juz zaklada zamkniety zestaw wartosci.
    "kamienie_milowe": {
        "Status": {"Nie rozpoczete", "W trakcie", "Zakonczone", "Zagrozone"},
    },
    "podwykonawcy": {
        "Branza": {"Elektryczna", "Sanitarna/Hydrauliczna", "Gazowa", "Wentylacja i klimatyzacja",
                    "Konstrukcyjna", "Drogowa/Infrastruktura", "Teletechniczna/IT", "Przeciwpozarowa", "Inna"},
        "Typ_wspolpracy": {"Projektant branzowy", "Wykonawca robot", "Dostawca", "Konsultant"},
        "Ocena": {"Wysoka", "Srednia", "Niska", "Brak oceny"},
        "Status": {"Aktywny", "Nieaktywny", "Zweryfikowany", "Czarna lista"},
    },
    "ryzyka_i_problemy": {
        "Typ": {"Ryzyko", "Problem"},
        "Kategoria": {"Prawne", "Finansowe", "Techniczne", "Harmonogramowe", "Zasoby",
                       "Srodowiskowe", "Proceduralne/Przetargowe"},
        "Priorytet": {"Wysoki", "Sredni", "Niski"},
        "Status": {"Otwarte", "W trakcie", "Zamkniete"},
    },
    "przypisania_podwykonawcow": {
        "Status": {"Planowany", "Aktywny", "Zakonczony", "Wstrzymany"},
    },
    "raporty_statusowe": {
        "RAG_Status": {"Zielony", "Zolty", "Czerwony"},
    },
}

# (min, max) dla pol procentowych, ktore formularz w app.js przycina po stronie klienta
# (input type=number min=/max=), ale API dotad przyjmowalo cokolwiek. Procent_postepu i
# Procent_ukonczenia sa w bazie ulamkiem 0..1 (formularz dzieli przez 100 przed wyslaniem),
# reszta to wprost 0..100 (Procent_zaangazowania celowo do 200 - formularz pozwala na
# przeciazenie >100%, patrz jego wlasny min=0 max=200).
NUMERIC_RANGES = {
    "projekty": {"Procent_postepu": (0.0, 1.0)},
    "harmonogram": {"Procent_ukonczenia": (0.0, 1.0)},
    "raporty_statusowe": {"Procent_postepu": (0.0, 1.0)},
    "zespol": {"Dostepnosc_FTE_procent": (0, 100)},
    "przypisania": {"Procent_zaangazowania": (0, 200)},
}


def validate_field_types_and_ranges(conn, table, data):
    """Zwraca komunikat bledu (string) albo None. Liczby walidowane generycznie na podstawie
    zadeklarowanego typu kolumny (REAL/INTEGER) w schema.sql - nie osobna, rowna sie latwa do
    rozjechania sie lista "ktore pola sa liczbowe"."""
    col_types = column_types(conn, table)
    for field, value in data.items():
        if value is None or value == "":
            continue
        if col_types.get(field) in ("REAL", "INTEGER"):
            try:
                float(value)
            except (TypeError, ValueError):
                return f"Pole {field} musi być liczbą (otrzymano: {value!r})."
    for field, valid_values in ENUM_FIELDS.get(table, {}).items():
        if field in data and data[field] is not None and data[field] not in valid_values:
            return f"Nieprawidłowa wartość pola {field}: {data[field]!r}."
    for field, (lo, hi) in NUMERIC_RANGES.get(table, {}).items():
        if field in data and data[field] is not None:
            try:
                v = float(data[field])
            except (TypeError, ValueError):
                continue  # juz zgloszone przez petle typow wyzej
            if not (lo <= v <= hi):
                return f"Pole {field} musi być w zakresie {lo}-{hi} (otrzymano: {v})."
    return None


# ---------------------------------------------------------------- konta / logowanie / sesje

LOGIN_MAX_ATTEMPTS = 5
LOGIN_LOCKOUT_SECONDS = 15 * 60
_login_attempts = defaultdict(list)  # "{ip}:{email}" -> [timestampy nieudanych prob]
# W pamieci procesu, nie przetrwa restartu - to jest jeden proces app.run() obslugujacy
# kilkanascie osob na LAN, nie produkcyjny multi-worker deployment. Wystarczajace tarcie,
# nie prawdziwa ochrona przed rozproszonym atakiem.


def _rate_limit_key(email):
    return f"{request.remote_addr}:{email}"


def _is_locked_out(key):
    now = time.time()
    attempts = [t for t in _login_attempts[key] if now - t < LOGIN_LOCKOUT_SECONDS]
    # Bez tego kazdy klucz raz odwiedzony (nawet udanym logowaniem za pierwszym razem, bo ta
    # funkcja jest wolana przed sprawdzeniem hasla) zostawal w defaultdict na zawsze jako pusta
    # lista - nieograniczony wzrost przez cale zycie procesu (audyt). Pop zamiast trzymania [].
    if attempts:
        _login_attempts[key] = attempts
    else:
        _login_attempts.pop(key, None)
    return len(attempts) >= LOGIN_MAX_ATTEMPTS


def _record_failed_attempt(key):
    _login_attempts[key].append(time.time())


def get_current_user():
    # Swieze zapytanie do bazy na kazdy request (nigdy nie ufa niczemu poza golym uid z
    # podpisanego ciasteczka) - dzieki temu dezaktywacja konta (Aktywny=0) dziala natychmiast
    # na kolejnym requescie, bez potrzeby wylogowania/wygasniecia ciasteczka.
    uid = session.get("uid")
    if not uid:
        return None
    row = get_db().execute("SELECT * FROM users WHERE ID_Uzytkownika = ?", (uid,)).fetchone()
    if row is None or not row["Aktywny"]:
        return None
    return dict(row)


def public_user(row):
    return {
        "id": row["ID_Uzytkownika"],
        "email": row["Email"],
        "name": row["Imie_i_nazwisko"],
        "role": row["Rola"],
        "personId": row["ID_Osoby"],
        "pending": row["Rola"] is None,
    }


def _google_oauth_config():
    """Client id/secret/redirect_uri, albo None jesli logowanie Google nie jest skonfigurowane.
    Zmienne srodowiskowe nadpisuja baza_danych/oauth_config.json (ten drugi gitignorowany,
    wygodny lokalnie; zmienne srodowiskowe wygodne pod Render - patrz README)."""
    client_id = os.environ.get("GOOGLE_CLIENT_ID")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET")
    redirect_uri = os.environ.get("GOOGLE_REDIRECT_URI")
    cfg_path = os.path.join(ROOT, "baza_danych", "oauth_config.json")
    if not (client_id and client_secret) and os.path.exists(cfg_path):
        try:
            with open(cfg_path, encoding="utf-8") as f:
                cfg = json.load(f)
        except (OSError, json.JSONDecodeError):
            cfg = {}
        client_id = client_id or cfg.get("client_id")
        client_secret = client_secret or cfg.get("client_secret")
        redirect_uri = redirect_uri or cfg.get("redirect_uri")
    if not (client_id and client_secret):
        return None
    return {
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri or f"http://localhost:{PORT}/api/auth/google/callback",
    }


PUBLIC_API_PATHS = {"/api/auth/login", "/api/auth/google/login", "/api/auth/google/callback",
                     "/api/auth/config", "/api/health"}
PENDING_OK_PATHS = {"/api/auth/me", "/api/auth/logout", "/api/auth/change-password"}
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


@app.before_request
def csrf_guard():
    # SameSite=Lax juz samo w sobie wystarcza (nie dolacza ciasteczka do cross-site
    # POST/PUT/DELETE niezaleznie od <form> czy fetch()), a brak nagłowkow CORS blokuje
    # cross-origin fetch() z JSON-em przez nieudany preflight. Ten naglowek to tani,
    # dodatkowy check na wypadek nietypowej konfiguracji przegladarki - kazde wywolanie
    # apiRequest() w app.js go wysyla.
    if (request.method not in SAFE_METHODS and request.path.startswith("/api/")
            and request.headers.get("X-Requested-With") != "fetch"):
        abort(403)


@app.before_request
def load_user():
    g.user = get_current_user()
    if not request.path.startswith("/api/") or request.path in PUBLIC_API_PATHS:
        return
    if g.user is None:
        abort(401)
    if request.path in PENDING_OK_PATHS:
        return
    if g.user["Rola"] is None:
        abort(403)  # konto Oczekujace - zero dostepu do danych, dopoki COO/Admin nie nada roli


@app.route("/api/auth/config")
def auth_config():
    return jsonify({"googleEnabled": _google_oauth_config() is not None})


@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    data = request.get_json(force=True, silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    key = _rate_limit_key(email)
    if _is_locked_out(key):
        return jsonify({"error": "Zbyt wiele nieudanych prób logowania. Spróbuj ponownie za 15 minut."}), 429

    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE lower(Email) = ?", (email,)).fetchone()
    # Haszujemy tez gdy konto nie istnieje (wzgledem sztucznego hasza) - inaczej brak
    # wpisu odpowiada szybciej niz istniejacy, co zdradza czyjs e-mail przez pomiar czasu.
    stored_hash = row["Haslo_Hash"] if (row and row["Haslo_Hash"]) else _DUMMY_PASSWORD_HASH
    password_ok = check_password_hash(stored_hash, password)
    if not row or not row["Haslo_Hash"] or not password_ok or not row["Aktywny"]:
        _record_failed_attempt(key)
        return jsonify({"error": "Nieprawidłowy e-mail lub hasło."}), 401

    _login_attempts.pop(key, None)
    session.clear()
    session.permanent = True
    session["uid"] = row["ID_Uzytkownika"]
    conn.execute(
        "UPDATE users SET Data_ostatniego_logowania = ? WHERE ID_Uzytkownika = ?",
        (datetime.datetime.now().isoformat(timespec="seconds"), row["ID_Uzytkownika"]),
    )
    conn.commit()
    return jsonify(public_user(dict(row)))


@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    session.clear()
    return "", 204


@app.route("/api/auth/me")
def auth_me():
    return jsonify(public_user(g.user))


@app.route("/api/auth/change-password", methods=["POST"])
def auth_change_password():
    # Wczesniej bez zadnego limitu prob (audyt bezpieczenstwa, 2026-07-10) - skradzione, ale
    # wciaz wazne ciasteczko sesji pozwalaloby brute-forcowac prawdziwe haslo bez twardego
    # limitu, ograniczone tylko kosztem liczenia PBKDF2 per proba. Ten sam mechanizm co przy
    # logowaniu (_is_locked_out/_record_failed_attempt), osobny namespace klucza (prefiks
    # "changepw:"), zeby nie mieszac z licznikiem nieudanych logowan.
    key = _rate_limit_key(f"changepw:{g.user['Email']}")
    if _is_locked_out(key):
        return jsonify({"error": "Zbyt wiele nieudanych prób. Spróbuj ponownie za 15 minut."}), 429
    data = request.get_json(force=True, silent=True) or {}
    current_password = data.get("current_password") or ""
    new_password = data.get("new_password") or ""
    if len(new_password) < 8:
        return jsonify({"error": "Nowe hasło musi mieć co najmniej 8 znaków."}), 400
    stored_hash = g.user["Haslo_Hash"] or _DUMMY_PASSWORD_HASH
    if not g.user["Haslo_Hash"] or not check_password_hash(stored_hash, current_password):
        _record_failed_attempt(key)
        return jsonify({"error": "Obecne hasło jest nieprawidłowe."}), 401
    _login_attempts.pop(key, None)
    conn = get_db()
    conn.execute(
        "UPDATE users SET Haslo_Hash = ? WHERE ID_Uzytkownika = ?",
        (generate_password_hash(new_password, method=PASSWORD_HASH_METHOD), g.user["ID_Uzytkownika"]),
    )
    conn.commit()
    return "", 204


# ---------------------------------------------------------------- logowanie Google (OAuth2)
#
# Reczny Authorization Code flow przez stdlib urllib - bez Authlib/google-auth. Tozsamosc
# weryfikowana wywolaniem REST endpointu userinfo Google z tokenem bearer (nie recznym
# dekodowaniem/weryfikacja JWT id_token), wiec zero potrzeby kryptografii RS256.

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"


def _truthy(v):
    return v is True or v == "true"


@app.route("/api/auth/google/login")
def auth_google_login():
    config = _google_oauth_config()
    if not config:
        abort(404)
    state = secrets.token_urlsafe(24)
    session["oauth_state"] = state
    params = {
        "client_id": config["client_id"],
        "redirect_uri": config["redirect_uri"],
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
    }
    return redirect(f"{GOOGLE_AUTH_URL}?{urllib.parse.urlencode(params)}")


@app.route("/api/auth/google/callback")
def auth_google_callback():
    config = _google_oauth_config()
    if not config:
        abort(404)
    # Weryfikacja `state` to CSRF-ochrona samego handshake'u OAuth (osobna od csrf_guard()
    # powyzej, ktory i tak nie dotyczy GET-ow) - jednorazowa wartosc z sesji sprzed przekierowania.
    state = request.args.get("state")
    if not state or state != session.pop("oauth_state", None):
        abort(400)
    code = request.args.get("code")
    if not code:
        abort(400)

    token_body = urllib.parse.urlencode({
        "code": code,
        "client_id": config["client_id"],
        "client_secret": config["client_secret"],
        "redirect_uri": config["redirect_uri"],
        "grant_type": "authorization_code",
    }).encode()
    try:
        token_req = urllib.request.Request(GOOGLE_TOKEN_URL, data=token_body, method="POST")
        with urllib.request.urlopen(token_req, timeout=10) as resp:
            access_token = json.loads(resp.read())["access_token"]
        userinfo_req = urllib.request.Request(GOOGLE_USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})
        with urllib.request.urlopen(userinfo_req, timeout=10) as resp:
            userinfo = json.loads(resp.read())
    except (urllib.error.URLError, urllib.error.HTTPError, KeyError, json.JSONDecodeError):
        abort(502)

    # Fail-closed: brakujacy klucz (np. Google kiedys zmieni odpowiedz, albo zwroci ja
    # niepelna) ma znaczyc "niezweryfikowany", nie "pomin sprawdzenie" - stad .get(...) z
    # domyslnym None zamiast warunku "if klucz w ogole jest obecny".
    if not _truthy(userinfo.get("email_verified")):
        abort(403)
    google_sub = userinfo.get("sub")
    email = (userinfo.get("email") or "").strip().lower()
    if not google_sub or not email:
        abort(502)

    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE Google_Sub = ?", (google_sub,)).fetchone()
    if row is None:
        # opportunistyczne polaczenie z istniejacym kontem haslowym po tym samym mailu -
        # Google_Sub (nie e-mail) zostaje kluczem tozsamosci od teraz, bo e-mail moze sie zmienic
        row = conn.execute("SELECT * FROM users WHERE lower(Email) = ?", (email,)).fetchone()
        if row is not None:
            conn.execute("UPDATE users SET Google_Sub = ? WHERE ID_Uzytkownika = ?", (google_sub, row["ID_Uzytkownika"]))
            conn.commit()
    if row is None:
        # nowe konto Oczekujace (Rola=NULL) - zero dostepu, dopoki COO/Admin nie nada roli
        uid = next_id(conn, "users", "ID_Uzytkownika", "USR", 3)
        conn.execute(
            "INSERT INTO users (ID_Uzytkownika, Email, Imie_i_nazwisko, Google_Sub, Rola, Aktywny, Data_utworzenia) "
            "VALUES (?, ?, ?, ?, NULL, 1, ?)",
            (uid, email, userinfo.get("name") or email, google_sub, datetime.datetime.now().isoformat(timespec="seconds")),
        )
        conn.commit()
        row = fetch_row(conn, "users", "ID_Uzytkownika", uid)

    if not row["Aktywny"]:
        abort(403)
    session.clear()
    session.permanent = True
    session["uid"] = row["ID_Uzytkownika"]
    conn.execute(
        "UPDATE users SET Data_ostatniego_logowania = ? WHERE ID_Uzytkownika = ?",
        (datetime.datetime.now().isoformat(timespec="seconds"), row["ID_Uzytkownika"]),
    )
    conn.commit()
    # Swiadomie bez parametru ?next= (zawsze na "/") - usuwa cala klase podatnosci
    # open-redirect kosztem zera UX, bo SPA i tak zawsze laduje na tym samym URL.
    return redirect("/")


@app.route("/api/bootstrap")
def bootstrap():
    conn = get_db()
    result = {}
    # Raz na caly request - potrzebne i tak nizej dla "me", wiec liczymy raz i podajemy do
    # kazdego wywolania scoped_rows() zamiast pozwalac mu przeliczac to samo za kazdym razem.
    allowed_projects = assigned_project_ids(conn, g.user["ID_Osoby"])
    for table, key in BOOTSTRAP_KEYS.items():
        rows = conn.execute(f"SELECT * FROM {table}").fetchall()
        rows = scoped_rows(conn, g.user, table, rows, allowed=allowed_projects)
        result[key] = [redact_row(g.user, table, dict(r)) for r in rows]
    result["me"] = public_user(g.user)
    result["me"]["assignedProjectIds"] = sorted(allowed_projects)
    return jsonify(result)


@app.route("/api/<table>", methods=["GET", "POST"])
def collection(table):
    if table not in TABLES:
        abort(404)
    pk, prefix, width = TABLES[table]
    conn = get_db()

    if request.method == "GET":
        if TABLE_SCOPE.get(table) == "admin_only" and g.user["Rola"] not in FULL_ACCESS_ROLES:
            abort(403)
        rows = conn.execute(f"SELECT * FROM {table}").fetchall()
        rows = scoped_rows(conn, g.user, table, rows)
        return jsonify([redact_row(g.user, table, dict(r)) for r in rows])

    data = parse_payload(conn, table)
    if not can_write(conn, g.user, "create", table, data):
        abort(403)
    error = validate_field_types_and_ranges(conn, table, data)
    if error:
        return jsonify({"error": error}), 400
    validator = TABLE_VALIDATORS.get(table)
    if validator:
        error = validator(data, None)
        if error:
            return jsonify({"error": error}), 400
    create_default = TABLE_CREATE_DEFAULTS.get(table)
    if create_default:
        create_default(data, g.user)
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
        return jsonify({"error": integrity_error_message(e, table)}), 409
    pk_val = data.get(pk) or cur.lastrowid
    # {**data, pk: pk_val} to dokladnie to, co przed chwila trafilo do bazy (data juz przeszlo
    # parse_payload, wiec to tylko prawdziwe kolumny) - fetch_row() tutaj bylby zbednym SELECT-em
    # odczytujacym z powrotem to, co juz mamy w pamieci (audyt: brak triggerow/wartosci
    # generowanych przez SQLite poza pk_val, ktore i tak jawnie dokladamy).
    return jsonify(redact_row(g.user, table, {**data, pk: pk_val})), 201


@app.route("/api/<table>/<path:item_id>", methods=["PUT", "DELETE"])
def item(table, item_id):
    if table not in TABLES:
        abort(404)
    pk, _prefix, _width = TABLES[table]
    conn = get_db()

    existing = fetch_row(conn, table, pk, item_id)
    if existing is None:
        abort(404)

    if request.method == "DELETE":
        # can_write() juz odmawia PM-owi/Specjaliscie usuniecia projektu (kaskadowe usuniecie
        # zbyt ryzykowne nawet dla wlasnego) - byl tu przedtem redundantny pre-check tej samej
        # regoly osobnym warunkiem, ktory mogl po cichu rozjechac sie z can_write() przy
        # kolejnej zmianie jednego bez drugiego (znalezione audytem).
        if not can_write(conn, g.user, "delete", table, existing):
            abort(403)
        if table == "users":
            error = guard_last_admin(conn, existing, deleting=True)
            if error:
                return jsonify({"error": error}), 409
        try:
            cur = conn.execute(f"DELETE FROM {table} WHERE {pk} = ?", (item_id,))
            conn.commit()
        except sqlite3.IntegrityError as e:
            print(f"IntegrityError (DELETE {table}): {e}")
            return jsonify({"error": "Nie można usunąć — rekord jest nadal używany gdzie indziej."}), 409
        if cur.rowcount == 0:
            abort(404)
        return "", 204

    if not can_write(conn, g.user, "update", table, existing):
        abort(403)
    data = parse_payload(conn, table, exclude={pk})
    if not data:
        return jsonify({"error": "Brak pól do aktualizacji"}), 400
    # Sprawdz uprawnienia TEZ na obrazie PO zmianie, nie tylko przed - inaczej dawaloby sie
    # "wypchnac"/"wciagnac" wiersz poza dostep zmieniajac dowolne pole, od ktorego zalezy
    # can_write() (nie tylko ID_Projektu - audyt wykazal, ze Specjalista mogl tak samo
    # "oddac" wlasny ticket zmieniajac ID_Osoby_przypisanej, bo byl sprawdzany tylko stan
    # sprzed edycji). Tanie w koszcie (jedno zapytanie wiecej tylko gdy payload cokolwiek
    # zmienia) i odporne na kazde przyszle pole, nie tylko te dwa, ktore juz znamy.
    if not can_write(conn, g.user, "update", table, {**existing, **data}):
        abort(403)
    error = validate_field_types_and_ranges(conn, table, data)
    if error:
        return jsonify({"error": error}), 400
    validator = TABLE_VALIDATORS.get(table)
    if validator:
        error = validator(data, existing)
        if error:
            return jsonify({"error": error}), 400
    if table == "users":
        error = guard_last_admin(conn, existing, data=data)
        if error:
            return jsonify({"error": error}), 409
    set_clause = ", ".join(f"{c} = ?" for c in data.keys())
    try:
        cur = conn.execute(f"UPDATE {table} SET {set_clause} WHERE {pk} = ?", [*data.values(), item_id])
        conn.commit()
    except sqlite3.IntegrityError as e:
        return jsonify({"error": integrity_error_message(e, table)}), 409
    if cur.rowcount == 0:
        abort(404)
    # {**existing, **data} = dokladnie to, co przed chwila trafilo do bazy (stary wiersz z
    # nadpisanymi zmienionymi polami) - ten sam merge juz raz policzony wyzej do re-checku
    # can_write(); fetch_row() tutaj bylby zbednym SELECT-em na dane juz posiadane w pamieci.
    return jsonify(redact_row(g.user, table, {**existing, **data}))


@app.route("/api/zadania_tickety/<ticket_id>/komentarze", methods=["GET", "POST"])
def ticket_comments(ticket_id):
    # Zagniezdzony endpoint, nie kolejna tabela w TABLES/generycznej fabryce collection()/
    # item() - komentarze sa zawsze "komentarze DO konkretnego ticketu", nigdy plaska lista
    # do pobrania w calosci, wiec generyczny GET /api/komentarze_tickety (bez wymuszonego
    # filtra po ID_Tickietu) nie mialby tu sensu. Uprawnienia identyczne jak przy edycji
    # samego ticketu (can_write "update") - bez nowej, osobnej warstwy uprawnien.
    conn = get_db()
    ticket = fetch_row(conn, "zadania_tickety", "ID_Tickietu", ticket_id)
    if ticket is None:
        abort(404)

    if request.method == "GET":
        if not scoped_rows(conn, g.user, "zadania_tickety", [ticket]):
            abort(403)
        rows = conn.execute(
            "SELECT * FROM komentarze_tickety WHERE ID_Tickietu = ? ORDER BY Data_utworzenia", (ticket_id,)
        ).fetchall()
        return jsonify([dict(r) for r in rows])

    if not can_write(conn, g.user, "update", "zadania_tickety", ticket):
        abort(403)
    data = request.get_json(force=True, silent=True) or {}
    tresc = str(data.get("Tresc") or "").strip()
    if not tresc:
        return jsonify({"error": "Treść komentarza nie może być pusta."}), 400
    cid = next_id(conn, "komentarze_tickety", "ID_Komentarza", "KOM", 4)
    autor = g.user.get("Imie_i_nazwisko") or g.user.get("Email")
    try:
        conn.execute(
            "INSERT INTO komentarze_tickety (ID_Komentarza, ID_Tickietu, Autor, Tresc, Data_utworzenia) "
            "VALUES (?, ?, ?, ?, ?)",
            (cid, ticket_id, autor, tresc, datetime.datetime.now().isoformat(timespec="seconds")),
        )
        conn.commit()
    except sqlite3.IntegrityError as e:
        # next_id() skanuje MAX(...) bez blokady - dwa niemal jednoczesne komentarze moga
        # trafic na ten sam ID_Komentarza (jak w generycznej fabryce collection(), patrz wyzej).
        return jsonify({"error": integrity_error_message(e, "komentarze_tickety")}), 409
    return jsonify(fetch_row(conn, "komentarze_tickety", "ID_Komentarza", cid)), 201


@app.route("/api/backup", methods=["GET", "POST"])
def backup():
    if g.user["Rola"] not in FULL_ACCESS_ROLES:
        abort(403)
    if request.method == "GET":
        return jsonify([{"name": name, "size": size} for name, size, _path in list_backups()])
    try:
        dest_path = create_backup()
        removed = enforce_retention()
    except Exception as e:
        print(f"Blad przy tworzeniu backupu: {e}")
        return jsonify({"error": "Nie udało się utworzyć kopii zapasowej. Sprawdź logi serwera."}), 500
    return jsonify({"name": os.path.basename(dest_path), "removed": removed}), 201


@app.route("/api/users/<item_id>/reset-password", methods=["POST"])
def admin_reset_password(item_id):
    if g.user["Rola"] not in FULL_ACCESS_ROLES:
        abort(403)
    conn = get_db()
    target = fetch_row(conn, "users", "ID_Uzytkownika", item_id)
    if target is None:
        abort(404)
    data = request.get_json(force=True, silent=True) or {}
    new_password = data.get("new_password") or ""
    if len(new_password) < 8:
        return jsonify({"error": "Nowe hasło musi mieć co najmniej 8 znaków."}), 400
    # Step-up: reset cudzego hasla wymaga potwierdzenia WLASNEGO hasla wywolujacego admina -
    # bez tego skradzione (ale wciaz wazne) ciasteczko sesji admina pozwalaloby od razu
    # przejac dowolne inne konto, w tym inne konta admin, bez znajomosci jakiegokolwiek
    # hasla (audyt bezpieczenstwa, 2026-07-10). Konta zalozone wylacznie przez Google (brak
    # Haslo_Hash) nie maja czego potwierdzic - fail-closed, nie pomijaj checku.
    admin_password = data.get("admin_password") or ""
    stored_hash = g.user["Haslo_Hash"] or _DUMMY_PASSWORD_HASH
    if not g.user["Haslo_Hash"] or not check_password_hash(stored_hash, admin_password):
        return jsonify({"error": "Potwierdź własne hasło, żeby zresetować hasło innego konta."}), 403
    conn.execute(
        "UPDATE users SET Haslo_Hash = ? WHERE ID_Uzytkownika = ?",
        (generate_password_hash(new_password, method=PASSWORD_HASH_METHOD), item_id),
    )
    conn.commit()
    return "", 204


@app.route("/api/health")
def health():
    # "/" samo w sobie nie mowi nic o bazie - to tylko statyczny index.html, wiec Render
    # moglby raportowac "healthy" nawet gdyby plik .db byl uszkodzony/nieosiagalny. Ten
    # endpoint faktycznie dotyka bazy (SELECT na tabeli, ktora zawsze istnieje po migracji),
    # publiczny (bez logowania - health check nie powinien wymagac sesji).
    try:
        get_db().execute("SELECT COUNT(*) FROM users").fetchone()
    except sqlite3.Error as e:
        # Endpoint publiczny (bez logowania) - szczegoly bledu tylko w logach serwera, nie w
        # odpowiedzi, ten sam powod co integrity_error_message() powyzej.
        print(f"Health check: blad bazy danych: {e}")
        return jsonify({"status": "error"}), 503
    return jsonify({"status": "ok"})


@app.errorhandler(404)
def not_found(_e):
    return jsonify({"error": "not found"}), 404


DASHBOARD_DIR = os.path.join(ROOT, "dashboard")


def _serve(path):
    resp = send_from_directory(DASHBOARD_DIR, path)
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return resp


@app.route("/")
def index():
    # Osobny endpoint (nie redirect!) - laczenie "/" i "/dashboard/<path:path>" w jeden endpoint
    # przez Werkzeug (np. defaults={}) powoduje przekierowanie 308 miedzy nimi. Kiedys to psulo
    # wzgledne sciezki zasobow w index.html; dzis zasoby sa odwolywane sciezkami bezwzglednymi
    # (/dashboard/...), wiec dzialaja niezaleznie od URL-a strony - ale dwa endpointy zostaja,
    # bo to nadal prostszy, jawny kod niz sztuczka z defaults={}.
    return _serve("index.html")


@app.route("/dashboard/<path:path>")
def static_files(path):
    # Trasa dopasowuje WYLACZNIE URL-e zaczynajace sie od /dashboard/ (nie /<path:path> na
    # wszystko) - wczesniej ten catch-all serwowal caly katalog projektu bez autoryzacji
    # (README.md, server.py, render.yaml, baza_danych/schema.sql byly publicznie pobieralne).
    # _serve() dodatkowo resolvuje sciezki wzgledem DASHBOARD_DIR, nie ROOT, wiec nawet
    # potencjalny path traversal nie wyjdzie poza katalog dashboard/.
    return _serve(path)


def main():
    # ensure_database_ready(), migrate_schema() i backup_on_startup() juz sie wykonaly (i
    # wypisaly swoje komunikaty) przy imporcie modulu (patrz wyzej) - tutaj tylko lokalny
    # wygodny dodatek (banner, otwarcie przegladarki), nie wolany w ogole pod gunicornem/Render.
    url = f"http://localhost:{PORT}/"
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
