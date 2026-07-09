#!/usr/bin/env python3
"""
Backup bazy danych baza_projektow.db.

Uzywa sqlite3.Connection.backup() (API online-backup SQLite) zamiast zwyklego
kopiowania pliku - bezpieczne nawet gdy server.py jest w tym momencie
uruchomiony i ktos akurat zapisuje dane (zwykly "cp" moze zlapac niespojny
stan w trakcie zapisu albo pominac -wal/-shm).

Kopie ladowane sa do baza_danych/backups/ z nazwa niosaca timestamp, wiec
sortuja sie chronologicznie jako zwykle stringi. Retencja: domyslnie
zachowywane jest ostatnie 30 kopii (--keep), starsze sa usuwane.

Uruchomienie:
  python3 baza_danych/backup_db.py            # backup + retencja, z komunikatem
  python3 baza_danych/backup_db.py --quiet     # jak wyzej, bez wypisywania (cron/launchd)
  python3 baza_danych/backup_db.py --keep 10   # inna liczba przechowywanych kopii

Ten sam kod jest tez wolany bezposrednio z server.py (funkcje create_backup/
enforce_retention) - przy starcie serwera i przez endpoint POST /api/backup.
"""

import argparse
import datetime
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DATABASE_PATH", os.path.join(ROOT, "baza_projektow.db"))
BACKUPS_DIR = os.environ.get("BACKUPS_DIR", os.path.join(ROOT, "backups"))
DEFAULT_KEEP = 30


def create_backup(db_path=DB_PATH, backups_dir=BACKUPS_DIR):
    """Tworzy jedna kopie zapasowa, zwraca sciezke do utworzonego pliku."""
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"Brak bazy danych: {db_path}")
    os.makedirs(backups_dir, exist_ok=True)
    # mikrosekundy w nazwie, zeby dwa backupy w tej samej sekundzie (np. szybki
    # podwojny klik "Backup teraz") nie nadpisaly sie nawzajem po cichu
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    dest_path = os.path.join(backups_dir, f"baza_projektow_{stamp}.db")

    src = sqlite3.connect(db_path)
    dest = sqlite3.connect(dest_path)
    try:
        src.backup(dest)
    finally:
        dest.close()
        src.close()
    return dest_path


def list_backups(backups_dir=BACKUPS_DIR):
    """Zwraca liste (nazwa_pliku, rozmiar_bajty, sciezka) posortowana od najnowszej."""
    if not os.path.isdir(backups_dir):
        return []
    names = sorted(
        (f for f in os.listdir(backups_dir) if f.startswith("baza_projektow_") and f.endswith(".db")),
        reverse=True,
    )
    return [(n, os.path.getsize(os.path.join(backups_dir, n)), os.path.join(backups_dir, n)) for n in names]


def enforce_retention(keep=DEFAULT_KEEP, backups_dir=BACKUPS_DIR):
    """Usuwa najstarsze kopie ponad limit `keep`, zwraca liste usunietych plikow."""
    backups = list_backups(backups_dir)
    removed = []
    for name, _size, path in backups[keep:]:
        os.remove(path)
        removed.append(name)
    return removed


def main():
    parser = argparse.ArgumentParser(description="Backup bazy danych baza_projektow.db")
    parser.add_argument("--keep", type=int, default=DEFAULT_KEEP, help=f"ile kopii zachowac (domyslnie {DEFAULT_KEEP})")
    parser.add_argument("--quiet", action="store_true", help="bez wypisywania na stdout (pod cron/launchd)")
    args = parser.parse_args()

    try:
        dest_path = create_backup()
        removed = enforce_retention(keep=args.keep)
    except Exception as e:
        print(f"Backup nie powiodl sie: {e}", file=sys.stderr)
        sys.exit(1)

    if not args.quiet:
        print(f"Backup utworzony: {dest_path}")
        if removed:
            print(f"Usunieto {len(removed)} starszych kopii (retencja --keep {args.keep}): {', '.join(removed)}")


if __name__ == "__main__":
    main()
