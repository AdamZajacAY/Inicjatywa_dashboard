-- Schemat SQLite dla dashboardu Inicjatywa Projektowa.
-- Kolumny 1:1 z EXPORT_HEADERS w dashboard/app.js i nagłówkami w generuj_baze.py -
-- patrz README.md / plan migracji dla uzasadnienia. Enumy (Status, Priorytet, ...)
-- to zwykły TEXT, walidowany po stronie server.py, nie CHECK constraints.
--
-- NOT NULL na kluczach glownych i na kolumnach FK z ON DELETE CASCADE ("nalezy do") -
-- kolumny FK z ON DELETE SET NULL ("przypisany do / odpowiedzialny za") zostaja
-- nullable, bo o to w SET NULL wlasnie chodzi (dziecko przezywa usuniecie rodzica).
-- Jesli zmieniasz to pod istniejaca baza z danymi, patrz baza_danych/schema_migrate.py -
-- SQLite nie pozwala dopisac NOT NULL do istniejacej kolumny przez zwykly ALTER TABLE.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projekty (
  ID_Projektu TEXT PRIMARY KEY NOT NULL,
  Nazwa TEXT,
  Typ_projektu TEXT,
  Funkcja_biura TEXT,
  Segment TEXT,
  Owner TEXT,
  Kierownik_projektu TEXT,
  ID_Osoby_sponsora TEXT REFERENCES zespol(ID_Osoby) ON DELETE SET NULL,
  Status TEXT,
  Faza TEXT,
  Priorytet TEXT,
  RAG_Status TEXT,
  Tagi TEXT,
  Data_rozpoczecia TEXT,
  Data_zakonczenia_planowana TEXT,
  Data_zakonczenia_rzeczywista TEXT,
  Procent_postepu REAL,
  Budzet_calkowity REAL,
  Budzet_wydany REAL,
  Waluta TEXT,
  Przychod_planowany REAL,
  Przychod_rzeczywisty REAL,
  Szacowane_roboczogodziny REAL,
  Stawka_godzinowa_srednia REAL,
  Lokalizacja_Adres TEXT,
  Miasto TEXT,
  Powierzchnia_m2 REAL,
  Liczba_jednostek INTEGER,
  Inwestor_Klient TEXT,
  Opis TEXT,
  Link_do_dokumentacji TEXT,
  Data_ostatniej_aktualizacji TEXT,
  Komentarz TEXT
);

CREATE TABLE IF NOT EXISTS zespol (
  ID_Osoby TEXT PRIMARY KEY NOT NULL,
  Imie_i_nazwisko TEXT,
  Stanowisko_Rola TEXT,
  Dzial TEXT,
  Email TEXT,
  Telefon TEXT,
  Dostepnosc_FTE_procent REAL,
  Stawka_godzinowa REAL,
  Data_dolaczenia TEXT,
  Aktywny TEXT
);

CREATE TABLE IF NOT EXISTS przypisania (
  ID_Przypisania TEXT PRIMARY KEY NOT NULL,
  ID_Projektu TEXT NOT NULL REFERENCES projekty(ID_Projektu) ON DELETE CASCADE,
  ID_Osoby TEXT NOT NULL REFERENCES zespol(ID_Osoby) ON DELETE CASCADE,
  Rola_w_projekcie TEXT,
  Procent_zaangazowania REAL,
  Data_od TEXT,
  Data_do TEXT,
  Status TEXT
);

CREATE TABLE IF NOT EXISTS harmonogram (
  ID_Zadania TEXT PRIMARY KEY NOT NULL,
  ID_Projektu TEXT NOT NULL REFERENCES projekty(ID_Projektu) ON DELETE CASCADE,
  Nazwa_zadania TEXT,
  Kategoria TEXT,
  ID_Osoby_odpowiedzialnej TEXT REFERENCES zespol(ID_Osoby) ON DELETE SET NULL,
  Data_start_plan TEXT,
  Data_koniec_plan TEXT,
  Data_start_rzeczywista TEXT,
  Data_koniec_rzeczywista TEXT,
  Procent_ukonczenia REAL,
  ID_Zadania_poprzedzajacego TEXT REFERENCES harmonogram(ID_Zadania) ON DELETE SET NULL,
  Kamien_milowy TEXT,
  Status TEXT,
  Priorytet TEXT,
  Uwagi TEXT
);

CREATE TABLE IF NOT EXISTS podwykonawcy (
  ID_Podwykonawcy TEXT PRIMARY KEY NOT NULL,
  Nazwa TEXT,
  Branza TEXT,
  Typ_wspolpracy TEXT,
  Osoba_kontaktowa TEXT,
  Email TEXT,
  Telefon TEXT,
  NIP TEXT,
  Miasto TEXT,
  Ocena TEXT,
  Status TEXT,
  Uwagi TEXT
);

CREATE TABLE IF NOT EXISTS zadania_tickety (
  ID_Tickietu TEXT PRIMARY KEY NOT NULL,
  ID_Projektu TEXT NOT NULL REFERENCES projekty(ID_Projektu) ON DELETE CASCADE,
  ID_Etapu TEXT REFERENCES harmonogram(ID_Zadania) ON DELETE SET NULL,
  Tytul TEXT,
  Opis TEXT,
  ID_Osoby_przypisanej TEXT REFERENCES zespol(ID_Osoby) ON DELETE SET NULL,
  ID_Osoby_zglaszajacej TEXT REFERENCES zespol(ID_Osoby) ON DELETE SET NULL,
  ID_Osoby_wspomagajacej TEXT REFERENCES zespol(ID_Osoby) ON DELETE SET NULL,
  ID_Podwykonawcy TEXT REFERENCES podwykonawcy(ID_Podwykonawcy) ON DELETE SET NULL,
  Wycena_podwykonawcy REAL,
  Data_utworzenia TEXT,
  Termin TEXT,
  Szacowane_roboczogodziny REAL,
  Rzeczywiste_roboczogodziny REAL,
  Priorytet TEXT,
  Status TEXT,
  Data_zakonczenia TEXT
);

CREATE TABLE IF NOT EXISTS komentarze_tickety (
  ID_Komentarza TEXT PRIMARY KEY NOT NULL,
  ID_Tickietu TEXT NOT NULL REFERENCES zadania_tickety(ID_Tickietu) ON DELETE CASCADE,
  Autor TEXT,
  Tresc TEXT NOT NULL,
  Data_utworzenia TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_komentarze_tickiet ON komentarze_tickety(ID_Tickietu);

CREATE TABLE IF NOT EXISTS kamienie_milowe (
  ID_Kamienia TEXT PRIMARY KEY NOT NULL,
  ID_Projektu TEXT NOT NULL REFERENCES projekty(ID_Projektu) ON DELETE CASCADE,
  Nazwa_kamienia TEXT,
  Data_planowana TEXT,
  Data_rzeczywista TEXT,
  Status TEXT,
  ID_Osoby_odpowiedzialnej TEXT REFERENCES zespol(ID_Osoby) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ryzyka_i_problemy (
  ID TEXT PRIMARY KEY NOT NULL,
  ID_Projektu TEXT NOT NULL REFERENCES projekty(ID_Projektu) ON DELETE CASCADE,
  Typ TEXT,
  Opis TEXT,
  Kategoria TEXT,
  Prawdopodobienstwo TEXT,
  Wplyw TEXT,
  Priorytet TEXT,
  ID_Osoby_wlasciciela TEXT REFERENCES zespol(ID_Osoby) ON DELETE SET NULL,
  Plan_mitygacji TEXT,
  Status TEXT,
  Data_identyfikacji TEXT,
  Data_zamkniecia TEXT
);

CREATE TABLE IF NOT EXISTS raporty_statusowe (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  Data_raportu TEXT,
  ID_Projektu TEXT NOT NULL REFERENCES projekty(ID_Projektu) ON DELETE CASCADE,
  RAG_Status TEXT,
  Procent_postepu REAL,
  Budzet_wydany_skumulowany REAL,
  Kluczowe_osiagniecia TEXT,
  Kluczowe_problemy TEXT,
  Nastepne_kroki TEXT,
  Autor_raportu TEXT
);

CREATE TABLE IF NOT EXISTS przypisania_podwykonawcow (
  ID_Przypisania_Podw TEXT PRIMARY KEY NOT NULL,
  ID_Projektu TEXT NOT NULL REFERENCES projekty(ID_Projektu) ON DELETE CASCADE,
  ID_Podwykonawcy TEXT NOT NULL REFERENCES podwykonawcy(ID_Podwykonawcy) ON DELETE CASCADE,
  Branza TEXT,
  Zakres_prac TEXT,
  Data_od TEXT,
  Data_do TEXT,
  Wartosc_umowy REAL,
  Waluta TEXT,
  Status TEXT,
  Uwagi TEXT
);

-- Konta logowania + role (Specjalista / Architekt_PM / COO / Admin). Rola NULL = konto
-- Oczekujace na zatwierdzenie (zero dostepu do danych, patrz server.py before_request).
-- Osobna tabela od `zespol` (rejestr osob/roboczogodzin) - login moze, ale nie musi,
-- byc powiazany z konkretna osoba z zespolu (ID_Osoby), np. konta COO/Admin czysto
-- systemowe moga zostac niepowiazane.
CREATE TABLE IF NOT EXISTS users (
  ID_Uzytkownika TEXT PRIMARY KEY NOT NULL,
  Email TEXT NOT NULL UNIQUE,
  Imie_i_nazwisko TEXT,
  Haslo_Hash TEXT,                 -- NULL = konto zalozone wylacznie przez Google
  Google_Sub TEXT UNIQUE,          -- stabilny identyfikator 'sub' z Google; NULL = konto haslowe
  Rola TEXT,                       -- NULL=Oczekujace | Specjalista | Architekt_PM | COO | Admin
  ID_Osoby TEXT UNIQUE REFERENCES zespol(ID_Osoby) ON DELETE SET NULL,
  Aktywny INTEGER NOT NULL DEFAULT 1,
  Data_utworzenia TEXT,
  Data_ostatniego_logowania TEXT
);

CREATE INDEX IF NOT EXISTS idx_przypisania_projekt ON przypisania(ID_Projektu);
CREATE INDEX IF NOT EXISTS idx_przypisania_osoba ON przypisania(ID_Osoby);
CREATE INDEX IF NOT EXISTS idx_harmonogram_projekt ON harmonogram(ID_Projektu);
CREATE INDEX IF NOT EXISTS idx_tickety_projekt ON zadania_tickety(ID_Projektu);
CREATE INDEX IF NOT EXISTS idx_kamienie_projekt ON kamienie_milowe(ID_Projektu);
CREATE INDEX IF NOT EXISTS idx_ryzyka_projekt ON ryzyka_i_problemy(ID_Projektu);
CREATE INDEX IF NOT EXISTS idx_raporty_projekt ON raporty_statusowe(ID_Projektu);
CREATE INDEX IF NOT EXISTS idx_przypisania_podw_projekt ON przypisania_podwykonawcow(ID_Projektu);
CREATE INDEX IF NOT EXISTS idx_users_osoba ON users(ID_Osoby);
