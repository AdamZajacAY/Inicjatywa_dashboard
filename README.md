# Inicjatywa Projektowa — Pulpit Projektów

System do zarządzania portfelem projektów **biura architektonicznego** (projekty
koncepcyjne, analizy urbanistyczne, projekty budowlane i wykonawcze, nadzory autorskie,
konkursy architektoniczne): **backend Flask + baza SQLite** + **dashboard HTML/JS jako frontend**.
Jeden proces (`server.py`) serwuje zarówno stronę, jak i REST API — baza żyje w jednym pliku
`baza_danych/baza_projektow.db`, współdzielonym przez wszystkich, którzy łączą się z tym samym
serwerem (patrz „Architektura” niżej, jeśli wcześniej znałeś tę wersję z Excelem jako bazą).

Dostęp wymaga **logowania** — konta i role (Specjalista / Architekt-PM / COO / Admin) opisane
w sekcji „Konta, role i logowanie” niżej. Nawigacja żyje w lewym sidebarze, nie w górnym menu.

## Struktura pakietu

```
server.py                      <- URUCHOM TO: python3 server.py -> backend + dashboard na http://localhost:8000
requirements.txt                <- zaleznosci Pythona (Flask, openpyxl, gunicorn) - pip3 install -r requirements.txt
Procfile / render.yaml          <- pod wdrozenie na Render (patrz sekcja "Wdrozenie na Render")
.gitignore                      <- wyklucza baze/dane realne/sekrety z historii gita
analiza/
  Analiza_systemu_PMO.md      <- pełna analiza PMO: co i dlaczego jest w systemie
baza_danych/
  baza_projektow.db            <- BAZA DANYCH (SQLite) - tu żyją wszystkie dane (poza gitem)
  schema.sql                   <- struktura tabel (11 tabel, w tym `users` - konta/role)
  excel_to_sqlite.py            <- jednorazowy migrator Baza_Projektow.xlsx -> baza_projektow.db
  create_admin.py              <- tworzy pierwsze konto COO/Admin (potrzebne po instalacji)
  backup_db.py                  <- backup bazy (recznie albo cron/launchd) - patrz sekcja Backup
  backups/                      <- kopie zapasowe bazy (poza gitem)
  Baza_Projektow.xlsx          <- historyczny plik Excela (źródło pierwszej migracji, realne dane)
  generuj_baze.py             <- skrypt, który generuje/odtwarza ten plik xlsx od zera
dashboard/
  index.html / app.js / style.css
  vendor/                     <- SheetJS (używane tylko przez ręczny „Eksportuj do Excela”) + logo
```

## Jak zacząć

1. Zależności Pythona (jednorazowo): `pip3 install -r requirements.txt`
2. Jeśli katalog `baza_danych/baza_projektow.db` jeszcze nie istnieje: `python3 baza_danych/excel_to_sqlite.py`
   (wczytuje dane z `Baza_Projektow.xlsx` do nowej bazy SQLite — bezpieczne do wielokrotnego
   uruchomienia, za każdym razem czyści i wczytuje na nowo z Excela).
3. Pierwsze konto (jednorazowo, potrzebne żeby ktokolwiek mógł się zalogować):
   `python3 baza_danych/create_admin.py` — interaktywnie pyta o e-mail/imię/hasło i tworzy
   konto **Admin**. Z tego konta nadajesz potem role kolejnym osobom (zakładka „Użytkownicy”).
4. W terminalu, w tym katalogu: `python3 server.py` — **trzymaj ten proces uruchomiony** przez
   cały czas pracy z dashboardem (to jest teraz prawdziwy backend, nie tylko serwer plików).
   Otworzy się przeglądarka pod `http://localhost:8000/dashboard/index.html` z ekranem logowania.
   Zatrzymanie: `Ctrl+C` w terminalu.
5. Zaloguj się kontem Admina z kroku 3. Gotowe — zobaczysz sidebar po lewej (Przegląd, Projekty,
   Zespół, Podwykonawców, Zadania, Gantt, Ryzyka, Użytkownicy) i wszystko działa jak wcześniej.
   Każda zmiana w dashboardzie (dodanie projektu, przeciągnięcie ticketu w Kanbanie, edycja
   etapu...) od razu trafia przez REST API do `baza_projektow.db`.

Jeśli `server.py` nie działa, dashboard pokaże ekran z instrukcją zamiast danych (nie da się
pomylić z „pustą bazą”). `python3 server.py` binduje się domyślnie na `127.0.0.1` (tylko ten
komputer); żeby udostępnić dashboard innym w tej samej sieci lokalnej, zmień `app.run(port=PORT)`
na `app.run(host="0.0.0.0", port=PORT)` w `server.py` — teraz, kiedy jest logowanie i role, to
jest już bezpieczne (wcześniej każdy w sieci miałby pełny dostęp bez pytania o hasło).

## Architektura — dlaczego backend + SQLite (a nie Excel/localStorage jak wcześniej)

Wcześniejsza wersja tego dashboardu trzymała dane w pliku Excela + `localStorage` przeglądarki,
z zerowym serwerem — świadomy wybór dla prostoty przy jednej osobie pracującej lokalnie. Gdy
pojawiła się potrzeba, żeby kilka osób mogło pracować na **tej samej, żywej bazie** jednocześnie,
ten model przestał wystarczać (plik Excela na dysku + auto-zapis z jednej karty przeglądarki nie
daje współbieżnej edycji). `server.py` (Flask) + SQLite to zamiast tego:

- Jeden plik bazy (`baza_danych/baza_projektow.db`) jako jedyne źródło prawdy — każdy klient
  (przeglądarka) czyta i zapisuje przez to samo REST API (`/api/projekty`, `/api/zadania_tickety`,
  ...), więc zmiany są od razu widoczne wszystkim po odświeżeniu.
- Kaskadowe usuwanie i integralność danych (klucze obce) pilnowane przez samą bazę, nie przez
  ręcznie pisane filtry w JS.
- Zero nowych wymagań dla użytkownika końcowego — dashboard w przeglądarce wygląda i działa tak
  samo, zmienia się tylko to, co dzieje się „pod spodem” przy zapisie.

Warstwa renderowania w `dashboard/app.js` (widoki, formularze, walidacja, Kanban, Gantt) nie
zmieniła się w ogóle — zmieniła się wyłącznie warstwa persystencji (`apiGet/apiPost/apiPut/
apiDelete` zamiast czytania/pisania Excela i `localStorage`).

## Konta, role i logowanie

Dostęp do dashboardu wymaga konta. Nowe konto (założone przez Admina albo przez logowanie
Google — patrz niżej) startuje jako **Oczekujące**: widzi ekran „czeka na zatwierdzenie” i nie
ma dostępu do żadnych danych, dopóki COO albo Admin nie nada mu jednej z 3 ról:

| Rola | Zakres |
|---|---|
| **Specjalista** | Podgląd całego portfela (bez danych finansowych — budżet/marża/stawki godzinowe są ukryte), zgłaszanie i edycja własnych ticketów w projektach, do których jest przypisany. |
| **Architekt/PM** | Pełne zarządzanie (dodawanie/edycja etapów, ticketów, ryzyk, zespołu) na projektach, do których jest przypisany (przez zakładkę „+ Dodaj do zespołu”) — na pozostałych projektach ma tylko podgląd. Może zakładać nowe projekty i dodawać/edytować podwykonawców, ale nie usuwać projektów ani podwykonawców. |
| **COO / Admin** | Pełny dostęp do wszystkiego, łącznie z zarządzaniem kontami/rolami i backupami. Te dwie role mają identyczne uprawnienia — różnią się tylko etykietą. |

Uprawnienia są egzekwowane **po stronie serwera** (`server.py`) niezależnie od tego, co pokazuje
UI — ukrywanie przycisków w dashboardzie to wygoda, nie mechanizm bezpieczeństwa.

Zarządzanie kontami: zakładka **Użytkownicy** (widoczna tylko dla COO/Admin) — nadawanie/zmiana
roli, powiązanie z osobą z zespołu (wymagane dla ról Specjalista/Architekt-PM, bo od tego zależy
„które projekty są moje”), dezaktywacja konta (działa natychmiast, nawet dla kogoś aktualnie
zalogowanego) i reset hasła. Tam samo jest panel backupów (patrz niżej).

**Logowanie przez Google:** dashboard obsługuje „Zaloguj się przez Google” — przycisk pojawia
się na ekranie logowania automatycznie, gdy skonfigurujesz dane aplikacji OAuth. Bez tego kroku
logowanie hasłem działa normalnie, przycisk Google po prostu się nie pokazuje. Konfiguracja:

1. [Google Cloud Console](https://console.cloud.google.com/) → nowy projekt (albo istniejący) →
   „APIs & Services” → „OAuth consent screen” (wystarczy typ „External”, tryb testowy).
2. „Credentials” → „Create Credentials” → „OAuth client ID” → typ **Web application**.
3. Jako **Authorized redirect URI** wpisz dokładnie `http://localhost:8000/api/auth/google/callback`
   (dla pracy lokalnej) — jeśli wdrażasz na Render albo udostępniasz w sieci lokalnej pod innym
   adresem, redirect URI musi wskazywać na ten adres, nie na `localhost` (Google wymaga
   dokładnego dopasowania schematu/hosta/portu/ścieżki).
4. Skopiowany Client ID i Client Secret wklej do `baza_danych/oauth_config.json` (plik
   gitignorowany, utwórz go ręcznie — patrz przykład niżej) albo ustaw jako zmienne środowiskowe
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` (wygodniejsze pod Render).

```json
{
  "client_id": "xxxxx.apps.googleusercontent.com",
  "client_secret": "xxxxx",
  "redirect_uri": "http://localhost:8000/api/auth/google/callback"
}
```

Pierwsze logowanie przez Google (podobnie jak każde nowe konto) ląduje jako Oczekujące — Admin
musi je zatwierdzić i nadać rolę w zakładce Użytkownicy.

## Backup bazy danych

`baza_danych/backup_db.py` robi kopię `baza_projektow.db` do `baza_danych/backups/` (nazwa z
timestampem, bezpieczne w trakcie działania serwera — używa `sqlite3.Connection.backup()`, nie
zwykłego kopiowania pliku). Trzy sposoby uruchomienia:

- **Automatycznie przy starcie** `python3 server.py` — jedna kopia na każde uruchomienie serwera.
- **Ręcznie z dashboardu** — przycisk „Backup teraz” w zakładce Użytkownicy (COO/Admin).
- **Samodzielnie** — `python3 baza_danych/backup_db.py` (opcje `--keep N` dla retencji,
  domyślnie 30 kopii; `--quiet` pod cron/launchd, jeśli chcesz backup np. co noc niezależnie od
  tego, czy dashboard akurat działa).

**Przywracanie jest celowo bez przycisku w UI** (zbyt łatwo o pomyłkę przy nadpisywaniu żywej
bazy) — procedura ręczna: zatrzymaj `server.py`, skopiuj żywą bazę gdzieś na bok jako dodatkowe
zabezpieczenie, podmień `baza_danych/baza_projektow.db` wybranym plikiem z `baza_danych/backups/`,
uruchom serwer ponownie.

## Wdrożenie na Render

`Procfile` i `render.yaml` w katalogu głównym przygotowują ten sam kod (Flask + SQLite) pod
hosting na [Render](https://render.com) — to podniesienie obecnego stosu do chmury, nie
przepisanie na inną bazę (Postgres to osobny, późniejszy krok — patrz „Ścieżka rozwoju”).

1. Wypchnij repo na GitHub (prywatne repo — baza/dane realne i tak są poza gitem przez
   `.gitignore`, ale kod i struktura są wtedy widoczne, więc bez wyraźnej potrzeby trzymaj
   prywatnie).
2. W panelu Render: „New” → „Blueprint” → wskaż to repo — `render.yaml` opisuje usługę,
   dysk trwały i zmienne środowiskowe automatycznie.
3. **Wymaga płatnego planu instancji** — SQLite potrzebuje zamontowanego dysku trwałego
   (`/var/data`), a darmowy tier Render ma ulotny system plików (dane znikałyby przy każdym
   redeployu).
4. W zakładce „Environment” dopisz ręcznie `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` /
   `GOOGLE_REDIRECT_URI`, jeśli chcesz logowania Google na produkcji (redirect URI musi wtedy
   wskazywać na adres Render, nie na `localhost` — zarejestruj go też w Google Cloud Console).
5. Pierwsze uruchomienie na świeżym dysku startuje z **pustą** bazą (schemat, zero danych) —
   `python3 baza_danych/create_admin.py` trzeba wtedy odpalić przez powłokę Render (`Shell` w
   panelu usługi) albo załadować dane inną drogą (np. podmieniając plik na dysku backupem).

## Zarządzanie portfelem — wszystko wyklikane w dashboardzie

To jest teraz **główne narzędzie pracy PMO**, nie tylko podgląd. Wprost w dashboardzie:

- **+ Nowy projekt** (zakładka Projekty) — nazwa, typ, owner, kierownik projektu, status/faza/
  priorytet/RAG, terminy, **budżet i wycena (szacowane roboczogodziny × stawka godzinowa →
  szacowany koszt pracy)**, lokalizacja, zakres/opis (karta projektowa), komentarz PMO.
  „Edytuj” / „Usuń” — w karcie projektu (po kliknięciu w kafelek).
- **+ Dodaj osobę** (zakładka Zespół) — imię i nazwisko, stanowisko, **grupa funkcyjna** (nie
  sztywny dział korporacyjny — np. Architekci, Specjaliści, Kierownictwo projektów, PMO...),
  kontakt, dostępność (FTE %). „Edytuj” / „Usuń” — po kliknięciu w osobę.
- **+ Dodaj do zespołu** (w karcie projektu) — przypisuje osobę do projektu z rolą (Owner,
  Kierownik projektu, Członek zespołu, Wsparcie, Sponsor) i % zaangażowania; stąd też edycja i
  usuwanie przypisań. To jest sedno logiki zespołowej: **zespół przypisuje się do projektu**
  (np. architekt + kilku specjalistów wsparcia), a nie odwrotnie.
- **+ Dodaj podwykonawcę** (zakładka Podwykonawcy) — osobna **biblioteka branżystów** (firmy/osoby
  robiące projekty instalacji elektrycznych, sanitarnych, gazowych, wentylacji itd.):
  branża, typ współpracy, kontakt, ocena, status. Niezależna od projektów — raz dodany
  podwykonawca jest dostępny do przypisania w każdym projekcie.
- **+ Przypisz podwykonawcę** (w karcie projektu) — wybierasz podwykonawcę z biblioteki i
  określasz zakres prac, daty, wartość umowy i status dla tego konkretnego projektu; edycja i
  usuwanie przypisań tak samo jak przy zespole.
- **+ Dodaj etap** (w karcie projektu, sekcja Harmonogram) — nazwa etapu, kategoria, odpowiedzialny,
  **daty start–koniec (deadline z podziałem na etapy)**, % ukończenia, status, kamień milowy.
  Kliknięcie w pasek/wiersz na Gantcie otwiera ten sam formularz do edycji etapu — to jest
  edytowalny Gantt. Gantt można też przełączyć, żeby grupował wiersze **wg osoby** zamiast wg
  projektu — widok obciążenia zespołu w czasie.
- **+ Nowy ticket** (w karcie projektu, sekcja Zadania/tickety) — to jest poziom niżej niż etap:
  **konkretne zadanie przypisane do jednej osoby**, z tytułem, opisem, terminem, priorytetem,
  statusem oraz **szacowanymi i rzeczywistymi roboczogodzinami**. Każdy ticket ma własne ID
  (`TCK001`, `TCK002`...) i opcjonalnie może być powiązany z konkretnym etapem harmonogramu.
  Zakładka **Zadania** pokazuje wszystkie tickety całego portfela w jednej tabeli (filtrowanej po
  projekcie/osobie/statusie/tylko-opóźnione) — jedno miejsce, w którym manager widzi, kto ma co
  na głowie i z jakim terminem.

**Terminowość i powiadomienia:** dashboard sam wylicza, czy etapy/tickety kończą się na czas
(porównując termin planowany z rzeczywistą datą zakończenia) i pokazuje to na Przeglądzie jako
wskaźnik „Terminowość” (%) oraz listę **🔔 Powiadomień** — opóźnione etapy, opóźnione tickety,
zbliżające się kamienie milowe (7 dni) i projekty z czerwonym RAG, każde klikalne wprost do
właściwego projektu. To nie są powiadomienia e-mail/push (brak serwera) — to alerty widoczne od
razu po wejściu do dashboardu.

**Wycena vs. koszt rzeczywisty:** projekt ma dwa niezależne poziomy kosztu pracy — odgórną
wycenę (`Szacowane_roboczogodziny × Stawka_godzinowa_srednia`, ręcznie wpisana liczba) oraz
**realny koszt liczony oddolnie z ticketów**: suma `Rzeczywiste_roboczogodziny` każdego ticketu
pomnożona przez **indywidualną stawkę godzinową przypisanej osoby** (pole `Stawka_godzinowa` w
karcie osoby — puste na start, do uzupełnienia). Oba są pokazane obok siebie w karcie projektu,
żeby było widać rozjazd między planem a rzeczywistością.

**Marża i mark-up:** projekt ma pola `Przychód planowany`/`Przychód rzeczywisty` (kontrakt/wartość
sprzedaży). Dashboard liczy z tego marżę (`% względem przychodu`) i mark-up (`% względem kosztu`)
per projekt oraz zbiorczo dla portfela — widoczne jako KPI i wykres na Przeglądzie. Bez
uzupełnionego przychodu pole po prostu nie liczy się (nie ma fałszywych zer).

**Tagi i priorytetyzacja:** pole `Tagi` (dowolne słowa oddzielone przecinkami, np. „kluczowy
klient, ryzyko regulacyjne”) — filtrowalne w widoku Projekty i pokazane jako etykiety na karcie.
Listę projektów można sortować wg priorytetu, RAG (najgorsze pierwsze), najbliższego terminu albo
nazwy.

Zmiany zapisują się **od razu na serwerze** (SQLite, `baza_danych/baza_projektow.db`) — nie ma
już rozróżnienia na „zapisano lokalnie” vs. „zapisano do pliku”: jest jedno miejsce prawdy,
widoczne natychmiast dla każdego, kto ma otwarty dashboard połączony z tym samym `server.py`.

## Współdzielenie z zespołem i Excel

SQLite jest teraz jedynym źródłem prawdy, ale Excel zostaje jako **format eksportu/wymiany**:

- **Eksportuj do Excela** (przycisk w nagłówku) — ręczny zrzut całego bieżącego stanu bazy do
  pobranego pliku `Baza_Projektow.xlsx`. Przydatny jako kopia zapasowa, do wysłania mailem, albo
  do pracy offline w Excelu bez dashboardu.
- Żeby udostępnić dashboard całemu zespołowi na tej samej sieci, uruchom `server.py` na jednym
  komputerze z `host="0.0.0.0"` (patrz „Jak zacząć”) — reszta zespołu wpisuje w przeglądarce adres
  IP tego komputera zamiast `localhost`.
- Import z powrotem z Excela do SQLite (np. po masowej edycji w Excelu) nie ma dziś dedykowanego
  przycisku w dashboardzie — uruchom ponownie `python3 baza_danych/excel_to_sqlite.py` wskazując
  zaktualizowany plik (nadpisuje `baza_projektow.db` od zera, więc rób to świadomie).

## Co jest w bazie (skrót — pełny opis w `analiza/Analiza_systemu_PMO.md`)

Tabele SQLite (`baza_danych/schema.sql`) odpowiadają 1:1 dawnym arkuszom Excela:

| Tabela SQLite | Co przechowuje |
|---|---|
| `projekty` | karta każdego projektu: typ, **funkcja biura**, owner, kierownik, status, faza, RAG, terminy, budżet, wycena (roboczogodziny × stawka), lokalizacja... |
| `zespol` | rejestr osób: rola, grupa funkcyjna (Architekci/Specjaliści/Kierownictwo/PMO/...), dostępność (FTE) |
| `przypisania` | kto jest przypisany do jakiego projektu, w jakiej roli i z jakim % czasu |
| `harmonogram` | zadania/etapy projektu pod Gantta |
| `zadania_tickety` | granularne zadania przypisane do osoby **i/lub podwykonawcy** — termin, opis, priorytet, szacowane/rzeczywiste roboczogodziny, wycena podwykonawcy, własne ID |
| `kamienie_milowe` | kluczowe daty decyzyjne (pozwolenia, odbiory, otwarcia) |
| `podwykonawcy` | **biblioteka branżystów/podwykonawców** (elektrycy, hydraulicy, instalacje gazowe, wentylacja...) — niezależna od projektów |
| `przypisania_podwykonawcow` | które konkretne przypisanie podwykonawcy do projektu (zakres prac, daty, wartość umowy, status) |
| `ryzyka_i_problemy` | rejestr ryzyk i problemów z planem mitygacji |
| `raporty_statusowe` | historia cyklicznych statusów (trend RAG/budżetu w czasie) |

(`Pulpit`, `Karta_Projektu` i `Slowniki` istniały tylko w Excelu jako pomoce — formuły KPI,
wzór karty do druku i listy rozwijane — i nie mają odpowiednika w SQLite; ich rolę w pełni
przejął dashboard.)

Jedenasta tabela, `users` (konta/role/logowanie), nie pochodzi z Excela — to nowa tabela
systemowa opisana w sekcji „Konta, role i logowanie” wyżej, nie część domenowych danych biura.

Baza zawiera **realne dane zebrane z notatek zespołu i uporządkowane w `Propozycja_Macierzy_Projektow.xlsx`**,
zmigrowane z historycznego `Baza_Projektow.xlsx` (21 projektów, 12 osób, 36 przypisań — stan na
2026-07-07): `projekty`, `zespol`, `przypisania`. Projekty mają czytelne ID nawiązujące do
prowadzącego (`JB-01`…`JB-05` = Jan B, `WF-01`…`WF-05` = Wojtek F, `GK-01`…`GK-06` = Grzegorz K,
`MC-01`…`MC-05` = Monika Ch), zgodnie z propozycją macierzy. Pole `Funkcja_biura` (Projektant
wiodący / Nadzór autorski / Analiza-doradztwo / Uczestnik konkursu / Koordynacja branżowa)
odzwierciedla realne rodzaje zleceń biura projektowego (nie profil dewelopera). Pozostałe tabele
(`harmonogram`, `zadania_tickety`, `kamienie_milowe`, `podwykonawcy`, `przypisania_podwykonawcow`,
`ryzyka_i_problemy`, `raporty_statusowe`) startują puste — gotowe do uzupełniania na bieżąco przez
zespół w dashboardzie.

## Dashboard — co zobaczysz

- **Przegląd** — KPI portfela (w tym **terminowość** i **marża portfela**), panel **🔔
  Powiadomień** (opóźnione etapy/tickety, zbliżające się kamienie milowe, czerwony RAG), budżet,
  rozkład RAG, priorytetów i typów, **wykres marży per projekt**, najczęstsze tagi, projekty
  wymagające uwagi, nadchodzące kamienie milowe.
- **Projekty** — karty z filtrami (typ, status, owner, RAG, **tag**) i **sortowaniem**
  (priorytet / RAG / termin / nazwa), tagi jako etykiety na karcie. Klik → pełna karta projektu:
  dane podstawowe, postęp i budżet (wycena top-down **i** realny koszt z ticketów, przychód,
  marża, mark-up), zespół (dodaj/edytuj/usuń), **podwykonawcy/branżyści**, **zadania/tickety**
  (dodaj/edytuj/usuń — przypisanie do osoby z terminem, opisem i roboczogodzinami), kamienie
  milowe, ryzyka, edytowalny mini-Gantt, historia statusów, przycisk „Drukuj kartę projektu”.
- **Zespół** — obciążenie każdej osoby (% przypisań vs. dostępność FTE), stawka godzinowa; klik →
  lista jej projektów **i przypisanych zadań/ticketów** z terminami.
- **Podwykonawcy** — biblioteka branżystów/podwykonawców niezależna od projektów, filtrowalna
  po branży i statusie; klik w kartę pokazuje wszystkie projekty, do których jest przypisany.
- **Zadania** — wszystkie tickety całego portfela w jednej tabeli, filtrowane po projekcie,
  osobie, statusie i „tylko opóźnione” — przegląd obciążenia i zaległości zespołu.
- **Harmonogram / Gantt** — oś czasu etapów, **grupowana wg projektu lub wg osoby** (przełącznik),
  filtrowana po typie/odpowiedzialnym; kliknięcie w etap otwiera go do edycji.
- **Ryzyka i problemy** — tabela z filtrami, priorytetami i statusami.

## Rozbudowa struktury bazy

Na co dzień dane wprowadza się przez dashboard — struktura (dodanie nowej kolumny, nowej tabeli)
zmienia się w trzech miejscach, które muszą pozostać spójne:

1. `baza_danych/schema.sql` — definicja tabeli/kolumny.
2. `server.py` — słownik `TABLES` (jeśli to nowa tabela, dopisz PK/prefiks ID), ewentualnie
   `BOOTSTRAP_KEYS`, i — jeśli nowe pole jest finansowe/wrażliwe albo nowa tabela ma inny zakres
   dostępu niż reszta — `TABLE_SCOPE`/`FINANCIAL_FIELDS`/`ALWAYS_STRIP_FIELDS` (patrz „Konta,
   role i logowanie”), inaczej domyślnie dziedziczy zasady tabeli, do której należy przez FK.
3. `dashboard/app.js` — odpowiedni formularz (`openProjectForm`, `openTeamForm`,
   `openAssignmentForm`, `openTaskForm`, `openTicketForm`, `openSubcontractorForm`,
   `openSubcontractorAssignmentForm`, `openRiskForm`, `openUserForm`) oraz `EXPORT_HEADERS`
   (używane przez ręczny eksport do Excela), `DATE_FIELDS` (jeśli nowe pole jest datą), i
   `TABLE_SCOPE` (lustrzane odbicie tego z `server.py`, do ukrywania przycisków w UI).

Istniejące dane w `baza_danych/baza_projektow.db` nie znikają przy zmianie schematu — dopisz
`ALTER TABLE` do `schema.sql` i zastosuj go ręcznie (`sqlite3 baza_danych/baza_projektow.db < migracja.sql`),
albo w skrajnym przypadku zmigruj od nowa z `Baza_Projektow.xlsx` przez `excel_to_sqlite.py`
(uwaga: to nadpisuje bazę od zera). `generuj_baze.py` pozostaje jako historyczny sposób
wygenerowania pliku `Baza_Projektow.xlsx` (np. do jednorazowego eksportu/udostępnienia komuś bez
dostępu do dashboardu) — nie jest już częścią głównego cyklu pracy.

## Marka

Kolorystyka i logo dashboardu są dopasowane do [inicjatywaprojektowa.pl](https://inicjatywaprojektowa.pl/)
(czerń/ciepła biel, minimalistyczny znak). Kolory funkcjonalne (RAG, statusy zadań, typy
projektów) pozostają odrębne od brandingu — muszą być rozróżnialne i czytelne niezależnie od
identyfikacji wizualnej.

## Ścieżka rozwoju

Logowanie, role i uprawnienia per osoba — kiedyś opisane tu jako naturalny następny krok — są już
zrobione (patrz „Konta, role i logowanie” wyżej), podobnie jak backup i gotowość pod hosting
poza siecią lokalną (Render). To, co zostaje jako osobny, późniejszy krok: `server.py` lokalnie
wciąż uruchamia deweloperski serwer Flaska (widoczne ostrzeżenie w konsoli — pod Render zastępuje
go już gunicorn, patrz `Procfile`), a SQLite ma sens do pewnej skali zespołu/portfela i
współbieżności zapisów. Jeśli to kiedyś przestanie wystarczać, naturalnym kolejnym krokiem jest
właściwa aplikacja webowa z bazą klasy Postgres (masz już zalążek w projekcie `InicjatywaP` —
Next.js + Prisma + Postgres, z modułami `projects`, `gantt`, `tickets`, `crm`, `finances`,
`capacity`). Nazwy tabel/kolumn w `baza_danych/schema.sql` zostały zaprojektowane tak, żeby 1:1
mapować się na przyszłe tabele Postgresa — migracja danych byłaby prostym eksportem/importem, nie
przepisywaniem struktury.
