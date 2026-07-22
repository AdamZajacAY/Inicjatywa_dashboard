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
  -- Sygnatura/Symbol_projektu/Nazwa_zamierzenia_budowlanego (Faza 2, A4/A5/A6, warsztat
  -- 22.07.2026) - osobne od ID_Projektu (wewnetrzny PK, PRJ###) i od Nazwa (opisowa, robocza).
  -- Sygnatura = czlon cyfrowy numeru projektu, Symbol_projektu = krotki kod (np. "ZGN"),
  -- Nazwa_zamierzenia_budowlanego = oficjalny, niezmienny tytul z PFU/inwestora (stron
  -- tytulowych/dokumentacji) - CELOWO bez limitu dlugosci (A6, bywaja bardzo dlugie).
  Sygnatura TEXT,
  Symbol_projektu TEXT,
  Nazwa_zamierzenia_budowlanego TEXT,
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
  Data_go_live TEXT,
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
  -- Lokalizacja urzedowa (Faza 2, A7) - OSOBNA od Lokalizacja_Adres/Miasto powyzej (te zostaja
  -- nietkniete, adres "roboczy") i od adresu inwestora - pola potrzebne do wnioskow/pism
  -- urzedowych (np. PB), nie do korespondencji.
  Kraj TEXT,
  Wojewodztwo TEXT,
  Powiat TEXT,
  Gmina TEXT,
  Miejscowosc TEXT,
  Ulica TEXT,
  Kod_pocztowy TEXT,
  Powierzchnia_m2 REAL,
  Liczba_jednostek INTEGER,
  Inwestor_Klient TEXT,
  ID_Klienta TEXT REFERENCES klienci(ID_Klienta) ON DELETE SET NULL,
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
  Aktywny TEXT,
  Zdjecie_URL TEXT
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

-- harmonogram = "etap" projektu, ewoluowany na wprost do roli sub-projektu (warsztat
-- 22.07.2026, master-projekt/sub-projekt) - Typ_etapu (koncepcja/analiza/PB/PT/PW/nadzor/
-- konkurs/...) to NOWA, OSOBNA os klasyfikacji od Kategoria (rodzaj pracy w danym etapie,
-- np. "Rysunki wykonawcze"/"Prezentacja") - nie remapowane jedno na drugie, bo Kategoria ma
-- juz realne dane w 30 wierszach produkcyjnych, a remapowanie na inna taksonomie bez wiedzy
-- domenowej zespolu byloby stratne/zgadywane. RAG_Status: ocena ryzyka etapu (mirror
-- projekty.RAG_Status), master projektu wylicza worst-case z RAG_Status swoich etapow.
CREATE TABLE IF NOT EXISTS harmonogram (
  ID_Zadania TEXT PRIMARY KEY NOT NULL,
  ID_Projektu TEXT NOT NULL REFERENCES projekty(ID_Projektu) ON DELETE CASCADE,
  Nazwa_zadania TEXT,
  Kategoria TEXT,
  Typ_etapu TEXT,
  ID_Osoby_odpowiedzialnej TEXT REFERENCES zespol(ID_Osoby) ON DELETE SET NULL,
  Data_start_plan TEXT,
  Data_koniec_plan TEXT,
  Data_start_rzeczywista TEXT,
  Data_koniec_rzeczywista TEXT,
  Procent_ukonczenia REAL,
  ID_Zadania_poprzedzajacego TEXT REFERENCES harmonogram(ID_Zadania) ON DELETE SET NULL,
  Kamien_milowy TEXT,
  Status TEXT,
  RAG_Status TEXT,
  Priorytet TEXT,
  Uwagi TEXT
);

-- zadania_etapy: tabela laczaca zadania_tickety<->harmonogram (n:n) - zastepuje
-- zadania_tickety.ID_Etapu (pojedynczy nullable FK, zostaje w schemacie jako deprecated/
-- nieuzywany przez nowy kod, addytywna migracja jak wszedzie indziej w tym repo). Jedno
-- zadanie moze byc przypiete do kilku etapow naraz (warsztat: "nie dublowac pracy").
CREATE TABLE IF NOT EXISTS zadania_etapy (
  ID_Tickietu TEXT NOT NULL REFERENCES zadania_tickety(ID_Tickietu) ON DELETE CASCADE,
  ID_Zadania TEXT NOT NULL REFERENCES harmonogram(ID_Zadania) ON DELETE CASCADE,
  PRIMARY KEY (ID_Tickietu, ID_Zadania)
);
CREATE INDEX IF NOT EXISTS idx_zadania_etapy_tickiet ON zadania_etapy(ID_Tickietu);
CREATE INDEX IF NOT EXISTS idx_zadania_etapy_zadanie ON zadania_etapy(ID_Zadania);

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

-- Inwestorzy/Klienci: pelna karta pod przyszle fakturowanie (NIP, adres siedziby, opiekun z
-- zarzadu), zamiast wolnego tekstu. projekty.Inwestor_Klient (powyzej) zostaje NIETKNIETE dla
-- projektow jeszcze niepowiazanych z rejestrem - projekty.ID_Klienta to nowy, opcjonalny FK
-- obok niego, nie zamiennik.
CREATE TABLE IF NOT EXISTS klienci (
  ID_Klienta TEXT PRIMARY KEY NOT NULL,
  Nazwa TEXT,
  Typ TEXT,
  NIP TEXT,
  KRS TEXT,
  Regon TEXT,
  Adres_siedziby TEXT,
  Miasto TEXT,
  Email TEXT,
  Telefon TEXT,
  ID_Osoby_opiekuna TEXT REFERENCES zespol(ID_Osoby) ON DELETE SET NULL,
  Status TEXT,
  Uwagi TEXT
);

-- Osoby kontaktowe po stronie klienta/inwestora - firma zwykle ma kilka, w odroznieniu od
-- podwykonawcy.Osoba_kontaktowa (jedno pole tekstowe wystarczajace tam, bo relacja jest prostsza).
CREATE TABLE IF NOT EXISTS kontakty_klienta (
  ID_Kontaktu TEXT PRIMARY KEY NOT NULL,
  ID_Klienta TEXT NOT NULL REFERENCES klienci(ID_Klienta) ON DELETE CASCADE,
  Imie_i_nazwisko TEXT,
  Stanowisko TEXT,
  Email TEXT,
  Telefon TEXT
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

-- Powiadomienia: dzis wylacznie wzmianki (@Imie Nazwisko) w komentarzach do ticketow, ale
-- Typ jest osobnym polem pod przyszle rodzaje. Zawsze "moje wlasne" niezaleznie od roli
-- (nawet COO/Admin widza tylko swoje) - inny rodzaj scope'owania niz reszta aplikacji
-- (portfolio-restricted per Specjalista), wiec obsluzone bespoke route'ami w server.py,
-- nie generyczna fabryka collection()/item() (patrz komentarz przy /api/powiadomienia).
CREATE TABLE IF NOT EXISTS powiadomienia (
  ID_Powiadomienia TEXT PRIMARY KEY NOT NULL,
  ID_Osoby TEXT NOT NULL REFERENCES zespol(ID_Osoby) ON DELETE CASCADE,
  Typ TEXT,
  ID_Tickietu TEXT REFERENCES zadania_tickety(ID_Tickietu) ON DELETE CASCADE,
  ID_Komentarza TEXT REFERENCES komentarze_tickety(ID_Komentarza) ON DELETE CASCADE,
  Tresc TEXT,
  Autor TEXT,
  Przeczytane TEXT,
  Data_utworzenia TEXT
);
CREATE INDEX IF NOT EXISTS idx_powiadomienia_osoba ON powiadomienia(ID_Osoby);

-- Checklisty projektu: prosta lista kontrolna per projekt, czysty mirror kamienie_milowe
-- (project_scoped, generyczna fabryka, zero bespoke route'ow). Swiadomie BEZ systemu
-- szablonow per kategoria projektu (Typ_projektu) - decyzja podjeta wprost z uzytkownikiem,
-- to "miejsce pod checklisty", nie silnik automatycznego wypelniania.
CREATE TABLE IF NOT EXISTS checklisty_projektow (
  ID_Pozycji TEXT PRIMARY KEY NOT NULL,
  ID_Projektu TEXT NOT NULL REFERENCES projekty(ID_Projektu) ON DELETE CASCADE,
  Tresc TEXT,
  Wykonano TEXT,
  Kolejnosc INTEGER,
  Data_utworzenia TEXT
);

-- Ideapool: zgloszenia wewnetrznych inicjatyw/projektow rozwojowych - kazdy zalogowany moze
-- zglosic (patrz can_write() w server.py), niezalezne od projekty (plaska lista, nie
-- project_scoped). Tytul celowo nullable (nie NOT NULL) - ta sama konwencja co
-- zadania_tickety.Tytul, walidacja wymagalnosci po stronie frontendu (required), bo tabela
-- idzie przez generyczna fabryke collection()/item(), nie ma wlasnego bespoke route jak
-- komentarze_tickety.
CREATE TABLE IF NOT EXISTS ideapool (
  ID_Pomyslu TEXT PRIMARY KEY NOT NULL,
  Tytul TEXT,
  Opis TEXT,
  Kategoria TEXT,
  ID_Osoby_zglaszajacej TEXT REFERENCES zespol(ID_Osoby) ON DELETE SET NULL,
  Status TEXT,
  Data_zgloszenia TEXT NOT NULL,
  Uwagi_zarzadu TEXT
);

CREATE TABLE IF NOT EXISTS kamienie_milowe (
  ID_Kamienia TEXT PRIMARY KEY NOT NULL,
  ID_Projektu TEXT NOT NULL REFERENCES projekty(ID_Projektu) ON DELETE CASCADE,
  Nazwa_kamienia TEXT,
  Data_planowana TEXT,
  Data_rzeczywista TEXT,
  Status TEXT,
  ID_Osoby_odpowiedzialnej TEXT REFERENCES zespol(ID_Osoby) ON DELETE SET NULL
);

-- dzialki: lista dzialek ewidencyjnych projektu (Faza 2, A7) - osobna tabela (nie kolumny na
-- projekty), bo jeden projekt moze miec 1-10 dzialek naraz.
CREATE TABLE IF NOT EXISTS dzialki (
  ID_Dzialki TEXT PRIMARY KEY NOT NULL,
  ID_Projektu TEXT NOT NULL REFERENCES projekty(ID_Projektu) ON DELETE CASCADE,
  Numer_dzialki TEXT,
  Obreb TEXT,
  Identyfikator_dzialki TEXT
);
CREATE INDEX IF NOT EXISTS idx_dzialki_projekt ON dzialki(ID_Projektu);

-- etykiety_konfiguracji: edytowalny slownik etykiet (Faza 2, A13, warsztat 22.07.2026) -
-- zastepuje hardkod TYLKO dla kategorii BEZ semantyki wplywajacej na inna logike (Typ_etapu/
-- Segment/Funkcja_biura). SWIADOMIE NIE obejmuje Status/Priorytet/RAG_Status/Faza - Status ma
-- twarda zaleznosc w rollupie master-projektu (compute_master_status() w server.py porownuje
-- do konkretnych stringow), Priorytet ma kolory oznaczajace realna wage/pilnosc (swobodna
-- zmiana kolorow zaburzylaby czytelnosc "co jest pilne"), Faza jest wycofywana (A10) - swobodna
-- edycja ktoregokolwiek z tych trzech zepsulaby po cichu inna logike.
CREATE TABLE IF NOT EXISTS etykiety_konfiguracji (
  ID_Etykiety TEXT PRIMARY KEY NOT NULL,
  Kategoria TEXT NOT NULL,
  Wartosc TEXT NOT NULL,
  Kolor TEXT,
  Kolejnosc INTEGER,
  Aktywna TEXT,
  UNIQUE(Kategoria, Wartosc)
);
CREATE INDEX IF NOT EXISTS idx_etykiety_kategoria ON etykiety_konfiguracji(Kategoria);

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
  Data_zakonczenia_rzeczywista TEXT,
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
