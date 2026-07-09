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

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(ROOT, "baza_danych", "baza_projektow.db")
PORT = 8000

app = Flask(__name__, static_folder=None)

# python3 na macOS (system Python, linkowany z LibreSSL) nie ma hashlib.scrypt, czyli
# domyslna metoda generate_password_hash() (scrypt) rzuca AttributeError - zweryfikowane
# bezposrednio. pbkdf2:sha256 dziala wszedzie, wiec jest jedyna dopuszczalna metoda w tym pliku.
PASSWORD_HASH_METHOD = "pbkdf2:sha256"
_DUMMY_PASSWORD_HASH = generate_password_hash("nie-jest-to-prawdziwe-haslo", method=PASSWORD_HASH_METHOD)


def _load_or_create_secret_key():
    env_key = os.environ.get("SECRET_KEY")
    if env_key:
        return env_key
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
    # Brak HTTPS na LAN dzis - musi zostac False, inaczej przegladarka nigdy nie wysle
    # ciasteczka. Udokumentowane ograniczenie w README (patrz sekcja logowania).
    SESSION_COOKIE_SECURE=False,
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
        return row.get("ID_Osoby_przypisanej") == user["ID_Osoby"]  # edycja tylko wlasnego ticketu
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
    if user["Rola"] == "Specjalista":
        for field in FINANCIAL_FIELDS.get(table, ()):
            if field in row:
                row[field] = None
    return row


def validate_user_payload(data, existing):
    if "Rola" in data and data["Rola"] not in VALID_ROLES:
        return "Nieprawidłowa rola."
    merged_role = data["Rola"] if "Rola" in data else (existing.get("Rola") if existing else None)
    merged_person = data["ID_Osoby"] if "ID_Osoby" in data else (existing.get("ID_Osoby") if existing else None)
    if merged_role in ("Specjalista", "Architekt_PM") and not merged_person:
        return "Ta rola wymaga powiązania z osobą z zespołu."
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
    _login_attempts[key] = [t for t in _login_attempts[key] if now - t < LOGIN_LOCKOUT_SECONDS]
    return len(_login_attempts[key]) >= LOGIN_MAX_ATTEMPTS


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


PUBLIC_API_PATHS = {"/api/auth/login", "/api/auth/google/login", "/api/auth/google/callback", "/api/auth/config"}
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
    data = request.get_json(force=True, silent=True) or {}
    current_password = data.get("current_password") or ""
    new_password = data.get("new_password") or ""
    if len(new_password) < 8:
        return jsonify({"error": "Nowe hasło musi mieć co najmniej 8 znaków."}), 400
    stored_hash = g.user["Haslo_Hash"] or _DUMMY_PASSWORD_HASH
    if not g.user["Haslo_Hash"] or not check_password_hash(stored_hash, current_password):
        return jsonify({"error": "Obecne hasło jest nieprawidłowe."}), 401
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

    if "email_verified" in userinfo and not _truthy(userinfo["email_verified"]):
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
    for table, key in BOOTSTRAP_KEYS.items():
        rows = conn.execute(f"SELECT * FROM {table}").fetchall()
        result[key] = [redact_row(g.user, table, dict(r)) for r in rows]
    result["me"] = public_user(g.user)
    result["me"]["assignedProjectIds"] = sorted(assigned_project_ids(conn, g.user["ID_Osoby"]))
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
        return jsonify([redact_row(g.user, table, dict(r)) for r in rows])

    data = parse_payload(conn, table)
    if not can_write(conn, g.user, "create", table, data):
        abort(403)
    if table == "users":
        error = validate_user_payload(data, None)
        if error:
            return jsonify({"error": error}), 400
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
    return jsonify(redact_row(g.user, table, fetch_row(conn, table, pk, pk_val))), 201


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
        if table == "projekty" and g.user["Rola"] not in FULL_ACCESS_ROLES:
            abort(403)  # kaskadowe usuniecie - nawet PM nie usuwa wlasnego projektu
        if not can_write(conn, g.user, "delete", table, existing):
            abort(403)
        try:
            cur = conn.execute(f"DELETE FROM {table} WHERE {pk} = ?", (item_id,))
            conn.commit()
        except sqlite3.IntegrityError as e:
            return jsonify({"error": f"Nie można usunąć — rekord jest nadal używany gdzie indziej ({e})"}), 409
        if cur.rowcount == 0:
            abort(404)
        return "", 204

    if not can_write(conn, g.user, "update", table, existing):
        abort(403)
    data = parse_payload(conn, table, exclude={pk})
    if not data:
        return jsonify({"error": "Brak pól do aktualizacji"}), 400
    # jesli payload zmienia pole zakresu (ID_Projektu), sprawdz uprawnienia TEZ na obrazie
    # po zmianie - inaczej dawaloby sie "wypchnac"/"wciagnac" wiersz do projektu bez dostepu,
    # sprawdzajac tylko stan sprzed edycji
    if "ID_Projektu" in data and data["ID_Projektu"] != existing.get("ID_Projektu"):
        if not can_write(conn, g.user, "update", table, {**existing, **data}):
            abort(403)
    if table == "users":
        error = validate_user_payload(data, existing)
        if error:
            return jsonify({"error": error}), 400
    set_clause = ", ".join(f"{c} = ?" for c in data.keys())
    try:
        cur = conn.execute(f"UPDATE {table} SET {set_clause} WHERE {pk} = ?", [*data.values(), item_id])
        conn.commit()
    except sqlite3.IntegrityError as e:
        return jsonify({"error": str(e)}), 409
    if cur.rowcount == 0:
        abort(404)
    return jsonify(redact_row(g.user, table, fetch_row(conn, table, pk, item_id)))


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
        return jsonify({"error": str(e)}), 500
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
    conn.execute(
        "UPDATE users SET Haslo_Hash = ? WHERE ID_Uzytkownika = ?",
        (generate_password_hash(new_password, method=PASSWORD_HASH_METHOD), item_id),
    )
    conn.commit()
    return "", 204


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

    try:
        backup_path = create_backup()
        enforce_retention()
        backup_note = f"Backup przy starcie: {os.path.basename(backup_path)}"
    except Exception as e:
        # nieudany backup nie moze zablokowac startu serwera - tylko ostrzezenie
        backup_note = f"Backup przy starcie nie powiódł się (serwer i tak startuje): {e}"

    url = f"http://localhost:{PORT}/dashboard/index.html"
    print("=" * 60)
    print("Serwer działa. Dashboard:")
    print(f"  {url}")
    print(f"Baza danych: {DB_PATH}")
    print(backup_note)
    print("Zatrzymanie: Ctrl+C")
    print("=" * 60)
    webbrowser.open(url)
    app.run(port=PORT, debug=False)


if __name__ == "__main__":
    main()
