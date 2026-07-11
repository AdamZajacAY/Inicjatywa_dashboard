#!/usr/bin/env python3
"""
Jednorazowa (albo rzadko powtarzana) migracja lokalnej bazy na wdrozony egzemplarz aplikacji
(np. swiezy deploy na Render z pustym dyskiem trwalym) - patrz DEPLOY_RENDER.md.

Uzywa WYLACZNIE juz istniejacego, przetestowanego REST API (/api/auth/login + POST /api/<tabela>)
- zero nowego kodu po stronie serwera, zero nowej powierzchni ataku na produkcyjnej instancji.
Loguje sie jako COO/Admin na zdalnym adresie, czyta wiersze bezposrednio z lokalnego pliku SQLite
i tworzy je przez POST na zdalnej instancji, w kolejnosci szanujacej klucze obce.

WAZNE: zdalne ID moga wyjsc inne niz lokalne (serwer nadaje je sam przez next_id(), np. lokalne
"JB-01" moze stac sie zdalnie "PRJ004") - skrypt pamieta mapowanie {tabela: {stare_id: nowe_id}}
i podstawia je automatycznie w kolumnach FK wierszy zaleznych. Traci sie tylko czytelnosc ID
(np. "JB-01" -> Jan B), nie dane ani relacje.

Tabela `users` (konta/haslo) jest CELOWO pomijana - nowe srodowisko powinno miec wlasne, swieze
konta (patrz create_admin.py), nie kopie lokalnych sesji testowych.

Uzycie:
  python3 baza_danych/migrate_to_remote.py --url https://twoja-appka.onrender.com \
      --email adam@adviseyou.pl --password '...' [--dry-run]

--dry-run pokazuje co zostaloby wyslane (liczby wierszy per tabela), bez faktycznego zapisu.
"""

import argparse
import getpass
import http.cookiejar
import json
import sqlite3
import sys
import urllib.error
import urllib.request
from os import path

ROOT = path.dirname(path.abspath(__file__))
DB_PATH = path.join(ROOT, "baza_projektow.db")

# (tabela, {kolumna_FK: tabela_docelowa}) w kolejnosci bezpiecznej pod klucze obce.
# ID_Zadania_poprzedzajacego (samo-referencja w harmonogram) obslugiwane osobno, druga turą.
MIGRATION_PLAN = [
    ("projekty", {}),
    ("zespol", {}),
    ("podwykonawcy", {}),
    ("przypisania", {"ID_Projektu": "projekty", "ID_Osoby": "zespol"}),
    ("harmonogram", {"ID_Projektu": "projekty", "ID_Osoby_odpowiedzialnej": "zespol"}),
    ("kamienie_milowe", {"ID_Projektu": "projekty", "ID_Osoby_odpowiedzialnej": "zespol"}),
    ("zadania_tickety", {"ID_Projektu": "projekty", "ID_Etapu": "harmonogram",
                          "ID_Osoby_przypisanej": "zespol", "ID_Podwykonawcy": "podwykonawcy",
                          "ID_Osoby_zglaszajacej": "zespol", "ID_Osoby_wspomagajacej": "zespol"}),
    ("ryzyka_i_problemy", {"ID_Projektu": "projekty", "ID_Osoby_wlasciciela": "zespol"}),
    ("raporty_statusowe", {"ID_Projektu": "projekty"}),
    ("przypisania_podwykonawcow", {"ID_Projektu": "projekty", "ID_Podwykonawcy": "podwykonawcy"}),
]
PK_COLUMNS = {
    "projekty": "ID_Projektu", "zespol": "ID_Osoby", "podwykonawcy": "ID_Podwykonawcy",
    "przypisania": "ID_Przypisania", "harmonogram": "ID_Zadania", "kamienie_milowe": "ID_Kamienia",
    "zadania_tickety": "ID_Tickietu", "ryzyka_i_problemy": "ID", "raporty_statusowe": "id",
    "przypisania_podwykonawcow": "ID_Przypisania_Podw",
}


class NetworkError(Exception):
    """Blad polaczenia (DNS, timeout, connection refused, zerwane polaczenie w trakcie) -
    odrozniony od normalnej odpowiedzi HTTP z bledem (ktora request() nadal zwraca jako
    (status, body), bez zmian). Blad sieciowy w trakcie petli po wierszach oznacza, ze kazdy
    kolejny request tez by sie nie udal - main() przerywa cala migracje od razu z jasnym
    komunikatem, zamiast zasypywac ekran identycznym bledem dla kazdego pozostalego wiersza."""


class RemoteClient:
    def __init__(self, base_url):
        self.base_url = base_url.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def request(self, method, path_, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base_url + path_, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        req.add_header("X-Requested-With", "fetch")
        try:
            resp = self.opener.open(req, timeout=20)
            payload = resp.read()
            return resp.status, (json.loads(payload) if payload else None)
        except urllib.error.HTTPError as e:
            payload = e.read()
            try:
                return e.code, json.loads(payload)
            except json.JSONDecodeError:
                return e.code, {"error": payload.decode(errors="replace")}
        except OSError as e:
            # URLError/TimeoutError/ConnectionError sa wszystkie podklasami OSError -
            # jeden catch wystarcza (HTTPError, tez podklasa OSError, jest juz zlapany wyzej).
            raise NetworkError(f"{method} {path_}: {e}") from e

    def login(self, email, password):
        status, body = self.request("POST", "/api/auth/login", {"email": email, "password": password})
        if status != 200:
            raise SystemExit(f"Logowanie nie powiodlo sie ({status}): {body}")
        if body.get("role") not in ("COO", "Admin"):
            raise SystemExit(f"Konto {email} nie ma roli COO/Admin (ma: {body.get('role')}) - migracja wymaga pelnego dostepu.")


def read_local_rows(table):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute(f"SELECT * FROM {table}").fetchall()]
    conn.close()
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", required=True, help="adres wdrozonej instancji, np. https://twoja-appka.onrender.com")
    parser.add_argument("--email", required=True, help="e-mail konta COO/Admin na zdalnej instancji")
    parser.add_argument("--password", help="haslo (jesli pominiete, zapyta interaktywnie)")
    parser.add_argument("--dry-run", action="store_true", help="pokaz co zostaloby wyslane, bez wysylania")
    parser.add_argument("--force", action="store_true",
                         help="pomin sprawdzenie, czy zdalna baza jest juz pusta - uzyj tylko jesli "
                              "swiadomie dopisujesz dane do juz-zmigrowanej instancji (inaczej zduplikujesz wiersze)")
    args = parser.parse_args()

    if not path.exists(DB_PATH):
        sys.exit(f"Brak lokalnej bazy: {DB_PATH}")
    password = args.password or getpass.getpass(f"Haslo dla {args.email}: ")

    client = None
    if not args.dry_run:
        client = RemoteClient(args.url)
        try:
            client.login(args.email, password)
            print(f"Zalogowano na {args.url} jako {args.email}.")
            # POST zawsze tworzy NOWY wiersz - bez tego sprawdzenia ponowne uruchomienie (np.
            # po tym jak ktos nie byl pewien, czy poprzednie sie udalo, albo po przerwaniu w
            # polowie) po cichu zdublowaloby kazdy juz przeniesiony wiersz.
            if not args.force:
                status, existing = client.request("GET", "/api/projekty")
                if status == 200 and existing:
                    sys.exit(
                        f"Zdalna instancja ma juz {len(existing)} projekt(ow) - wyglada na to, ze "
                        f"migracja byla juz uruchamiana (czesciowo albo w calosci). Ponowne "
                        f"uruchomienie zdublowaloby kazdy juz przeniesiony wiersz, bo POST zawsze "
                        f"tworzy nowy. Sprawdz recznie stan zdalnej instancji; jesli na pewno chcesz "
                        f"kontynuowac, uruchom ponownie z --force."
                    )
        except NetworkError as e:
            sys.exit(f"Blad polaczenia z {args.url}: {e}")

    id_maps = {}  # {tabela: {stare_id: nowe_id}}
    totals = {}

    try:
        for table, fk_map in MIGRATION_PLAN:
            pk = PK_COLUMNS[table]
            rows = read_local_rows(table)
            id_maps[table] = {}
            totals[table] = len(rows)
            if args.dry_run:
                print(f"[dry-run] {table}: {len(rows)} wierszy do wyslania")
                continue

            for row in rows:
                old_pk = row.get(pk)
                payload = {k: v for k, v in row.items() if k != pk}
                skip_row = False
                for fk_col, target_table in fk_map.items():
                    if payload.get(fk_col) is not None:
                        mapped = id_maps.get(target_table, {}).get(payload[fk_col])
                        if mapped is None:
                            print(f"  UWAGA: {table}/{old_pk}: {fk_col}={payload[fk_col]!r} nie znaleziono "
                                  f"w zmigrowanych {target_table} - pomijam ten wiersz.")
                            skip_row = True
                            break
                        payload[fk_col] = mapped
                if skip_row:
                    continue
                # harmonogram: samo-referencja ID_Zadania_poprzedzajacego rozwiazywana w drugiej turze
                payload.pop("ID_Zadania_poprzedzajacego", None)

                status, body = client.request("POST", f"/api/{table}", payload)
                if status != 201:
                    print(f"  BLAD przy {table}/{old_pk} ({status}): {body}")
                    continue
                id_maps[table][old_pk] = body[pk]

            print(f"{table}: {len(id_maps[table])}/{len(rows)} wierszy przeniesionych.")

        if args.dry_run:
            print("\n[dry-run] Nic nie zostalo wyslane. Uruchom bez --dry-run, zeby faktycznie zmigrowac.")
            return

        # druga tura: ID_Zadania_poprzedzajacego w harmonogram (samo-referencja, wymaga zeby
        # WSZYSTKIE etapy juz istnialy zdalnie, zanim ktorykolwiek z nich moze wskazac na inny)
        local_harmonogram = read_local_rows("harmonogram")
        updated = 0
        for row in local_harmonogram:
            prev = row.get("ID_Zadania_poprzedzajacego")
            if not prev:
                continue
            new_id = id_maps["harmonogram"].get(row["ID_Zadania"])
            new_prev = id_maps["harmonogram"].get(prev)
            if new_id and new_prev:
                status, body = client.request("PUT", f"/api/harmonogram/{new_id}", {"ID_Zadania_poprzedzajacego": new_prev})
                if status == 200:
                    updated += 1
        if updated:
            print(f"harmonogram: {updated} powiazan \"zadanie poprzedzajace\" ustawionych w drugiej turze.")
    except NetworkError as e:
        sys.exit(
            f"\nBlad polaczenia z {args.url}: {e}\n"
            f"Migracja przerwana w trakcie - czesc danych mogla juz zostac zapisana zdalnie. "
            f"Sprawdz recznie stan zdalnej instancji przed ponownym uruchomieniem; skrypt "
            f"odmowi ponownego uruchomienia na niepustej zdalnej bazie bez --force (patrz wyzej)."
        )

    print("\nGotowe. Zaloguj sie do zdalnej instancji i porownaj liczby projektow/zespolu/przypisan.")


if __name__ == "__main__":
    main()
