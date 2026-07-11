# Wdrożenie na Render — instrukcja krok po kroku

Ten dokument zakłada, że zaczynasz od repo już wypchniętego na GitHub
(`https://github.com/AdamZajacAY/Inicjatywa_dashboard`) i że `Procfile`/`render.yaml` już tam są
(przygotowane w tej samej sesji, co ten dokument). To jest **podniesienie obecnego stosu
Flask + SQLite do chmury**, nie przepisanie na inną bazę — patrz `README.md`, sekcja „Ścieżka
rozwoju”, jeśli zastanawiasz się dlaczego nie Postgres już teraz.

## Zanim zaczniesz

- Potrzebujesz konta na [render.com](https://render.com) (może być logowanie przez GitHub).
- **Wymagany płatny plan instancji** — aplikacja trzyma dane w pliku SQLite, więc potrzebuje
  zamontowanego dysku trwałego („persistent disk”); darmowy tier Render ma ulotny system
  plików (dane znikałyby przy każdym redeployu/restarcie).
- Jeśli chcesz logowania Google na produkcji — możesz to zrobić teraz albo później (krok 7,
  opcjonalny, apka działa normalnie logowaniem hasłem bez tego).

## Krok 1 — Blueprint z repo

1. Zaloguj się na [dashboard.render.com](https://dashboard.render.com).
2. „New” → „Blueprint”.
3. Wskaż repo `AdamZajacAY/Inicjatywa_dashboard` (Render poprosi o dostęp do GitHuba przy
   pierwszym razie — autoryzuj).
4. Render odczyta `render.yaml` z repo i pokaże podgląd: usługę webową
   `inicjatywa-projektowa-dashboard`, dysk trwały `dashboard-data` (1 GB, zamontowany pod
   `/var/data`), zmienne środowiskowe (`SECRET_KEY` — wygeneruje sam; `DATABASE_PATH` i
   `BACKUPS_DIR` — już ustawione na ścieżki na dysku; `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/
   `GOOGLE_REDIRECT_URI` — puste, do uzupełnienia ręcznie, patrz krok 7).
5. Zatwierdź plan **płatny** dla usługi web (wymagany pod dysk trwały — patrz wyżej).
6. „Apply” / „Create”. Render zbuduje i uruchomi (`pip install -r requirements.txt`, potem
   `gunicorn server:app --bind 0.0.0.0:$PORT`) — pierwszy build zwykle kilka minut.

## Krok 2 — Pierwsze uruchomienie (pusta baza)

Świeży dysk nie ma jeszcze pliku bazy — `server.py` wykrywa to sam (`ensure_database_ready()`)
i inicjuje **pusty schemat** (wszystkie tabele, zero wierszy) zamiast się wywalić. To normalne
i oczekiwane — dane realne dogrywasz w kroku 4.

Sprawdź w logach usługi (zakładka „Logs” w panelu Render), że proces faktycznie wstał:
```
[INFO] Starting gunicorn ...
[INFO] Listening at: http://0.0.0.0:10000
```
Otwórz adres usługi (`https://inicjatywa-projektowa-dashboard.onrender.com` albo jak go Render
nazwał — widoczny na górze strony usługi) — zobaczysz ekran logowania. To potwierdza, że apka
żyje; zalogować się jeszcze nie ma jak, bo baza jest pusta (brak kont) — patrz krok 3.

## Krok 3 — Pierwsze konto (przez Shell w panelu Render)

1. W panelu usługi na Render znajdź zakładkę **„Shell”** (czasem podpisaną jako „Console” —
   dokładna nazwa/miejsce w interfejsie Render może się zmieniać, szukaj czegoś, co daje dostęp
   do terminala wewnątrz uruchomionego kontenera).
2. W tym terminalu uruchom:
   ```
   python3 baza_danych/create_admin.py
   ```
   Odpowie na pytania interaktywnie (e-mail, imię i nazwisko, hasło) — to tworzy pierwsze konto
   **Admin** na zdalnej instancji. Użyj tego samego adresu, którego chcesz używać docelowo
   (np. `adam@adviseyou.pl`) — to konto zostaje na stałe, nie jest tymczasowe.
3. Zaloguj się tym kontem na stronie usługi — powinieneś zobaczyć pusty dashboard (0 projektów).

## Krok 4 — Migracja realnych danych z komputera lokalnego

Masz już `21 projektów / 12 osób / 36 przypisań` (i cokolwiek dopiszesz później) lokalnie.
Zamiast ręcznie klikać to wszystko od nowa w przeglądarce, `baza_danych/migrate_to_remote.py`
robi to za Ciebie — **loguje się na zdalną instancję i tworzy wiersze przez to samo REST API,
którego i tak używa dashboard** (żadnego nowego, specjalnego mechanizmu — te same trasy
`/api/projekty`, `/api/zespol` itd., które są już przetestowane).

Z Twojego komputera (lokalnie, w katalogu repo):
```bash
# najpierw podglad, nic nie wysyla:
python3 baza_danych/migrate_to_remote.py --url https://twoj-adres.onrender.com \
    --email adam@adviseyou.pl --dry-run

# a potem naprawde:
python3 baza_danych/migrate_to_remote.py --url https://twoj-adres.onrender.com \
    --email adam@adviseyou.pl
```
(Hasło zapyta interaktywnie, jeśli nie podasz `--password`.)

Kilka rzeczy, które warto wiedzieć:
- **ID mogą wyjść inne niż lokalnie** (np. `JB-01` lokalnie → `PRJ004` zdalnie) — serwer sam
  nadaje ID nowym wierszom, tak samo jak przy zwykłym klikaniu „+ Nowy projekt” w dashboardzie.
  Skrypt pamięta mapowanie i poprawnie podstawia je w powiązanych tabelach (przypisania,
  harmonogram, tickety...) — tracisz tylko czytelność ID (`JB-01` → kto to Jan B), nie dane
  ani relacje.
- Tabela `users` (konta/hasła) jest celowo pomijana — nowe środowisko ma dostać własne, świeże
  konta (krok 3), nie kopię lokalnych haseł testowych.
- Skrypt tworzy wiersze (`POST`), nie nadpisuje istniejących — uruchomienie go drugi raz na tej
  samej instancji **zduplikuje dane**. Jednorazowa operacja na start; jeśli będziesz potrzebować
  tego regularnie (nie tylko raz na wdrożeniu), warto rozbudować skrypt o wykrywanie duplikatów.

Po migracji zaloguj się na produkcji i porównaj liczby (Przegląd portfela) z lokalną wersją.

## Krok 5 — Backupy na Render

Dwie niezależne warstwy — obie działają automatycznie, bez żadnej konfiguracji z Twojej strony:

**1. Backupy aplikacji (`baza_danych/backup_db.py`)** — działają identycznie jak lokalnie, tyle
że `BACKUPS_DIR` (ustawione w `render.yaml`) też wskazuje na dysk trwały (`/var/data/backups`),
więc kopie przetrwają redeploy tak samo jak sama baza. Retencja wiekowa: kopie młodsze niż 30 dni
są zachowywane, plus zawsze co najmniej 10 najnowszych niezależnie od wieku. Trzy wyzwalacze:
- automatycznie przy starcie usługi (każdy deploy/restart),
- ręcznie przyciskiem „Backup teraz” w zakładce Użytkownicy,
- albo przez Shell: `python3 baza_danych/backup_db.py`.

Te kopie są **zaufane jako podstawowe źródło przywracania** — powstają przez
`sqlite3.Connection.backup()` (oficjalne SQLite Online Backup API), bezpieczne nawet gdy baza jest
akurat używana.

**2. Automatyczne snapshoty dysku trwałego (funkcja Render, nie tej aplikacji)** — Render sam
robi snapshot całego dysku (`/var/data`, czyli baza + katalog backupów powyżej) raz na 24h,
przechowywany co najmniej 7 dni. Przywracanie: zakładka **Disks** usługi w panelu Render, wybór
snapshotu z listy — **uwaga, przywrócenie cofa też wszystkie zmiany na dysku od momentu
snapshotu**, więc traktuj to jako "ostatnia deska ratunku" (np. cała usługa/dysk zniknęły), nie
pierwszy wybór przy zwykłym "cofnij do wczoraj". Render sam zastrzega w swojej dokumentacji, że
snapshoty dysku nie są rekomendowane jako jedyny mechanizm odzyskiwania dla silników baz danych
(ryzyko złapania niespójnego stanu w trakcie zapisu) — jeśli kiedykolwiek przywrócisz snapshot,
sprawdź odzyskany plik (`sqlite3 baza_projektow.db "PRAGMA integrity_check;"`) zanim zaczniesz go
używać; jeśli masz z tego samego okresu kopię z warstwy 1 powyżej, ta jest pewniejsza.

**Kopia poza Render** — obie warstwy wyżej żyją na tym samym dysku `/var/data`, więc żadna z nich
nie chroni przed utratą samej usługi/konta Render. Dla realnych danych firmowych warto okresowo
ściągać kopię na zewnątrz: `python3 baza_danych/migrate_to_remote.py` w drugą stronę nie działa
(to narzędzie idzie tylko lokalne→zdalne). Render udostępnia natywną bramkę SSH (`scp`/`rsync`
z Twojego komputera) oraz `magic-wormhole` (zainstalowany domyślnie w zakładce Shell) — obie
metody potwierdzone jako dostępne dziś dla tego typu usługi (2026-07-10), choć w praktyce
nigdy nie zostały tu przetestowane — zanim uznasz to za działającą procedurę, wypróbuj ją raz
na spokojnie, nie dopiero w trakcie awarii.

### Odtwarzanie z backupu (disaster recovery) — kolejność ma znaczenie

**Świeży dysk na nowej instancji Render po cichu inicjuje pustą, w pełni działającą bazę
(Krok 2) — bez błędu, bez ostrzeżenia.** Jeśli w scenariuszu "usługa/dysk zniknęły, stawiam
od nowa" zalogujesz się i zaczniesz pracować przed wgraniem backupu, nic Cię nie ostrzeże, że
pracujesz na pustych danych zamiast przywróconych. Kolejność poniżej jest zaprojektowana tak,
żeby to wykluczyć:

1. Postaw nową usługę (Krok 1), poczekaj aż wstanie (Krok 2) — **ale jeszcze się nie loguj i
   nie zakładaj nowego konta admina**.
2. Zdobądź najnowszy zaufany backup: albo z kopii ściągniętej wcześniej poza Render (patrz
   wyżej), albo — jeśli tylko dysk jest uszkodzony, a sama usługa działa — bezpośrednio z
   `/var/data/backups` przez Shell tej samej (starej) instancji, zanim ją wyłączysz.
3. Przez Shell nowej instancji, wgraj plik backupu na miejsce `DATABASE_PATH`
   (`/var/data/baza_projektow.db`), **nadpisując** pustą bazę, którą utworzył Krok 2.
4. Zanim zrestartujesz usługę, zweryfikuj wgrany plik: `sqlite3 /var/data/baza_projektow.db
   "PRAGMA integrity_check;"` — wynik musi być dokładnie `ok`. Jeśli nie jest, **nie
   restartuj** — spróbuj innego backupu z listy w `/var/data/backups` (są posortowane
   chronologicznie w nazwie pliku).
5. Dopiero teraz zrestartuj usługę (Manual Deploy albo restart z panelu) i zaloguj się
   istniejącym już kontem (backup ma swoje własne konta w tabeli `users` — nowe konto z
   Kroku 3 zakładasz tylko wtedy, gdy backup faktycznie nie miał żadnego, np. przy zupełnie
   pierwszym wdrożeniu).
6. Zweryfikuj liczby (Krok 6 poniżej) — zobaczysz od razu prawdziwy stan portfela, nie pusty
   dashboard, jeśli przywracanie się powiodło.

## Krok 6 — Weryfikacja

- Zaloguj się na produkcji, sprawdź Przegląd (liczby projektów/zespołu), otwórz kilka kart
  projektów, sprawdź że przypisania/zespół się zgadzają.
- Zaloguj się jako inna rola (utwórz testowe konto w zakładce Użytkownicy), potwierdź że
  ograniczenia (ukryte finanse dla Specjalisty, zakres PM-a) działają tak samo jak lokalnie —
  logika jest identyczna, to ten sam kod `server.py`.
- Spróbuj złego hasła 5 razy, potwierdź blokadę (429) — rate-limit działa per-proces, a Render
  na płatnym planie z jednym workerem (domyślne `gunicorn` bez `--workers`) to jeden proces,
  więc zachowanie jest takie samo jak lokalnie.

## Krok 7 (opcjonalnie) — logowanie Google na produkcji

Jeśli chcesz przycisku „Zaloguj się przez Google” na Render (a nie tylko lokalnie):

1. W [Google Cloud Console](https://console.cloud.google.com/) → ten sam projekt OAuth co dla
   wersji lokalnej (albo nowy) → „Credentials” → Twój OAuth client → **dopisz** kolejny
   Authorized redirect URI: `https://twoj-adres.onrender.com/api/auth/google/callback`
   (obok tego dla `localhost`, jeśli nadal używasz apki lokalnie — Google pozwala na kilka
   zarejestrowanych redirect URI naraz).
2. W panelu Render → usługa → zakładka „Environment” → uzupełnij `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (ten ostatni: dokładnie adres z punktu 1) —
   `render.yaml` zostawił je puste celowo (`sync: false`), żeby nigdy nie trafiły do repo.
3. Zapisanie zmiennych środowiskowych wywoła redeploy usługi — po nim przycisk Google powinien
   się pojawić na ekranie logowania.

## Bieżąca praca po wdrożeniu

- Każdy `git push` na `main` (jeśli włączysz auto-deploy przy Blueprincie — domyślnie tak)
  albo ręczny „Manual Deploy” w panelu Render aktualizuje kod. **Baza na dysku trwałym
  przetrwa** redeploy (to cały sens dysku trwałego) — nie trzeba migrować danych ponownie.
- Nowe konta/role nadajesz tak samo jak lokalnie — zakładka Użytkownicy.
- Jeśli kiedyś zajdzie potrzeba dogrania świeższych danych z lokalnej pracy na produkcję,
  `migrate_to_remote.py` możesz uruchomić ponownie, ale pamiętaj o duplikacji (patrz krok 4) —
  na dziś to narzędzie do jednorazowego („cold start”) przeniesienia, nie do rutynowej
  synchronizacji w obie strony.
