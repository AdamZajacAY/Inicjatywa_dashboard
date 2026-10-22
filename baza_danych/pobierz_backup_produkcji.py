#!/usr/bin/env python3
"""
Pobiera swieza kopie PRODUKCYJNEJ bazy (Render) na ten komputer. Samodzielny (tylko biblioteka
standardowa), zeby dal sie uruchamiac co noc przez launchd - patrz instaluj_kopie_nocna.sh.

Konto: COO/Admin albo konto techniczne z rola "Kopia" (moze TYLKO pobrac kopie).
Haslo: zmienna IP_BACKUP_PASSWORD, albo pek kluczy macOS (usluga "ip-dashboard-kopia",
konto = e-mail), albo pytanie w terminalu.

  python3 baza_danych/pobierz_backup_produkcji.py --email kopia@...            # do ~/Kopie_Inicjatywa_produkcja/
  python3 baza_danych/pobierz_backup_produkcji.py --email ... --out baza_danych/backups_produkcja

Lokalnie nic nie jest usuwane. Kazda kopia przechodzi PRAGMA integrity_check.
"""
import argparse
import datetime
import getpass
import http.cookiejar
import json
import os
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.request

DEFAULT_URL = "https://inicjatywa-projektowa-dashboard.onrender.com"
DEFAULT_OUT = os.path.expanduser("~/Kopie_Inicjatywa_produkcja")
KEYCHAIN_SERVICE = "ip-dashboard-kopia"


def password_for(email):
    if os.environ.get("IP_BACKUP_PASSWORD"):
        return os.environ["IP_BACKUP_PASSWORD"]
    try:
        out = subprocess.run(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", email, "-w"],
                             capture_output=True, text=True, timeout=20)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    if sys.stdin.isatty():
        return getpass.getpass(f"Hasło dla {email}: ")
    sys.exit(f"Brak hasła dla {email} (ani IP_BACKUP_PASSWORD, ani pęk kluczy '{KEYCHAIN_SERVICE}').")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=os.environ.get("IP_DASHBOARD_URL", DEFAULT_URL))
    ap.add_argument("--email", default=os.environ.get("IP_BACKUP_EMAIL"), required=not os.environ.get("IP_BACKUP_EMAIL"))
    ap.add_argument("--out", default=os.environ.get("IP_BACKUP_DIR", DEFAULT_OUT))
    args = ap.parse_args()
    base = args.url.rstrip("/")
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def req(method, path, body=None):
        r = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, method=method)
        r.add_header("Content-Type", "application/json")
        r.add_header("X-Requested-With", "fetch")
        return opener.open(r, timeout=180)

    try:
        req("POST", "/api/auth/login", {"email": args.email, "password": password_for(args.email)}).read()
        data = req("GET", "/api/backup/pobierz").read()
    except urllib.error.HTTPError as e:
        sys.exit(f"{datetime.datetime.now():%Y-%m-%d %H:%M} BŁĄD: serwer odpowiedział {e.code} ({e.read()[:200]!r})")
    except OSError as e:
        sys.exit(f"{datetime.datetime.now():%Y-%m-%d %H:%M} BŁĄD połączenia: {e}")
    os.makedirs(args.out, exist_ok=True)
    dest = os.path.join(args.out, f"produkcja_{datetime.datetime.now():%Y%m%d_%H%M%S}.db")
    with open(dest, "wb") as f:
        f.write(data)
    conn = sqlite3.connect(dest)
    try:
        ok = conn.execute("PRAGMA integrity_check").fetchone()[0]
        n = conn.execute("SELECT COUNT(*) FROM projekty").fetchone()[0]
    finally:
        conn.close()
    if ok != "ok":
        sys.exit(f"Pobrany plik nie przeszedł integrity_check: {ok} ({dest})")
    print(f"{datetime.datetime.now():%Y-%m-%d %H:%M} OK {dest} ({len(data) // 1024} KB, {n} projektów)")


if __name__ == "__main__":
    main()
