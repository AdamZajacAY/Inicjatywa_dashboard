#!/usr/bin/env python3
"""
Backup bazy danych baza_projektow.db.

Uzywa sqlite3.Connection.backup() (API online-backup SQLite) zamiast zwyklego
kopiowania pliku - bezpieczne nawet gdy server.py jest w tym momencie
uruchomiony i ktos akurat zapisuje dane (zwykly "cp" moze zlapac niespojny
stan w trakcie zapisu albo pominac -wal/-shm).

Kopie ladowane sa do baza_danych/backups/ z nazwa niosaca timestamp, wiec
sortuja sie chronologicznie jako zwykle stringi. Retencja: wiekowa, nie
liczbowa - zachowywane sa kopie mlodsze niz --keep-days (domyslnie 30), plus
zawsze co najmniej --keep-min najnowszych (domyslnie 10) niezaleznie od
wieku, zeby appka nieuzywana przez dluzszy czas nie zostala bez zadnego
punktu przywracania. Powod wyboru wieku zamiast liczby: backup startowy
odpala sie przy KAZDYM restarcie procesu (kazdy deploy na Renderze to nowy
backup), wiec przy kilku deployach dziennie retencja liczona samym "ostatnie
N kopii" potrafila w kilka dni wyprzec kopie starsze niz tydzien, mimo
nominalnie sporego zapasu.

Uruchomienie:
  python3 baza_danych/backup_db.py                  # backup + retencja, z komunikatem
  python3 baza_danych/backup_db.py --quiet           # jak wyzej, bez wypisywania (cron/launchd)
  python3 baza_danych/backup_db.py --keep-days 14    # inny wiek graniczny

Ten sam kod jest tez wolany bezposrednio z server.py (funkcje create_backup/
enforce_retention) - przy starcie serwera i przez endpoint POST /api/backup.
"""

import argparse
import datetime
import os
import re
import sqlite3
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DATABASE_PATH", os.path.join(ROOT, "baza_projektow.db"))
BACKUPS_DIR = os.environ.get("BACKUPS_DIR", os.path.join(ROOT, "backups"))
DEFAULT_KEEP_DAYS = 30
DEFAULT_KEEP_MIN = 10
_NAME_RE = re.compile(r"^baza_projektow_(\d{8})_(\d{6})_\d{6}\.db$")


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


def _backup_timestamp(name):
    """Data z nazwy pliku (baza_projektow_YYYYMMDD_HHMMSS_ffffff.db), albo None jesli
    nazwa nie pasuje do wzorca (np. plik wrzucony recznie) - taki plik traktujemy jako
    "zawsze za mlody do usuniecia", zamiast zgadywac jego wiek."""
    m = _NAME_RE.match(name)
    if not m:
        return None
    try:
        return datetime.datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S")
    except ValueError:
        return None


def enforce_retention(keep_days=DEFAULT_KEEP_DAYS, keep_min=DEFAULT_KEEP_MIN, backups_dir=BACKUPS_DIR):
    """Usuwa kopie starsze niz `keep_days` dni, ale nigdy nie schodzi ponizej `keep_min`
    najnowszych (patrz uzasadnienie w docstringu modulu). Zwraca liste usunietych plikow."""
    backups = list_backups(backups_dir)  # najnowsze pierwsze
    cutoff = datetime.datetime.now() - datetime.timedelta(days=keep_days)
    removed = []
    for name, _size, path in backups[keep_min:]:
        ts = _backup_timestamp(name)
        if ts is not None and ts < cutoff:
            os.remove(path)
            removed.append(name)
    return removed


def main():
    parser = argparse.ArgumentParser(description="Backup bazy danych baza_projektow.db")
    parser.add_argument("--keep-days", type=int, default=DEFAULT_KEEP_DAYS,
                         help=f"kopie starsze niz tyle dni sa usuwane (domyslnie {DEFAULT_KEEP_DAYS})")
    parser.add_argument("--keep-min", type=int, default=DEFAULT_KEEP_MIN,
                         help=f"zawsze zachowaj co najmniej tyle najnowszych, niezaleznie od wieku (domyslnie {DEFAULT_KEEP_MIN})")
    parser.add_argument("--quiet", action="store_true", help="bez wypisywania na stdout (pod cron/launchd)")
    args = parser.parse_args()

    try:
        dest_path = create_backup()
        removed = enforce_retention(keep_days=args.keep_days, keep_min=args.keep_min)
    except Exception as e:
        print(f"Backup nie powiodl sie: {e}", file=sys.stderr)
        sys.exit(1)

    if not args.quiet:
        print(f"Backup utworzony: {dest_path}")
        if removed:
            print(f"Usunieto {len(removed)} kopii starszych niz {args.keep_days} dni: {', '.join(removed)}")


if __name__ == "__main__":
    main()
