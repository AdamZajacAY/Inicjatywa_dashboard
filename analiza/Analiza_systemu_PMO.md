# Analiza systemu do zarządzania portfelem projektów — Inicjatywa P

Rola: PMO (Project Management Office)
Cel: lekki, lokalny system do zarządzania portfelem projektów deweloperskich i nieruchomościowych (budynki, skwery/tereny zielone, budynki instytucji publicznych), który zespół może wspólnie prowadzić w Excelu, a przeglądać w dashboardzie.

---

## 1. Kontekst i założenia

- **Rodzaje projektów w portfelu:**
  - Projekty deweloperskie (np. inwestycje mieszkaniowe/komercyjne, od koncepcji po sprzedaż/oddanie)
  - Nieruchomości — budynki (zakup/modernizacja/najem/zarządzanie)
  - Nieruchomości — tereny zielone / skwery (rewitalizacja, budowa, utrzymanie)
  - Budynki instytucji publicznych (np. realizacje dla gminy/miasta, urzędów, szkół itp.)
- **Architektura:** brak backendu/serwera. Excel = format bazy danych/wymiany. Dashboard = statyczny plik HTML/JS, w pełni edytowalny (dodawanie/edycja/usuwanie projektów, zespołu, podwykonawców, harmonogramu wprost w interfejsie), z zapisem lokalnym w przeglądarce (localStorage) na każdą zmianę. Zero instalacji, zero bazy danych, zero hostingu.
- **Auto-zapis do Excela:** w Chrome/Edge dashboard korzysta z File System Access API — po jednorazowym "połączeniu" pliku każda zmiana zapisuje się do niego automatycznie (bez ręcznego eksportu). W przeglądarkach bez wsparcia tego API (Safari/Firefox) dashboard działa w trybie: edycja lokalna + ręczny "Eksportuj do Excela".
- **Praca zespołowa:** plik Excel trzymany na współdzielonym dysku (OneDrive/SharePoint/Google Drive/dysk sieciowy) — auto-zapis + synchronizacja dysku daje zespołowi wspólny, aktualny obraz bez ręcznego przesyłania plików. To nie jest współbieżna edycja wieloosobowa w czasie rzeczywistym (jak Excel Online) — dwie osoby edytujące dashboard równolegle na dwóch komputerach nadpiszą się nawzajem przy zapisie; przy typowej skali PMO (jedna-dwie osoby aktualizujące dane naraz) to wystarczające.
- **Dlaczego nie SQLite:** rozważone i odrzucone na tym etapie — SQLite dałoby trochę wydajności przy bardzo dużej skali, ale kosztem tego, co jest sensem tego rozwiązania: każdy członek zespołu (nie tylko techniczny) otwiera Excel bez żadnych narzędzi. Przy skali dziesiątek/setek projektów Excel nie jest wąskim gardłem wydajnościowym.
- **Filozofia:** zacząć prosto (Excel jako format + w pełni funkcjonalny dashboard HTML), a docelowo — jeśli się przyjmie — migrować do pełnej aplikacji (masz już zalążek w `InicjatywaP` z Prisma/Postgres/Next.js, gdyby portfel/zespół urósł i potrzebne było współdzielone zapisywanie w czasie rzeczywistym, historia zmian, uprawnienia itp.).
- **Odbiorca:** narzędzie kontrolingowe dla **managerów i zarządu**, nie dla całej organizacji — stąd świadoma rezygnacja z pełnej wieloosobowej dostępności w czasie rzeczywistym na rzecz szybkiego, w pełni funkcjonalnego dashboardu jednej-kilku osób. Nacisk położony na: wskaźniki terminowości, alerty o opóźnieniach, granularne zadania (tickety) przypisane do osób z roboczogodzinami, oraz realny koszt i marżowość projektów.

---

## 2. Kluczowe encje (tabele w Excelu)

| Sheet | Rola | Klucz |
|---|---|---|
| `Projekty` | Karta każdego projektu — dane podstawowe, status, budżet, lokalizacja | `ID_Projektu` |
| `Zespol` | Rejestr osób w organizacji/zespole | `ID_Osoby` |
| `Przypisania` | Kto jest przypisany do jakiego projektu, w jakiej roli, z jakim % zaangażowania | `ID_Przypisania` (FK: `ID_Projektu`, `ID_Osoby`) |
| `Harmonogram` | Zadania/etapy projektu — dane pod Gantta | `ID_Zadania` (FK: `ID_Projektu`) |
| `Zadania_Tickety` | Granularne zadania przypisane do **jednej osoby** — termin, opis, roboczogodziny, priorytet, status | `ID_Tickietu` (FK: `ID_Projektu`, opcjonalnie `ID_Etapu`) |
| `Kamienie_milowe` | Kluczowe daty/decyzje (pozwolenia, odbiory, otwarcia) | `ID_Kamienia` (FK: `ID_Projektu`) |
| `Podwykonawcy` | Biblioteka branżystów/podwykonawców (elektrycy, hydraulicy, instalacje gazowe...), niezależna od projektów | `ID_Podwykonawcy` |
| `Przypisania_Podwykonawcow` | Które przypisanie podwykonawcy do projektu — zakres prac, daty, wartość umowy, status | `ID_Przypisania_Podw` (FK: `ID_Projektu`, `ID_Podwykonawcy`) |
| `Ryzyka_i_Problemy` | Rejestr ryzyk i problemów | `ID` (FK: `ID_Projektu`) |
| `Raporty_statusowe` | Cykliczne (np. tygodniowe/miesięczne) snapshoty statusu — historia dla trendów | (FK: `ID_Projektu`, `Data_raportu`) |
| `Pulpit` | Podsumowanie/KPI portfela (formuły) — szybki widok bez dashboardu | — |
| `Slowniki` | Listy słownikowe do walidacji danych (dropdowny) | — |

Pełne definicje pól — patrz plik `baza_danych/Baza_Projektow.xlsx` (każdy sheet ma nagłówki + przykładowe dane + walidację list rozwijanych + kolorowanie warunkowe statusów).

### 2.1 Projekty — kluczowe pola
`ID_Projektu` (czytelne ID nawiązujące do prowadzącego, np. `JB-01` = Jan B, `WF-03` = Wojtek F,
`GK-06` = Grzegorz K, `MC-02` = Monika Ch — zgodnie z `Propozycja_Macierzy_Projektow.xlsx`),
`Nazwa`, `Typ_projektu` (rodzaje zleceń biura architektonicznego: Projekt koncepcyjny / Analiza
urbanistyczna / Projekt budowlany / Projekt wykonawczy / Nadzór autorski / Konkurs / Projekt
techniczny (PT) / Inne — **nie** kategorie dewelopera), **`Funkcja_biura`** (Projektant wiodący /
Nadzór autorski / Analiza-doradztwo / Uczestnik konkursu / Koordynacja branżowa — jaką rolę
pełni biuro w tym zleceniu, uzupełnia `Typ_projektu` o perspektywę "co my tu robimy"), `Segment` (Mieszkaniowy/Komercyjny/Publiczny/Zieleń), `Owner` (właściciel projektu — 1 osoba, odpowiedzialność biznesowa), `Kierownik_projektu` (PM operacyjny — może być inna osoba niż Owner), `Status` (Planowanie/W realizacji/Wstrzymany/Zakończony/Anulowany), `Faza`, `Priorytet`, `RAG_Status` (Zielony/Żółty/Czerwony — zdrowie projektu "na dziś"), **`Tagi`** (dowolne słowa kluczowe oddzielone przecinkiem — filtrowanie/priorytetyzacja poza sztywnym polem `Priorytet`), daty (start/koniec planowany/koniec rzeczywisty), `Procent_postepu`, `Budzet_calkowity`, `Budzet_wydany`, **`Przychod_planowany` + `Przychod_rzeczywisty`** (wartość kontraktu/sprzedaży — baza do liczenia marży i mark-up), **`Szacowane_roboczogodziny` + `Stawka_godzinowa_srednia`** (odgórna wycena pracy własnej — roboczogodziny × stawka = szacowany koszt pracy top-down), `Lokalizacja/Adres`, `Miasto`, `Powierzchnia_m2` / `Liczba_jednostek`, `Inwestor_Klient`, `Opis` (zakres/karta projektowa), `Link_do_dokumentacji`, `Data_ostatniej_aktualizacji`.

**Marża i mark-up (liczone w dashboardzie, nie w Excelu):** `Przychód` (rzeczywisty, jeśli jest — inaczej planowany) minus `Budzet_wydany` = marża. Marża % liczona względem przychodu, mark-up % względem kosztu — to dwa różne, celowo rozdzielone wskaźniki (marża odpowiada na "ile z przychodu zostaje", mark-up na "ile narzutu na koszt"). Pola przychodu są opcjonalne — bez nich projekt po prostu nie pojawia się na wykresie marży, żadnych fałszywych zer.

**Dlaczego rozdzielać Owner i Kierownika projektu:** w projektach nieruchomościowych/publicznych częsta jest sytuacja, że biznesowy właściciel (np. dyrektor pionu deweloperskiego) nie jest osobą operacyjnie prowadzącą harmonogram — to rozróżnienie jest standardem w PMO i odpowiada na wymóg "przypisywanie ludzi do projektu, ownera".

### 2.2 Zespół
Rejestr osób niezależny od projektów — jedna osoba może być przypisana do wielu projektów. Pola: `Imię i nazwisko`, `Stanowisko/Rola`, `Grupa funkcyjna`, `Email`, `Dostępność (FTE %)`, **`Stawka_godzinowa`** (indywidualna stawka PLN/h — podstawa realnego kosztu pracy liczonego z ticketów, patrz 2.3b), `Aktywny`.

**Logika zespołowa — celowo nieformalna:** grupa funkcyjna (pole `Dzial` w danych) **nie** odwzorowuje sztywnych działów korporacyjnych — to praktyczne pogrupowanie odpowiadające temu, jak faktycznie pracuje ten zespół: `Architekci`, `Specjaliści` (wsparcie merytoryczne/techniczne), `Kierownictwo projektów`, `PMO`, plus role wspierające (`Prawny`, `Finansowy`, `Marketing/Sprzedaż`, `Zarząd`). Kluczowe jest to, że **zespół przypisuje się do konkretnego projektu** (np. architekt + 1-2 specjalistów wsparcia) przez tabelę `Przypisania`, a nie odwrotnie — grupa funkcyjna to tylko etykieta osoby, nie jednostka organizacyjna z własnym budżetem/przełożonym.

### 2.3 Przypisania (tabela łącząca — n:n)
To jest serce "zarządzania zespołem". Jedna osoba → wiele projektów, jeden projekt → wiele osób, z rolą i % zaangażowania. Pozwala liczyć **obciążenie zespołu** (suma % przypisań danej osoby względem 100%) i wykrywać przeciążenia/wolne moce.

Role w projekcie: `Sponsor`, `Owner (właściciel biznesowy)`, `Kierownik projektu`, `Członek zespołu`, `Wsparcie/Konsultant`.

### 2.3a Podwykonawcy i ich przypisania (branżyści)
Osobna od `Zespol` biblioteka **zewnętrznych** wykonawców/projektantów branżowych — firmy lub osoby robiące projekty instalacji elektrycznych, sanitarnych/hydraulicznych, gazowych, wentylacji i klimatyzacji, konstrukcyjnych, przeciwpożarowych itd. Dwie tabele:

- `Podwykonawcy` — rejestr niezależny od projektów (jak "adresownik"): `Nazwa`, `Branża`, `Typ_współpracy` (Projektant branżowy / Wykonawca robót / Dostawca / Konsultant), kontakt, NIP, `Ocena` (z dotychczasowej współpracy), `Status` (Aktywny/Zweryfikowany/Nieaktywny/Czarna lista).
- `Przypisania_Podwykonawcow` — n:n do `Projekty`: który podwykonawca, jaki zakres prac w TYM projekcie, daty, wartość umowy, status (Planowany/Aktywny/Zakończony/Wstrzymany).

Rozdzielenie na dwie tabele (biblioteka + przypisania) pozwala raz opisać podwykonawcę (z oceną jakości współpracy) i przypisywać go do wielu projektów bez przepisywania danych kontaktowych za każdym razem — dokładnie ten sam wzorzec co `Zespol`/`Przypisania`.

### 2.3b Zadania (tickety) — praca na poziomie osoby
`Harmonogram` (2.4) opisuje **etapy/fazy projektu** (np. "Projekt budowlany", "Pozwolenie na budowę") — poziom, na którym rysuje się Gantt. `Zadania_Tickety` to poziom niżej: **pojedyncze zadanie przypisane do jednej konkretnej osoby**, z własnym ID (`TCK001`...), `Tytuł`, `Opis`, `Termin`, `Priorytet`, `Status` (Do zrobienia/W trakcie/Zakończone/Opóźnione/Anulowane), `Szacowane_roboczogodziny`, `Rzeczywiste_roboczogodziny`, opcjonalnie powiązane z etapem (`ID_Etapu`). To odpowiedź na potrzebę "przypisywania zadań do każdej osoby wraz z terminem i opisem zadania" oraz "przypisywania liczby roboczogodzin na wykonanie zadań" — z prawdziwym ticketowaniem (unikalne ID per zadanie).

**Realny koszt pracy = suma `Rzeczywiste_roboczogodziny` × indywidualna `Stawka_godzinowa` przypisanej osoby** (z arkusza `Zespol`) — liczone i pokazywane w karcie projektu obok odgórnej wyceny (2.1), żeby widać było rozjazd plan/rzeczywistość.

### 2.3c Terminowość i powiadomienia (liczone w dashboardzie)
- **Wskaźnik terminowości** — % etapów i ticketów zakończonych **na czas** (data rzeczywista ≤ planowana), liczony z historii zakończonych pozycji. Pokazywany na Przeglądzie portfela.
- **Powiadomienia** — lista alertów generowana przy każdym wejściu do dashboardu: etapy po terminie planowanym a niezakończone, tickety po terminie a niezakończone, kamienie milowe zbliżające się (7 dni) lub przeterminowane, projekty z czerwonym RAG. To nie są powiadomienia push/e-mail (brak backendu/serwera) — to widoczny od razu panel `🔔 Powiadomienia`, każdy wpis klikalny wprost do właściwego projektu.

### 2.4 Harmonogram (dane do Gantta)
Zadania/etapy przypisane do projektu, z datami plan/rzeczywiste, % ukończenia, zależnościami (ID poprzedniego zadania), kategorią (Projektowanie/Pozwolenia/Budowa/Odbiory/Sprzedaż...), odpowiedzialnym i flagą "kamień milowy". To źródło danych zarówno dla wykresu Gantta w dashboardzie, jak i uproszczonego Gantta w samym Excelu (warunkowe formatowanie na osi czasu).

### 2.5 Kamienie milowe
Skrócony widok kluczowych dat decyzyjnych (pozwolenie na budowę, odbiór, otwarcie) — używany do szybkiego raportowania do zarządu bez przeglądania całego harmonogramu.

### 2.6 Ryzyka i problemy
Standardowy rejestr ryzyk PMO: `Typ` (Ryzyko/Problem), `Kategoria` (Prawne/Finansowe/Techniczne/Harmonogramowe/Zasoby/Środowiskowe), `Prawdopodobieństwo`, `Wpływ`, `Priorytet` (wyliczany), `Właściciel ryzyka`, `Plan mitygacji`, `Status`. Istotne szczególnie dla projektów publicznych (ryzyka proceduralne/przetargowe) i deweloperskich (ryzyka rynkowe/pozwoleniowe).

### 2.7 Raporty statusowe (historia)
Snapshoty co okres raportowy — pozwalają zobaczyć **trend** (czy RAG się poprawia/pogarsza, czy budżet ucieka), nie tylko stan bieżący. Bez tego traci się historię, bo `Projekty` zawsze pokazuje tylko "stan na teraz".

### 2.8 Pulpit (KPI w samym Excelu)
Zestawienie formułowe (bez dashboardu HTML) — liczba projektów wg statusu/typu/RAG, suma budżetów, projekty zagrożone (czerwony RAG lub opóźnione zadania), obciążenie zespołu. Przydatne, gdy ktoś otwiera tylko Excel bez przeglądarki.

### 2.9 Słowniki
Scentralizowane listy wartości (statusy, typy, role, RAG, priorytety) — jedno miejsce zmiany, wykorzystywane przez walidację danych (dropdowny) we wszystkich sheetach, żeby dane były spójne i nadawały się do agregacji.

---

## 3. Widoki w dashboardzie (frontend)

Dashboard nie jest już tylko podglądem — to pełny interfejs do zarządzania portfelem
(dodawanie/edycja/usuwanie wszędzie tam, gdzie ma to sens biznesowy).

1. **Przegląd portfela (KPI + wizualizacje)** — liczba projektów wg statusu, **wskaźnik terminowości**, opóźnione etapy/tickety, RAG, otwarte ryzyka, **marża portfela**; panel **🔔 Powiadomień** (opóźnienia, zbliżające się kamienie milowe, czerwony RAG — klikalne do projektu); wykresy: budżet, rozkład RAG (pasek segmentowy), rozkład priorytetów, rozkład typów, najczęstsze tagi, **marża per projekt** (pasek poziomy, kolor wg znaku), projekty wymagające uwagi, nadchodzące kamienie milowe.
2. **Karty projektów** — siatka kart z tagami jako etykietami, filtrowalna po typie, statusie, ownerze, RAG, **tagu**; **sortowanie** (priorytet/RAG/termin/nazwa); „+ Nowy projekt" tworzy kartę wprost w dashboardzie.
3. **Karta projektu (widok szczegółowy)** — pełne dane projektu (wycena top-down + **realny koszt z ticketów** + **przychód/marża/mark-up**) + zespół (dodaj/edytuj/usuń) + **podwykonawcy przypisani z biblioteki** + **zadania/tickety przypisane do osób** (dodaj/edytuj/usuń, z terminem/opisem/roboczogodzinami) + kamienie milowe + ryzyka + **edytowalny mini-Gantt** + historia raportów statusowych + przycisk „Drukuj kartę projektu". Edycja/usunięcie całego projektu też stąd.
4. **Zespół / obciążenie** — lista osób, aktywne przypisania, % zaangażowania, stawka godzinowa; klik → projekty **i przypisane tickety** danej osoby.
5. **Podwykonawcy** — biblioteka branżystów niezależna od projektów, filtrowalna po branży/statusie.
6. **Zadania** — wszystkie tickety portfela w jednej tabeli, filtrowane po projekcie/osobie/statusie/tylko-opóźnione.
7. **Gantt** — oś czasu etapów, **grupowana wg projektu lub wg osoby** (przełącznik — widok obciążenia zespołu w czasie), filtrowanie po projekcie/typie/odpowiedzialnym; klik w wiersz = edycja etapu.
8. **Ryzyka** — tabela otwartych ryzyk/problemów posortowana po priorytecie.

---

## 4. Governance / sposób pracy zespołu (rekomendacja PMO)

- **Właściciel pliku (Data Owner):** jedna osoba (np. PMO) odpowiada za strukturę pliku (nie zmienia nazw kolumn/sheetów bez aktualizacji `dashboard/app.js`).
- **Codzienna praca:** przez dashboard, nie przez ręczną edycję Excela — mniejsze ryzyko literówek/niespójności niż wpisywanie wprost do arkusza, bo pola takie jak Owner, Status, RAG czy Branża to zamknięte listy w formularzach.
- **Auto-zapis vs. edycja równoległa:** przy jednej-dwóch osobach aktualizujących dane naraz (typowe dla PMO) auto-zapis do współdzielonego pliku wystarcza. Jeśli kilka osób miałoby edytować dashboard **jednocześnie** na osobnych komputerach, ostatni zapis wygrywa (nadpisuje) — w takim wypadku trzeba albo ustalić okna edycji/1 osobę "na zmianę", albo rozważyć migrację do właściwej aplikacji (sekcja 5).
- **Spójność danych:** wyłącznie przez dropdowny (w Excelu: `Slowniki`; w dashboardzie: gotowe listy w formularzach) — nie wpisywać wartości ręcznie poza dashboardem.
- **Odświeżanie po zmianach zrobionych bezpośrednio w Excelu:** ręczne — użytkownik klika "Wczytaj / Połącz plik" i wskazuje plik ponownie; dashboard ostrzeże, jeśli lokalnie są niezsynchronizowane zmiany.

---

## 5. Ścieżka rozwoju (jeśli system się przyjmie)

1. **Dziś:** Excel (format danych/wymiany) + w pełni edytowalny dashboard HTML z auto-zapisem do pliku (Chrome/Edge) — ten pakiet.
2. **Docelowo:** migracja do istniejącego szkieletu aplikacji `InicjatywaP` (Next.js + Prisma + Postgres) — masz tam już moduły `projects`, `tickets`, `gantt`, `crm`, `finances`, `capacity` — struktura pól z tego Excela 1:1 mapuje się na przyszłe tabele bazodanowe, więc migracja danych będzie prostym importem. To naturalny następny krok, gdy potrzebna będzie **prawdziwa** współbieżna edycja wieloosobowa w czasie rzeczywistym, historia zmian per pole, uprawnienia per rola, albo integracje (np. z systemem księgowym).

---

## 6. Co dostarczono w tym pakiecie

- `baza_danych/Baza_Projektow.xlsx` — pełna baza (13 sheetów: Pulpit, Projekty, Karta_Projektu, Zespol, Przypisania, Harmonogram, Zadania_Tickety, Kamienie_milowe, Podwykonawcy, Przypisania_Podwykonawcow, Ryzyka_i_Problemy, Raporty_statusowe, Slowniki). `Projekty`/`Zespol`/`Przypisania` zawierają **realne dane zebrane z notatek zespołu** (21 projektów, 12 osób); pozostałe sheety są celowo puste (struktura + walidacja) do uzupełniania na bieżąco.
- `dashboard/index.html` (+ `app.js`, `style.css`, `vendor/xlsx.full.min.js`, `vendor/logo-icon.png`) — w pełni edytowalny dashboard offline (projekty, zespół, podwykonawcy, harmonogram, tickety), z auto-zapisem do połączonego pliku Excel w Chrome/Edge, wskaźnikami terminowości, powiadomieniami o opóźnieniach i wizualizacją marży/kosztów.
- `README.md` — instrukcja obsługi dla zespołu.
