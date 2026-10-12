#!/usr/bin/env python3
"""
Pobiera swieza kopie PRODUKCYJNEJ bazy (Render) na ten komputer.

Loguje sie kontem COO/Admin przez /api/auth/login i sciaga GET /api/backup/pobierz do
baza_danych/backups_produkcja/ (gitignorowane). Lokalnie nic nie jest nigdy usuwane.

  python3 baza_danych/pobierz_backup_produkcji.py --url https://<appka>.onrender.com --email admin@...

Pod cron/launchd: haslo przez zmienna srodowiskowa IP_BACKUP_PASSWORD zamiast pytania.
"""
import argparse
import datetime
import getpass
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from baza_danych.migrate_to_remote import RemoteClient  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backups_produkcja")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=os.environ.get("IP_DASHBOARD_URL"), help="adres instancji (lub IP_DASHBOARD_URL)")
    ap.add_argument("--email", default=os.environ.get("IP_BACKUP_EMAIL"), help="konto COO/Admin (lub IP_BACKUP_EMAIL)")
    args = ap.parse_args()
    if not args.url or not args.email:
        sys.exit("Podaj --url i --email (albo IP_DASHBOARD_URL / IP_BACKUP_EMAIL).")
    password = os.environ.get("IP_BACKUP_PASSWORD") or getpass.getpass(f"Haslo dla {args.email}: ")
    client = RemoteClient(args.url)
    client.login(args.email, password)
    req = __import__("urllib.request").request.Request(client.base_url + "/api/backup/pobierz")
    req.add_header("X-Requested-With", "fetch")
    with client.opener.open(req, timeout=120) as resp:
        data = resp.read()
    os.makedirs(OUT_DIR, exist_ok=True)
    dest = os.path.join(OUT_DIR, f"produkcja_{datetime.datetime.now():%Y%m%d_%H%M%S}.db")
    with open(dest, "wb") as f:
        f.write(data)
    conn = sqlite3.connect(dest)
    try:
        ok = conn.execute("PRAGMA integrity_check").fetchone()[0]
        n = conn.execute("SELECT COUNT(*) FROM projekty").fetchone()[0]
    finally:
        conn.close()
    if ok != "ok":
        sys.exit(f"Pobrany plik nie przeszedl integrity_check: {ok} ({dest})")
    print(f"Zapisano {dest} ({len(data) // 1024} KB, {n} projektow, integrity_check: ok)")


if __name__ == "__main__":
    main()
