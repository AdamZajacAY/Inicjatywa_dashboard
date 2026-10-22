#!/usr/bin/env python3
"""
Audyt jakosci danych - TYLKO ODCZYT (baza otwierana w trybie read-only, nic nie jest zmieniane
ani usuwane). Wypisuje raport: rekordy testowe, mozliwe duplikaty osob, osierocone odwolania,
zadania bez osoby/terminu, projekty po terminie itd. Decyzje o poprawkach podejmuje czlowiek.

  python3 baza_danych/audyt_danych.py                 # najnowsza kopia z backups_produkcja/, a jesli brak - lokalna baza
  python3 baza_danych/audyt_danych.py sciezka/do.db   # konkretny plik
"""
import datetime
import glob
import os
import re
import sqlite3
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
TEST_PATTERNS = ("ZZZ%", "TEST%", "%test ticket%", "%test etap%", "%test new project%")
NAME_COLUMNS = ("Nazwa", "Tytul", "Nazwa_zadania", "Imie_i_nazwisko", "Opis", "Tresc", "Nazwa_kamienia")
# Zdrobnienia -> imie pelne (duplikaty typu Gosia / Malgorzata, feedback 10.09.2026).
DIMINUTIVES = {
    "gosia": "malgorzata", "goska": "malgorzata", "kasia": "katarzyna", "ania": "anna", "asia": "joanna",
    "basia": "barbara", "ola": "aleksandra", "magda": "magdalena", "ewka": "ewa", "zosia": "zofia",
    "tomek": "tomasz", "wojtek": "wojciech", "bartek": "bartlomiej", "kuba": "jakub", "piotrek": "piotr",
    "krzys": "krzysztof", "staszek": "stanislaw", "mikolaj": "mikolaj", "grzesiek": "grzegorz", "jacek": "jacek",
    "mateusz": "mateusz", "adas": "adam", "danek": "daniel", "michal": "michal", "pawel": "pawel",
}
ACTIVE_TICKET_EXCLUDED = ("Zrobione", "Zarchiwizowane")


def pick_db():
    if len(sys.argv) > 1:
        return sys.argv[1]
    # najnowsza kopia produkcji: reczne pobrania (backups_produkcja/) albo kopie nocne (~/Kopie_Inicjatywa_produkcja/)
    prod = glob.glob(os.path.join(HERE, "backups_produkcja", "*.db")) + glob.glob(os.path.expanduser("~/Kopie_Inicjatywa_produkcja/*.db"))
    prod.sort(key=os.path.getmtime)
    return prod[-1] if prod else os.path.join(HERE, "baza_projektow.db")


def norm(text):
    text = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z ]", "", text).strip()


def section(title, rows, fmt):
    print(f"\n## {title} — {len(rows)}")
    for r in rows[:25]:
        print("  - " + fmt(r))
    if len(rows) > 25:
        print(f"  ... i {len(rows) - 25} wiecej")


def main():
    path = pick_db()
    if not os.path.exists(path):
        sys.exit(f"Brak pliku bazy: {path}")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    q = lambda sql, *a: conn.execute(sql, a).fetchall()  # noqa: E731
    tables = [r["name"] for r in q("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    cols = {t: [r["name"] for r in q(f"PRAGMA table_info({t})")] for t in tables}
    today = datetime.date.today().isoformat()
    print(f"# Audyt danych: {os.path.basename(path)} (tylko odczyt, {datetime.datetime.now():%Y-%m-%d %H:%M})")

    # 1. rekordy testowe
    test_rows = []
    for t in tables:
        pk = cols[t][0]
        for c in (c for c in NAME_COLUMNS if c in cols[t]):
            where = " OR ".join(f"{c} LIKE ?" for _ in TEST_PATTERNS)
            for r in q(f"SELECT {pk} AS id, {c} AS v FROM {t} WHERE {where}", *TEST_PATTERNS):
                test_rows.append((t, r["id"], r["v"]))
    seen = set()
    test_rows = [x for x in test_rows if not ((x[0], x[1]) in seen or seen.add((x[0], x[1])))]
    section("Rekordy wygladajace na testowe (ZZZ / test)", test_rows, lambda r: f"{r[0]}.{r[1]}: {r[2][:70]}")

    # 2. osierocone odwolania (klucze obce)
    orphans = q("PRAGMA foreign_key_check")
    section("Osierocone odwolania (klucz obcy wskazuje na nieistniejacy rekord)", orphans,
            lambda r: f"{r[0]} rowid={r[1]} -> {r[2]}")

    # 3. mozliwe duplikaty osob
    people = q("SELECT ID_Osoby, Imie_i_nazwisko, Email FROM zespol")
    dups = []
    for i, a in enumerate(people):
        for b in people[i + 1:]:
            na, nb = norm(a["Imie_i_nazwisko"]).split(), norm(b["Imie_i_nazwisko"]).split()
            if not na or not nb:
                continue
            first_a, first_b = DIMINUTIVES.get(na[0], na[0]), DIMINUTIVES.get(nb[0], nb[0])
            same_email = a["Email"] and a["Email"].strip().lower() == (b["Email"] or "").strip().lower()
            initial_ok = len(na) < 2 or len(nb) < 2 or na[1][0] == nb[1][0]
            if same_email or (first_a == first_b and initial_ok):
                dups.append((a, b, "ten sam e-mail" if same_email else "to samo imie (po zdrobnieniu)"))
    section("Mozliwe duplikaty osob (do scalenia przyciskiem 'Scal z duplikatem')", dups,
            lambda r: f"{r[0]['Imie_i_nazwisko']} ({r[0]['ID_Osoby']}) ~ {r[1]['Imie_i_nazwisko']} ({r[1]['ID_Osoby']}) — {r[2]}")

    # 4. zadania aktywne bez osoby / bez terminu
    excl = ",".join("?" * len(ACTIVE_TICKET_EXCLUDED))
    no_person = q(f"SELECT ID_Tickietu, ID_Projektu, Tytul FROM zadania_tickety WHERE ID_Osoby_przypisanej IS NULL "
                  f"AND ID_Podwykonawcy IS NULL AND COALESCE(Status,'') NOT IN ({excl})", *ACTIVE_TICKET_EXCLUDED)
    section("Aktywne zadania bez przypisanej osoby i podwykonawcy (np. po usunieciu osoby)", no_person,
            lambda r: f"{r['ID_Tickietu']} [{r['ID_Projektu']}] {r['Tytul'][:60] if r['Tytul'] else ''}")
    no_termin = q(f"SELECT ID_Tickietu, ID_Projektu, Tytul FROM zadania_tickety WHERE (Termin IS NULL OR Termin='') "
                  f"AND COALESCE(Status,'') NOT IN ({excl})", *ACTIVE_TICKET_EXCLUDED)
    section("Aktywne zadania bez terminu (nie trafia do kalendarza ani na Gantta)", no_termin,
            lambda r: f"{r['ID_Tickietu']} [{r['ID_Projektu']}] {r['Tytul'][:60] if r['Tytul'] else ''}")

    # 5. statusy spoza slownika (np. po zmianie modelu Kanban)
    allowed = ("Backlog", "Zaplanowane", "W trakcie", "Do przegladu", "Zrobione", "Zarchiwizowane")
    bad_status = q(f"SELECT ID_Tickietu, Status FROM zadania_tickety WHERE COALESCE(Status,'') NOT IN ({','.join('?' * len(allowed))})", *allowed)
    section("Zadania ze statusem spoza slownika", bad_status, lambda r: f"{r['ID_Tickietu']}: {r['Status']!r}")

    # 6. projekty i etapy po terminie / bez dat
    late = q("SELECT ID_Projektu, Nazwa, Owner, Data_zakonczenia_planowana FROM projekty WHERE Status='W realizacji' "
             "AND Data_zakonczenia_planowana IS NOT NULL AND Data_zakonczenia_planowana<>'' AND Data_zakonczenia_planowana < ?", today)
    section("Projekty 'W realizacji' z planowanym koncem w przeszlosci", late,
            lambda r: f"{r['ID_Projektu']} {r['Nazwa']} ({r['Owner'] or 'brak ownera'}) — plan {r['Data_zakonczenia_planowana']}")
    stage_nodates = q("SELECT ID_Zadania, ID_Projektu, Nazwa_zadania FROM harmonogram WHERE Status='W trakcie' "
                      "AND (Data_start_plan IS NULL OR Data_start_plan='') AND COALESCE(Archiwalny,'')<>'Tak'")
    section("Etapy 'W trakcie' bez daty startu (nie widac ich na Gancie)", stage_nodates,
            lambda r: f"{r['ID_Zadania']} [{r['ID_Projektu']}] {r['Nazwa_zadania']}")
    # Od 22.10.2026 pelne prawa w projekcie ma tylko prowadzacy: rola "Kierownik projektu"/"Wlasciciel"
    # w przypisaniach albo Owner = imie i nazwisko z Zespolu. Projekt, w ktorym zadne z tych nie
    # zachodzi, nie ma prowadzacego z prawem edycji (poza COO/Admin).
    no_lead = q("""SELECT p.ID_Projektu, p.Nazwa, p.Owner FROM projekty p
                   WHERE COALESCE(p.Owner,'') <> ''
                     AND NOT EXISTS (SELECT 1 FROM zespol z WHERE z.Imie_i_nazwisko = p.Owner)
                     AND NOT EXISTS (SELECT 1 FROM przypisania a WHERE a.ID_Projektu = p.ID_Projektu
                                     AND a.Rola_w_projekcie IN ('Kierownik projektu','Wlasciciel'))""")
    section("Projekty bez prowadzącego z prawem edycji (Owner nie pasuje do Zespołu i brak 'Kierownika projektu')", no_lead,
            lambda r: f"{r['ID_Projektu']} {r['Nazwa']} — Owner: {r['Owner']!r}")
    no_owner = q("SELECT ID_Projektu, Nazwa FROM projekty WHERE (Owner IS NULL OR Owner='') AND COALESCE(Status,'')<>'Zakonczony'")
    section("Projekty bez architekta prowadzacego", no_owner, lambda r: f"{r['ID_Projektu']} {r['Nazwa']}")

    # 7. konta bez powiazanej osoby (rola zespolu wymaga powiazania - od tego zalezy "moje projekty")
    users_np = q("SELECT Email, Rola FROM users WHERE Rola IN ('Specjalista','Pracownik_biurowy','Architekt_PM') AND ID_Osoby IS NULL")
    section("Konta zespolu bez powiazanej osoby w Zespole", users_np, lambda r: f"{r['Email']} ({r['Rola']})")
    pending = q("SELECT Email FROM users WHERE Rola IS NULL AND Aktywny=1")
    section("Konta oczekujace na nadanie roli", pending, lambda r: r["Email"])
    conn.close()
    print("\nNic nie zostalo zmienione. Usuwanie/scalanie - recznie, po decyzji.")


if __name__ == "__main__":
    main()
