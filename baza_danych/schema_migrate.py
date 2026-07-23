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

import datetime
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


def _ensure_table(db_path, table_name):
    """Generyczny CREATE TABLE IF NOT EXISTS dla nowej, niezaleznej tabeli, wprost z schema.sql
    (jedno zrodlo definicji) - tani sqlite_master check przed czytaniem/parsowaniem pliku, zeby
    nie robic tego bezwarunkowo na kazdym starcie serwera (audyt: efficiency). Nie tworzy
    indeksow - jesli tabela ich potrzebuje, dodaj je osobno (patrz ensure_komentarze_table).
    Wspolny helper dla wszystkich nowych tabel ponizej, zamiast kopiowania tej samej funkcji
    za kazdym razem, gdy przybywa kolejna."""
    conn = sqlite3.connect(db_path)
    try:
        exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table_name,)
        ).fetchone()
        if exists:
            return
        with open(SCHEMA_PATH, encoding="utf-8") as f:
            schema_sql = f.read()
        create_statements = _extract_create_statements(schema_sql)
        conn.execute(create_statements[table_name])
        conn.commit()
    finally:
        conn.close()


def ensure_komentarze_table(db_path):
    """Dodaje tabele komentarze_tickety (nowa funkcjonalnosc) do baz, ktore powstaly przed jej
    wprowadzeniem. Indeks tworzony osobno, bezwarunkowo (idempotentny CREATE INDEX IF NOT
    EXISTS) - w przeciwienstwie do samej tabeli, nie ma kosztu wartego pomijania go, gdy tabela
    juz istnieje, a to jedyny sposob, zeby przyszly nowy indeks na tej tabeli tez sie doinstalowal
    na juz zmigrowanych bazach."""
    _ensure_table(db_path, "komentarze_tickety")
    conn = sqlite3.connect(db_path)
    try:
        with open(SCHEMA_PATH, encoding="utf-8") as f:
            schema_sql = f.read()
        for stmt in re.findall(r"CREATE INDEX IF NOT EXISTS idx_komentarze_tickiet.*?;", schema_sql):
            conn.execute(stmt)
        conn.commit()
    finally:
        conn.close()


def ensure_notifications_table(db_path):
    """Dodaje tabele powiadomienia (wzmianki @Imie Nazwisko w komentarzach do ticketow) do baz,
    ktore powstaly przed jej wprowadzeniem. Indeks tworzony osobno, bezwarunkowo - ten sam powod
    co ensure_komentarze_table() powyzej."""
    _ensure_table(db_path, "powiadomienia")
    conn = sqlite3.connect(db_path)
    try:
        with open(SCHEMA_PATH, encoding="utf-8") as f:
            schema_sql = f.read()
        for stmt in re.findall(r"CREATE INDEX IF NOT EXISTS idx_powiadomienia_osoba.*?;", schema_sql):
            conn.execute(stmt)
        conn.commit()
    finally:
        conn.close()


def ensure_ideapool_table(db_path):
    """Dodaje tabele ideapool (zgloszenia inicjatyw wewnetrznych) do baz, ktore powstaly przed
    jej wprowadzeniem."""
    _ensure_table(db_path, "ideapool")


def _ensure_columns(db_path, table, new_cols):
    """Generyczny ALTER TABLE ... ADD COLUMN dla nullable kolumn - kolumny sa nullable, wiec
    to nie jest retrofit ograniczenia jak w migrate_schema() powyzej, SQLite wspiera ADD COLUMN
    z klauzula REFERENCES bez przebudowy tabeli. Bezpieczne do wielokrotnego wywolania
    (PRAGMA table_info sprawdza co juz istnieje). Wspolny helper dla wszystkich lekkich,
    addytywnych migracji ponizej, zamiast kopiowania tej samej petli PRAGMA+ALTER za kazdym
    razem, gdy przybywa nowe nullable pole FK na istniejacej tabeli."""
    conn = sqlite3.connect(db_path)
    try:
        existing_cols = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        for col, decl in new_cols.items():
            if col not in existing_cols:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
        conn.commit()
    finally:
        conn.close()


def ensure_ticket_role_columns(db_path):
    """Dodaje ID_Osoby_zglaszajacej/ID_Osoby_wspomagajacej do zadania_tickety w bazach
    powstalych przed ich wprowadzeniem."""
    _ensure_columns(db_path, "zadania_tickety", {
        "ID_Osoby_zglaszajacej": "TEXT REFERENCES zespol(ID_Osoby) ON DELETE SET NULL",
        "ID_Osoby_wspomagajacej": "TEXT REFERENCES zespol(ID_Osoby) ON DELETE SET NULL",
    })


def ensure_project_sponsor_column(db_path):
    """Dodaje ID_Osoby_sponsora do projekty w bazach powstalych przed jej wprowadzeniem -
    czlonek zarzadu (Dzial="Zarzad" w zespol) odpowiedzialny za finansowanie projektu."""
    _ensure_columns(db_path, "projekty", {
        "ID_Osoby_sponsora": "TEXT REFERENCES zespol(ID_Osoby) ON DELETE SET NULL",
    })


def ensure_klienci_tables(db_path):
    """Dodaje tabele klienci/kontakty_klienta do baz, ktore powstaly przed ich wprowadzeniem."""
    _ensure_table(db_path, "klienci")
    _ensure_table(db_path, "kontakty_klienta")


def ensure_project_klient_column(db_path):
    """Dodaje ID_Klienta do projekty w bazach powstalych przed jej wprowadzeniem - opcjonalny FK
    do klienci, obok istniejacego wolnotekstowego Inwestor_Klient (nietkniete, patrz schema.sql)."""
    _ensure_columns(db_path, "projekty", {
        "ID_Klienta": "TEXT REFERENCES klienci(ID_Klienta) ON DELETE SET NULL",
    })


def ensure_checklist_table(db_path):
    """Dodaje tabele checklisty_projektow do baz, ktore powstaly przed jej wprowadzeniem."""
    _ensure_table(db_path, "checklisty_projektow")


def ensure_client_krs_column(db_path):
    """Dodaje KRS do klienci w bazach powstalych przed jej wprowadzeniem - numer KRS, osobne
    pole od NIP (oficjalne API KRS resortu sprawiedliwosci wyszukuje wylacznie po numerze
    KRS, nie po NIP)."""
    _ensure_columns(db_path, "klienci", {"KRS": "TEXT"})


def ensure_person_photo_column(db_path):
    """Dodaje Zdjecie_URL do zespol w bazach powstalych przed jej wprowadzeniem - sciezka do
    przeslanego zdjecia profilowego (patrz /api/zespol/<id>/avatar w server.py), nullable -
    brak zdjecia to wciaz poprawny, obslugiwany stan (fallback na inicjaly)."""
    _ensure_columns(db_path, "zespol", {"Zdjecie_URL": "TEXT"})


def ensure_project_golive_column(db_path):
    """Dodaje Data_go_live do projekty w bazach powstalych przed jej wprowadzeniem - data
    wdrozenia, domyslnie sugerowana w UI jako Data_zakonczenia_planowana, ale edytowalna
    osobno (zwykle nullable TEXT, ta sama konwencja co pozostale daty)."""
    _ensure_columns(db_path, "projekty", {"Data_go_live": "TEXT"})


def ensure_subcontractor_assignment_actual_end_column(db_path):
    """Dodaje Data_zakonczenia_rzeczywista do przypisania_podwykonawcow w bazach powstalych
    przed jej wprowadzeniem - Data_do pelni role terminu planowanego (juz istnieje), ta
    kolumna to termin rzeczywisty, ustawiany automatycznie przy zmianie Status na "Zakonczony"
    (mirror deriveTicketCompletionDate() w app.js), do mierzenia opoznienia podwykonawcy."""
    _ensure_columns(db_path, "przypisania_podwykonawcow", {"Data_zakonczenia_rzeczywista": "TEXT"})


def ensure_harmonogram_subproject_columns(db_path):
    """Dodaje Typ_etapu i RAG_Status do harmonogram w bazach powstalych przed migracja
    master-projekt/sub-projekt (Faza 1, warsztat 22.07.2026) - harmonogram ewoluuje do roli
    sub-projektu, patrz komentarz przy CREATE TABLE w schema.sql."""
    _ensure_columns(db_path, "harmonogram", {"Typ_etapu": "TEXT", "RAG_Status": "TEXT"})


def ensure_zadania_etapy_table(db_path):
    """Dodaje tabele zadania_etapy (n:n zadania_tickety<->harmonogram) do baz powstalych przed
    jej wprowadzeniem - zastepuje zadania_tickety.ID_Etapu (zostaje w schemacie jako
    deprecated/nieuzywany), pozwala przypiac jedno zadanie do kilku etapow naraz."""
    _ensure_table(db_path, "zadania_etapy")
    conn = sqlite3.connect(db_path)
    try:
        with open(SCHEMA_PATH, encoding="utf-8") as f:
            schema_sql = f.read()
        for stmt in re.findall(r"CREATE INDEX IF NOT EXISTS idx_zadania_etapy_.*?;", schema_sql):
            conn.execute(stmt)
        conn.commit()
    finally:
        conn.close()


# projekty.Status i harmonogram.Status sa DWOMA ROZNYMI slownikami (nie te same stringi,
# patrz komentarz przy compute_master_status() w server.py) - migracja NIE moze kopiowac
# wartosci 1:1, inaczej wyliczanie rollupu (ktore porownuje do slownika harmonogram) cicho
# nie rozpozna np. "Zakonczony" (projekty) jako rownowaznika "Zakonczone" (harmonogram) i
# kazdy zmigrowany projekt wygladalby jak "Planowanie" niezaleznie od realnego stanu sprzed
# migracji. Nie importowane z server.py (uniknięcie importu kolowego - server.py juz
# importuje Z schema_migrate.py).
_PROJECT_STATUS_TO_STAGE_STATUS = {
    "Planowanie": "Nie rozpoczete",
    "W realizacji": "W trakcie",
    "Wstrzymany": "Wstrzymany",
    "Przeglad": "Przeglad",
    "Zakonczony": "Zakonczone",
    "Anulowany": "Anulowany",
}


def ensure_default_subproject_for_legacy_projects(db_path):
    """Migracja master-projekt/sub-projekt (Faza 1, warsztat 22.07.2026): kazdy istniejacy
    wiersz projekty bez ANI JEDNEGO sub-projektu (harmonogram) dostaje dokladnie jeden,
    dziedziczacy jego dotychczasowy Typ_projektu/Faza (jako Typ_etapu)/Status (przetlumaczony
    na slownik harmonogram, patrz _PROJECT_STATUS_TO_STAGE_STATUS)/RAG_Status/daty/postep -
    inaczej compute_master_status()/compute_master_rag() w server.py (ktore ZAWSZE wyliczaja
    projekty.Status/RAG_Status na odczycie z sub-projektow) widzialyby kazdy istniejacy
    projekt jako "Planowanie"/brak RAG, dopoki ktos recznie nie doda etapu.
    Bezpieczne do wielokrotnego wywolania (idempotentne) - pomija projekty, ktore juz maja
    >=1 sub-projekt (utworzone po migracji przez multiselect typu, albo juz raz zmigrowane).
    NIE laczy rozjechanych dzis wierszy tego samego tematu (np. "konkurs 97 = projekt
    Wieliszew") w jeden master - to wymaga wiedzy domenowej, patrz osobna akcja "Polacz
    projekty" w app.js, dostepna dla COO/Admin."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        projects = conn.execute("SELECT * FROM projekty").fetchall()
        existing_ids = {row[0] for row in conn.execute("SELECT DISTINCT ID_Projektu FROM harmonogram").fetchall()}
        max_n = 0
        for row in conn.execute("SELECT ID_Zadania FROM harmonogram").fetchall():
            m = re.match(r"^ZAD(\d+)$", row[0] or "")
            if m:
                max_n = max(max_n, int(m.group(1)))
        for p in projects:
            if p["ID_Projektu"] in existing_ids:
                continue
            max_n += 1
            new_id = f"ZAD{str(max_n).zfill(3)}"
            stage_status = _PROJECT_STATUS_TO_STAGE_STATUS.get(p["Status"], "Nie rozpoczete")
            conn.execute(
                "INSERT INTO harmonogram (ID_Zadania, ID_Projektu, Nazwa_zadania, Typ_etapu, "
                "Status, RAG_Status, Data_start_plan, Data_koniec_plan, Data_koniec_rzeczywista, "
                "Procent_ukonczenia) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (new_id, p["ID_Projektu"], p["Typ_projektu"] or p["Nazwa"] or "Etap głowny",
                 p["Typ_projektu"] or p["Faza"], stage_status, p["RAG_Status"],
                 p["Data_rozpoczecia"], p["Data_zakonczenia_planowana"],
                 p["Data_zakonczenia_rzeczywista"], p["Procent_postepu"]),
            )
        conn.commit()
    finally:
        conn.close()


def ensure_project_identification_columns(db_path):
    """Dodaje Sygnatura/Symbol_projektu/Nazwa_zamierzenia_budowlanego do projekty w bazach
    powstalych przed ich wprowadzeniem (Faza 2, A4/A5/A6, warsztat 22.07.2026) - wszystkie
    trzy nullable, wypelniane recznie (bez automatycznej ekstrakcji z Nazwa - sprawdzone na
    produkcji, ze rzeczywiste nazwy projektow nie maja spojnego, parsowalnego wzorca)."""
    _ensure_columns(db_path, "projekty", {
        "Sygnatura": "TEXT", "Symbol_projektu": "TEXT", "Nazwa_zamierzenia_budowlanego": "TEXT",
    })


def ensure_etykiety_konfiguracji_table(db_path):
    """Dodaje tabele etykiety_konfiguracji (edytowalny slownik etykiet, Faza 2, A13) do baz
    powstalych przed jej wprowadzeniem."""
    _ensure_table(db_path, "etykiety_konfiguracji")
    conn = sqlite3.connect(db_path)
    try:
        with open(SCHEMA_PATH, encoding="utf-8") as f:
            schema_sql = f.read()
        for stmt in re.findall(r"CREATE INDEX IF NOT EXISTS idx_etykiety_.*?;", schema_sql):
            conn.execute(stmt)
        conn.commit()
    finally:
        conn.close()


# Startowe wartosci = dokladnie to, co dotad bylo hardkodowane w TYP_ETAPU/SEGMENTS/
# FUNKCJE_BIURA w app.js (Faza 1/juz istniejace) - migracja tylko PRZENOSI je do tabeli,
# nie zmienia zestawu ani kolejnosci, zeby wyglad/zachowanie sprzed A13 sie nie zmienilo.
_SEED_ETYKIETY = {
    "Typ_etapu": ["Konkurs", "Analiza urbanistyczna/chlonnosci", "Projekt koncepcyjny",
                  "Projekt budowlany (PB)", "Projekt techniczny (PT)", "Projekt wykonawczy (PW)",
                  "Nadzor autorski", "Przetarg", "Budowa", "Zakonczenie", "Inne"],
    "Segment": ["Mieszkaniowy", "Komercyjny", "Publiczny", "Zielen"],
    "Funkcja_biura": ["Projektant wiodacy", "Nadzor autorski", "Analiza/doradztwo",
                       "Uczestnik konkursu", "Koordynacja branzowa"],
}


def ensure_seed_etykiety_konfiguracji(db_path):
    """Zasiewa etykiety_konfiguracji poczatkowymi wartosciami przy pierwszym uruchomieniu po
    Faza 2 (A13) - TYLKO dla kategorii, ktore jeszcze nie maja ZADNEGO wiersza (jesli zespol juz
    zaczal recznie zarzadzac etykietami danej kategorii - np. usunal/dodal cos - migracja jej
    nie dotyka, bezpieczne do wielokrotnego wywolania). Kolor przypisany cyklicznie z
    istniejacej palety cat-1..cat-8 (ta sama, ktorej TYPE_COLORS/FAZA_COLORS juz uzywaly w
    app.js), zeby wyglad sprzed migracji sie nie zmienil."""
    conn = sqlite3.connect(db_path)
    try:
        existing_categories = {row[0] for row in conn.execute("SELECT DISTINCT Kategoria FROM etykiety_konfiguracji").fetchall()}
        max_n = 0
        for row in conn.execute("SELECT ID_Etykiety FROM etykiety_konfiguracji").fetchall():
            m = re.match(r"^ETY(\d+)$", row[0] or "")
            if m:
                max_n = max(max_n, int(m.group(1)))
        for kategoria, values in _SEED_ETYKIETY.items():
            if kategoria in existing_categories:
                continue
            for i, wartosc in enumerate(values):
                max_n += 1
                eid = f"ETY{str(max_n).zfill(3)}"
                conn.execute(
                    "INSERT INTO etykiety_konfiguracji (ID_Etykiety, Kategoria, Wartosc, Kolor, Kolejnosc, Aktywna) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (eid, kategoria, wartosc, f"cat-{(i % 8) + 1}", i, "Tak"),
                )
        conn.commit()
    finally:
        conn.close()


def ensure_project_location_columns(db_path):
    """Dodaje strukturalne pola lokalizacji urzedowej do projekty w bazach powstalych przed
    ich wprowadzeniem (Faza 2, A7, warsztat 22.07.2026) - osobne od istniejacych Lokalizacja_
    Adres/Miasto (adres roboczy, nietkniety)."""
    _ensure_columns(db_path, "projekty", {
        "Kraj": "TEXT", "Wojewodztwo": "TEXT", "Powiat": "TEXT", "Gmina": "TEXT",
        "Miejscowosc": "TEXT", "Ulica": "TEXT", "Kod_pocztowy": "TEXT",
    })


def ensure_dzialki_table(db_path):
    """Dodaje tabele dzialki (dzialki ewidencyjne projektu, 1-10 na projekt) do baz powstalych
    przed jej wprowadzeniem (Faza 2, A7)."""
    _ensure_table(db_path, "dzialki")
    conn = sqlite3.connect(db_path)
    try:
        with open(SCHEMA_PATH, encoding="utf-8") as f:
            schema_sql = f.read()
        for stmt in re.findall(r"CREATE INDEX IF NOT EXISTS idx_dzialki_.*?;", schema_sql):
            conn.execute(stmt)
        conn.commit()
    finally:
        conn.close()


def ensure_project_contract_columns(db_path):
    """Dodaje Wymagania_PFU/Dane_planu_miejscowego do projekty w bazach powstalych przed ich
    wprowadzeniem (Faza 4, C4, warsztat 22.07.2026) - dane z umowy/PFU na poziomie master
    projektu, wolny tekst (patrz komentarz przy CREATE TABLE w schema.sql)."""
    _ensure_columns(db_path, "projekty", {"Wymagania_PFU": "TEXT", "Dane_planu_miejscowego": "TEXT"})


def ensure_harmonogram_deadline_columns(db_path):
    """Dodaje Termin_nieprzekraczalny/Data_sprawdzenia do harmonogram w bazach powstalych przed
    ich wprowadzeniem (Faza 4, C4/C5) - flaga terminu nieprzekraczalnego z umowy per etap +
    osobny wewnetrzny deadline sprawdzenia PRZED nim."""
    _ensure_columns(db_path, "harmonogram", {"Termin_nieprzekraczalny": "TEXT", "Data_sprawdzenia": "TEXT"})


def ensure_checklista_szablony_table(db_path):
    """Dodaje tabele checklista_szablony (uniwersalny szablon checklisty wstepnej, Faza 4, C1)
    do baz powstalych przed jej wprowadzeniem."""
    _ensure_table(db_path, "checklista_szablony")


# Przyklady wprost z notatek warsztatu (22.07.2026, sekcja C1) - startowy, edytowalny zestaw
# (mirror A13: zasiewa TYLKO przy pierwszym uruchomieniu, dalej w pelni zarzadzane z poziomu
# appki, patrz ensure_seed_checklista_szablony ponizej). Finalna zawartosc/kategoryzacja (C3,
# Faza 5) czeka na burze mozgow zespolu - to jest bezpieczny punkt startowy, nie ostateczna lista.
_SEED_CHECKLISTA_SZABLONY = [
    "Warunki wodociągowe", "Warunki kanalizacyjne", "Warunki na odprowadzenie wód deszczowych",
    "Warunki gazowe", "Warunki elektroenergetyczne", "Warunki teletechniczne",
    "Warunki drogowe / zjazd", "Inwentaryzacja zieleni", "Odrolnienie",
    "Mapa do celów projektowych", "Mapa zasadnicza", "Wypis i wyrys z rejestru gruntów",
    "Badania geologiczne", "Pełnomocnictwa",
]


def ensure_seed_checklista_szablony(db_path):
    """Zasiewa checklista_szablony startowym zestawem TYLKO gdy tabela jest calkowicie pusta
    (pierwsze uruchomienie po Faza 4) - jesli zespol juz recznie zarzadza szablonem, migracja
    go nie dotyka (ten sam warunek co ensure_seed_etykiety_konfiguracji)."""
    conn = sqlite3.connect(db_path)
    try:
        if conn.execute("SELECT COUNT(*) FROM checklista_szablony").fetchone()[0] > 0:
            return
        for i, nazwa in enumerate(_SEED_CHECKLISTA_SZABLONY):
            sid = f"SZB{str(i + 1).zfill(3)}"
            conn.execute(
                "INSERT INTO checklista_szablony (ID_Szablonu, Nazwa, Kolejnosc, Aktywna) VALUES (?, ?, ?, ?)",
                (sid, nazwa, i, "Tak"),
            )
        conn.commit()
    finally:
        conn.close()


def ensure_checklist_instance_columns(db_path):
    """Dodaje ID_Szablonu/Wymagany/ID_Tickietu do checklisty_projektow w bazach powstalych przed
    Faza 4 (C1/C2) - odwraca wczesniejsza decyzje "bez szablonu" (patrz komentarz w schema.sql),
    na ponowne, wprost zyczenie zespolu z warsztatu."""
    _ensure_columns(db_path, "checklisty_projektow", {
        "ID_Szablonu": "TEXT REFERENCES checklista_szablony(ID_Szablonu) ON DELETE SET NULL",
        "Wymagany": "TEXT", "ID_Tickietu": "TEXT REFERENCES zadania_tickety(ID_Tickietu) ON DELETE SET NULL",
    })


def ensure_checklist_backfill_for_existing_projects(db_path):
    """Dla kazdego istniejacego projektu, wstawia brakujace pozycje checklisty z AKTYWNYCH
    wierszy checklista_szablony (dopasowanie po ID_Szablonu) - musi biec PO
    ensure_checklist_instance_columns/ensure_seed_checklista_szablony (potrzebuje obu). Bez tego
    tylko NOWO tworzone projekty (przez _instantiate_checklist_for_new_project w server.py)
    dostawalyby pelna checklist - projekty sprzed Fazy 4 zostalyby z pusta/niepelna lista mimo
    ze C1 wprost chce "ta sama [checklista] dla kazdego projektu". Idempotentne - dopasowanie
    po (ID_Projektu, ID_Szablonu) pomija juz istniejace wiersze."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        templates = conn.execute("SELECT * FROM checklista_szablony WHERE Aktywna = 'Tak' ORDER BY Kolejnosc").fetchall()
        if not templates:
            return
        projects = [row[0] for row in conn.execute("SELECT ID_Projektu FROM projekty").fetchall()]
        existing = {(row[0], row[1]) for row in conn.execute(
            "SELECT ID_Projektu, ID_Szablonu FROM checklisty_projektow WHERE ID_Szablonu IS NOT NULL"
        ).fetchall()}
        max_n = 0
        for row in conn.execute("SELECT ID_Pozycji FROM checklisty_projektow").fetchall():
            m = re.match(r"^CHK(\d+)$", row[0] or "")
            if m:
                max_n = max(max_n, int(m.group(1)))
        now = datetime.datetime.now().isoformat(timespec="seconds")
        for pid in projects:
            for t in templates:
                if (pid, t["ID_Szablonu"]) in existing:
                    continue
                max_n += 1
                cid = f"CHK{str(max_n).zfill(4)}"
                conn.execute(
                    "INSERT INTO checklisty_projektow (ID_Pozycji, ID_Projektu, ID_Szablonu, Tresc, "
                    "Wymagany, Wykonano, Kolejnosc, Data_utworzenia) VALUES (?, ?, ?, ?, 'Nie', 'Nie', ?, ?)",
                    (cid, pid, t["ID_Szablonu"], t["Nazwa"], t["Kolejnosc"], now),
                )
        conn.commit()
    finally:
        conn.close()


def ensure_notatki_spotkan_tables(db_path):
    """Dodaje tabele notatki_spotkan/notatka_punkty (Faza 4, D1) do baz powstalych przed ich
    wprowadzeniem."""
    _ensure_table(db_path, "notatki_spotkan")
    _ensure_table(db_path, "notatka_punkty")
    conn = sqlite3.connect(db_path)
    try:
        with open(SCHEMA_PATH, encoding="utf-8") as f:
            schema_sql = f.read()
        for stmt in re.findall(r"CREATE INDEX IF NOT EXISTS idx_notat\w+ ON \w+\(\w+\);", schema_sql):
            conn.execute(stmt)
        conn.commit()
    finally:
        conn.close()


def ensure_polish_role_translation(db_path):
    """Faza 5 (A17, 'kalka jezykowa') - tlumaczy istniejace przypisania.Rola_w_projekcie='Owner'
    (angielskie) na 'Wlasciciel' (mirror ROLE_W_PROJEKCIE w app.js) - usuwa niespojnosc jezykowa
    w UI (obok juz istniejacego polskiego "Właściciel" dla ID_Osoby_wlasciciela w ryzykach).
    Idempotentne - UPDATE po prostu nie trafia w nic przy kolejnym uruchomieniu."""
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("UPDATE przypisania SET Rola_w_projekcie = 'Wlasciciel' WHERE Rola_w_projekcie = 'Owner'")
        conn.commit()
    finally:
        conn.close()


def ensure_ticket_reactivation_column(db_path):
    """Dodaje Liczba_reaktywacji do zadania_tickety w bazach powstalych przed jej wprowadzeniem
    (Faza 5, B11/B12, warsztat 22.07.2026) - "zakonczone na teraz" != "zamkniete na zawsze"
    (np. dach rysowany 10x); licznik reaktywacji slada tez jako rejestr powtorzen (B12) do
    kalibracji przyszlych estymacji czasu."""
    _ensure_columns(db_path, "zadania_tickety", {"Liczba_reaktywacji": "INTEGER"})


def ensure_ticket_timeline_and_tags_columns(db_path):
    """Dodaje Data_rozpoczecia/Tagi/Typ_zadania do zadania_tickety w bazach powstalych przed
    ich wprowadzeniem (Faza 3, warsztat 22.07.2026, B3/B6/B10). Data_rozpoczecia to opcjonalny
    start (np. zlozenie wniosku) - Termin/Data_zakonczenia (plan/rzeczywiste zakonczenie) juz
    istnialy. Tagi mirroruje istniejacy, dzialajacy mechanizm projekty.Tagi (CSV, ten sam
    fTagsInput() w app.js). Typ_zadania (Urzedowe/Wewnetrzne) - NULL traktowany jak Wewnetrzne
    (bezpieczny domyslny brak specjalnego oznaczenia czerwonej flagi terminu nieprzekraczalnego,
    patrz B10)."""
    _ensure_columns(db_path, "zadania_tickety", {
        "Data_rozpoczecia": "TEXT", "Tagi": "TEXT", "Typ_zadania": "TEXT",
    })


if __name__ == "__main__":
    import sys
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "baza_projektow.db")
    print(migrate_schema(path))
    print(ensure_komentarze_table(path) or "komentarze_tickety: OK")
    print(ensure_ticket_role_columns(path) or "zadania_tickety role columns: OK")
    print(ensure_project_sponsor_column(path) or "projekty sponsor column: OK")
    print(ensure_ideapool_table(path) or "ideapool: OK")
    print(ensure_klienci_tables(path) or "klienci/kontakty_klienta: OK")
    print(ensure_project_klient_column(path) or "projekty klient column: OK")
    print(ensure_checklist_table(path) or "checklisty_projektow: OK")
    print(ensure_client_krs_column(path) or "klienci KRS column: OK")
    print(ensure_project_golive_column(path) or "projekty Data_go_live column: OK")
