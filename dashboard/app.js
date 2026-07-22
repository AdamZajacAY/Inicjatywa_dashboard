/* Inicjatywa Projektowa — Pulpit Projektów
 * Dashboard korzysta z backendu server.py (Flask + SQLite, patrz baza_danych/schema.sql
 * dla struktury) przez REST API pod /api/* — patrz apiGet/apiPost/apiPut/apiDelete.
 */

const STATE = {
  projects: [], team: [], assignments: [], tasks: [], milestones: [], risks: [], statusReports: [],
  subcontractors: [], subcontractorAssignments: [], tickets: [], users: [], backups: [], ideapool: [],
  clients: [], clientContacts: [], checklists: [], notifications: [], taskStages: [], parcels: [],
  labelConfig: [],
  projectById: new Map(), teamById: new Map(), subcontractorById: new Map(), clientById: new Map(),
  me: { role: null, personId: null, assignedProjectIds: [] },
};

// Lustrzane odbicie TABLE_SCOPE/can_write z server.py - jawnie tylko UX (ukrywanie przyciskow,
// ktorych klikniecie i tak skonczy sie 403 z backendu). Backend jest jedynym prawdziwym
// egzekwowaniem uprawnien i weryfikuje niezaleznie przy kazdym zapisie.
const TABLE_SCOPE = {
  projekty: "root_project", zespol: "global", podwykonawcy: "global",
  przypisania: "project_scoped", harmonogram: "project_scoped", zadania_tickety: "project_scoped",
  kamienie_milowe: "project_scoped", ryzyka_i_problemy: "project_scoped",
  raporty_statusowe: "project_scoped", przypisania_podwykonawcow: "project_scoped", users: "admin_only",
  ideapool: "global", klienci: "global", kontakty_klienta: "global",
  checklisty_projektow: "project_scoped",
};
const FULL_ACCESS_ROLES = ["COO", "Admin"];
// "Pracownik biurowy" ma dokladnie te same uprawnienia co "Architekt" (Specjalista) - mirror
// SPECJALISTA_ROLES w server.py, patrz komentarz tam.
const SPECJALISTA_ROLES = ["Specjalista", "Pracownik_biurowy"];
// Architekt_PM ma rowniez pola finansowe zredagowane na odczycie - mirror
// FINANCIAL_RESTRICTED_ROLES w server.py (SPECJALISTA_ROLES | {"Architekt_PM"}).
const FINANCIAL_RESTRICTED_ROLES = [...SPECJALISTA_ROLES, "Architekt_PM"];
// Faza 2 (A15): Architekt_PM dolaczony tutaj rowniez - odwraca wczesniejsza decyzje
// "portfolio-wide odczyt dla Architekt_PM", na wprost zyczenie zespolu (opoznienia/ryzyka
// innych projektow tez maja byc niewidoczne, nie tylko finanse). Mirror PORTFOLIO_RESTRICTED_
// ROLES w server.py - uzywane tu WYLACZNIE do etykiet/podpowiedzi UI ("Twoje projekty" itp.),
// bo faktyczne ograniczenie WIERSZY dzieje sie serwerowo (scoped_rows()) - STATE.projects/tasks
// itd. juz przychodzi zawezone z /api/bootstrap, bez potrzeby dodatkowego filtrowania w JS.
const PORTFOLIO_RESTRICTED_ROLES = [...SPECJALISTA_ROLES, "Architekt_PM"];

function can(action, table, row) {
  const role = STATE.me.role;
  if (FULL_ACCESS_ROLES.includes(role)) return true;
  if (table === "ideapool") {
    // "Kazdy moze zglosic pomysl" - musi zadzialac tez dla Specjalisty, wiec ta galaz stoi
    // PRZED rozgalezieniem na role, mirror can_write() w server.py.
    if (action === "create") return true;
    if (action === "delete") return false;
    return row && row.ID_Osoby_zglaszajacej === STATE.me.personId && row.Status === "Zgloszony";
  }
  const scope = TABLE_SCOPE[table];
  if (scope === "admin_only" || !scope) return false;
  if (SPECJALISTA_ROLES.includes(role)) {
    if (table !== "zadania_tickety" || action === "delete") return false;
    // brak row (np. przycisk na zbiorczej zakladce Zadania, bez wybranego projektu) - pokaz;
    // z konkretnym projektem w kontekscie (karta projektu) - tylko jesli to jeden z jej/jego projektow
    if (action === "create") return row ? STATE.me.assignedProjectIds.includes(row.ID_Projektu) : true;
    return row && row.ID_Osoby_przypisanej === STATE.me.personId && STATE.me.assignedProjectIds.includes(row.ID_Projektu);
  }
  if (role === "Architekt_PM") {
    if (table === "klienci" || table === "kontakty_klienta") return false;
    if (table === "zespol") return action === "create"; // dodanie nowej osoby - tak, edycja/usuniecie kolegow - nie (mirror can_write())
    if (table === "projekty" && action === "delete") return false;
    if (table === "podwykonawcy") return action !== "delete";
    if (table === "projekty" && action === "create") return true;
    return row ? STATE.me.assignedProjectIds.includes(row.ID_Projektu) : true;
  }
  return false; // rola jeszcze nie przypisana (Oczekujące) - nigdy nie powinno tu dotrzec
}

function applyRoleGating() {
  $all("[data-roles]").forEach(el => {
    el.style.display = el.dataset.roles.split(",").includes(STATE.me.role) ? "" : "none";
  });
}

const TYPE_COLORS = {
  "Projekt koncepcyjny": "cat-1",
  "Analiza urbanistyczna": "cat-7",
  "Projekt budowlany": "cat-2",
  "Projekt wykonawczy": "cat-5",
  "Nadzor autorski": "cat-8",
  "Konkurs": "cat-6",
  "Projekt techniczny (PT)": "cat-4",
  "Inne": "cat-3",
};
const TYPE_ORDER = Object.keys(TYPE_COLORS);
// Faza ma 13 wartosci - za duzo na 5-klasowy system badge() (good/warning/serious/critical/
// muted, uzywany dla Status/Priorytet/RAG), wiec mirror TYPE_COLORS/typeTag() zamiast tego:
// wlasna paleta z --cat-1..--cat-8, pokrewne etapy cyklu zycia projektu dzielace ten sam
// kolor (analiza/studium, etapy konkursu, projekt budowlany+techniczny) zamiast losowego
// przypisania, zeby grupowanie tez cos znaczylo, nie tylko rozroznialo.
const FAZA_COLORS = {
  "Analiza": "cat-1",
  "Projekt studialny": "cat-1",
  "Konkurs jednoetapowy": "cat-5",
  "Konkurs - etap I (studialny)": "cat-5",
  "Konkurs - etap II": "cat-5",
  "Koncepcja": "cat-2",
  "Projekt budowlany": "cat-3",
  "Projekt techniczny": "cat-3",
  "Przetarg": "cat-8",
  "Projekt wykonawczy": "cat-4",
  "Budowa": "cat-6",
  "Nadzor autorski": "cat-7",
  "Zakonczenie": "cat-4",
};
const STATUSES = ["Planowanie", "W realizacji", "Wstrzymany", "Przeglad", "Zakonczony", "Anulowany"];
// Kolejnosc = chronologia typowego projektu (uzyta 1:1 w <select>, patrz pairs()) - lustrzane
// odbicie ENUM_FIELDS["projekty"]["Faza"] w server.py, oba miejsca trzeba aktualizowac razem.
const FAZY = ["Analiza", "Projekt studialny", "Konkurs jednoetapowy", "Konkurs - etap I (studialny)",
  "Konkurs - etap II", "Koncepcja", "Projekt budowlany", "Projekt techniczny",
  "Przetarg", "Projekt wykonawczy", "Budowa", "Nadzor autorski", "Zakonczenie"];
const PRIORYTETY = ["Wysoki", "Sredni", "Niski"];
const DZIALY = ["Architekci", "Specjalisci", "Kierownictwo projektow", "PMO", "Prawny", "Finansowy", "Marketing/Sprzedaz", "Zarzad"];
const ROLE_W_PROJEKCIE = ["Sponsor", "Owner", "Kierownik projektu", "Czlonek zespolu", "Wsparcie/Konsultant"];
// Wstrzymany/Przeglad dopisane w Faza 1 - Status przenosi sie z projekty na sub-projekt (A9),
// wiec sub-projekt musi umiec reprezentowac te same stany co dawny projekty.Status (STATUSES).
const TASK_STATUSES = ["Nie rozpoczete", "W trakcie", "Wstrzymany", "Zakonczone", "Opoznione", "Przeglad", "Anulowany"];
// Typ_etapu/Segment/Funkcja_biura NIE sa juz statycznymi stalymi (Faza 2, A13) - edytowalny
// slownik w etykiety_konfiguracji, patrz labelPairsFor()/labelColor() nizej. Status/Priorytet/
// Faza swiadomie ZOSTAJA statyczne (patrz komentarz w schema.sql przy CREATE TABLE
// etykiety_konfiguracji - maja zaleznosci w innej logice, ktore swobodna edycja by zepsula).
const KATEGORIE_ZADAN = ["Koncepcja", "Konsultacje", "Projektowanie", "Rysunki wykonawcze",
  "Dokumentacja przetargowa", "Pozwolenia/Uzgodnienia", "Nadzor autorski", "Koordynacja branzowa",
  "Wizja lokalna/Spotkanie", "Prezentacja", "Administracja/Inne"];
const BRANZE_PODWYKONAWCOW = ["Elektryczna i teletechniczna", "Sanitarna", "Projekty przylaczy", "Technologia",
  "Konstrukcyjna", "Drogowa", "Zielen", "Akustyczna", "Architektoniczna", "Wizualizacje", "Inwentaryzacje",
  "Geodezyjna", "Geologiczna", "Kosztorysy",
  "Uzgodnienia ppoz", "Uzgodnienia hig-sanit", "Uzgodnienia BHP"];
const TYPY_WSPOLPRACY = ["Projektant branzowy", "Wykonawca robot", "Dostawca", "Konsultant"];
const OCENY_PODWYKONAWCOW = ["Wysoka", "Srednia", "Niska", "Brak oceny"];
const STATUSY_PODWYKONAWCOW = ["Aktywny", "Nieaktywny", "Zweryfikowany", "Czarna lista"];
const STATUSY_PRZYPISANIA_PODW = ["Planowany", "Aktywny", "Zakonczony", "Wstrzymany"];
const STATUSY_TICKIETOW = ["Backlog", "W tym tygodniu", "W trakcie", "Do przegladu", "Zrobione", "Zablokowane", "Zarchiwizowane"];
const TYP_RYZYKA = ["Ryzyko", "Problem"];
const KATEGORIE_RYZYK = ["Prawne", "Finansowe", "Techniczne", "Harmonogramowe", "Zasoby", "Srodowiskowe", "Proceduralne/Przetargowe"];
const STATUS_RYZYKA = ["Otwarte", "W trakcie", "Zamkniete"];
const STATUSY_KAMIENI_MILOWYCH = ["Nie rozpoczete", "W trakcie", "Zakonczone", "Zagrozone"];

const DATE_FIELDS = {
  projects: ["Data_rozpoczecia", "Data_zakonczenia_planowana", "Data_zakonczenia_rzeczywista", "Data_go_live", "Data_ostatniej_aktualizacji"],
  team: ["Data_dolaczenia"],
  assignments: ["Data_od", "Data_do"],
  tasks: ["Data_start_plan", "Data_koniec_plan", "Data_start_rzeczywista", "Data_koniec_rzeczywista"],
  milestones: ["Data_planowana", "Data_rzeczywista"],
  risks: ["Data_identyfikacji", "Data_zamkniecia"],
  statusReports: ["Data_raportu"],
  subcontractorAssignments: ["Data_od", "Data_do", "Data_zakonczenia_rzeczywista"],
  tickets: ["Data_utworzenia", "Termin", "Data_zakonczenia"],
  users: ["Data_utworzenia", "Data_ostatniego_logowania"],
  ideapool: ["Data_zgloszenia"],
};

/* ---------------------------------------------------------------- utils */
function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
function esc(s) { return (s ?? "").toString().replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function fmtDate(v) {
  const d = v instanceof Date ? v : null;
  if (!d) return "—";
  return d.toLocaleDateString("pl-PL", { year: "numeric", month: "2-digit", day: "2-digit" });
}
function fmtDateShort(v) {
  const d = v instanceof Date ? v : null;
  if (!d) return "—";
  return d.toLocaleDateString("pl-PL", { year: "2-digit", month: "short" });
}
function fmtDateTime(iso) {
  // Komentarze nie sa czescia STATE/bootstrap (pobierane na zadanie per ticket), wiec
  // Data_utworzenia przychodzi jako surowy string ISO, nie ozywiony wczesniej przez
  // reviveDates()/parseDateInput() (ktore i tak obcinaja czas, licza sie tylko z data).
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return "—";
  return d.toLocaleDateString("pl-PL", { year: "numeric", month: "2-digit", day: "2-digit" })
    + " " + d.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
}
function fmtMoney(n, currency) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  // esc() na currency TUTAJ, nie na kazdym call site - Waluta to wolny tekst (bez enuma/
  // walidacji), a wynik tej funkcji ladowal dotad prosto do innerHTML w ~12 miejscach bez
  // esc() (znalezione audytem) - jeden fix u zrodla zamiast pilnowania 12 call site'ow z osobna.
  return esc(Math.round(n).toLocaleString("pl-PL") + " " + (currency || "PLN"));
}
function fmtPctFraction(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return Math.round(n * 100) + "%";
}
// v === null (kolumna NULL w bazie) i v === "" (wyczyszczone pole formularza - FormData
// oddaje pusty string, nigdy null) obie licza sie jako "brak wartosci" - Number(null) i
// Number("") obie daja 0, nie NaN, wiec bez tego warunku domyslne `d` nigdy by sie nie
// zastosowalo w zadnym z tych dwoch przypadkow (np. wyczyszczone FTE cicho zapisywaloby
// sie jako 0% zamiast domyslnych 100%).
function num(v, d = 0) { const n = Number(v); return (v === null || v === "" || isNaN(n)) ? d : n; }
function pctOrDash(v) { return (v === null || v === undefined || v === "") ? "—" : v + "%"; }

function dateParts(d) {
  if (!(d instanceof Date) || isNaN(d)) return null;
  return { y: d.getFullYear(), m: String(d.getMonth() + 1).padStart(2, "0"), day: String(d.getDate()).padStart(2, "0") };
}
function dateInputVal(d) {
  const p = dateParts(d);
  return p ? `${p.y}-${p.m}-${p.day}` : "";
}
function dateDisplayVal(d) {
  const p = dateParts(d);
  return p ? `${p.day}.${p.m}.${p.y}` : "";
}
function parseDateInput(str) {
  if (!str) return null;
  if (str instanceof Date) return isNaN(str) ? null : str;
  let s = String(str).trim();
  if (s.includes(".")) {
    const [d, m, yRaw] = s.split(".").map(Number);
    if (!yRaw || !m || !d) return null;
    // new Date(y, ...) z 0<=y<=99 interpretuje rok jako 1900+y (np. 26 -> 1926) - legacy
    // zachowanie konstruktora Date. Rok 2-cyfrowy wpisany recznie ("1.3.26") ma dla
    // uzytkownika oczywiscie znaczyc 2026, nie 1926.
    const y = yRaw < 100 ? 2000 + yRaw : yRaw;
    return dateFromParts(y, m, d);
  }
  // Pelny znacznik czasu ISO z backendu (np. users.Data_ostatniego_logowania, ktore ma
  // timespec="seconds") -> sama data; "yyyy-mm-dd" ma dlugosc dokladnie 10, wiec dla
  // pol bez czasu to no-op.
  if (s.length > 10) s = s.slice(0, 10);
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return dateFromParts(y, m, d);
}
function dateFromParts(y, m, d) {
  // new Date(y, m-1, d) nigdy nie zwraca NaN dla nieprawidlowych skladowych - przepelnia je
  // zamiast odrzucic (np. new Date(2026, 3, 31) -> 1 maja, bo kwiecien ma 30 dni). Sprawdzenie
  // round-trip wylapuje to jako blad zamiast po cichu zapisac inna date, niz wpisal uzytkownik.
  const dt = new Date(y, m - 1, d);
  if (isNaN(dt) || dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}
function ragClass(rag) {
  if (rag === "Zielony") return "good";
  if (rag === "Zolty" || rag === "Żółty") return "warning";
  if (rag === "Czerwony") return "critical";
  return "muted";
}
function ragLabel(rag) {
  if (rag === "Zolty") return "Żółty";
  return rag || "—";
}
function priorityBadgeClass(priorytet) {
  if (priorytet === "Wysoki") return "critical";
  if (priorytet === "Niski") return "muted";
  if (priorytet === "Sredni") return "warning";
  return "muted"; // brak wartosci - szary, neutralny, sygnalizujacy "do wyboru", nie
  // faktyczny priorytet Sredni (dotad brak wartosci i "Sredni" dzielily ten sam kolor
  // warning/pomaranczowy, wygladalo jak realny priorytet, mimo ze nic nie wybrano)
}
function projectStatusClass(status) {
  // Wszystkie 6 wartosci STATUSES dostaja rozny kolor badge'a (good/warning/active/serious/
  // critical/muted) - dotad "W realizacji" i "Planowanie" byly nierozroznialne (oba "muted"), a
  // "Wstrzymany" dzielil kolor z "Anulowany" (oba "critical"), mimo ze to bardzo rozne stany.
  if (status === "W realizacji") return "good";
  if (status === "Wstrzymany") return "warning";
  if (status === "Przeglad") return "active";
  if (status === "Zakonczony") return "serious";
  if (status === "Anulowany") return "critical";
  return "muted"; // Planowanie i kazda inna/brak wartosci
}
function taskStatusClass(status) {
  switch (status) {
    case "Zakonczone": return "done";
    case "W trakcie": return "progress";
    case "Opoznione": return "delayed";
    default: return "notstarted";
  }
}
function riskStatusBadge(status) {
  if (status === "Otwarte") return "critical";
  if (status === "W trakcie") return "warning";
  if (status === "Zamkniete") return "good";
  return "muted";
}
function milestoneStatusBadge(status) {
  if (status === "Zakonczone") return "good";
  if (status === "Zagrozone") return "critical";
  if (status === "W trakcie") return "warning";
  return "muted";
}
function subStatusBadge(status) {
  if (status === "Aktywny" || status === "Zweryfikowany") return "good";
  if (status === "Czarna lista") return "critical";
  if (status === "Nieaktywny") return "warning";
  return "muted";
}
function subAssignmentStatusBadge(status) {
  if (status === "Aktywny") return "good";
  if (status === "Wstrzymany") return "critical";
  if (status === "Planowany") return "warning";
  return "muted";
}
// Termin planowany = Data_do (juz istnieje). Termin rzeczywisty ustawiany automatycznie przy
// zmianie Status na "Zakonczony" - ta sama zasada co deriveTicketCompletionDate() dla ticketow
// (patrz nizej), zeby mierzyc opoznienie podwykonawcy bez recznego wpisywania daty zakonczenia.
function deriveSubAssignmentCompletionDate(newStatus, currentDate) {
  return newStatus === "Zakonczony" ? (currentDate || new Date()) : null;
}
function subAssignmentDelayBadgeHtml(a) {
  if (!(a.Data_do instanceof Date) || !(a.Data_zakonczenia_rzeczywista instanceof Date)) return "";
  const days = Math.round((a.Data_zakonczenia_rzeczywista - a.Data_do) / 86400000);
  return days <= 0 ? badge("Zakończone na czas", "good") : badge(`Opóźnienie: ${days} dni`, "critical");
}
function badge(text, cls) {
  return `<span class="badge badge-${cls}"><span class="dot" style="background:currentColor"></span>${esc(text)}</span>`;
}
function typeTag(type) {
  // labelColor() pierwsze - Faza 2 (A13) Typ_etapu ma teraz kolor z edytowalnego slownika;
  // TYPE_COLORS zostaje jako fallback dla starych, sprzed-Fazy-1 wartosci Typ_projektu
  // (ktore nie maja juz zadnego wpisu w etykiety_konfiguracji, patrz projectPrimaryType()).
  const slot = labelColor("Typ_etapu", type) || TYPE_COLORS[type] || "cat-3";
  return `<span class="type-tag"><span class="dot" style="background:var(--${slot})"></span>${esc(type || "—")}</span>`;
}
function fazaTag(faza) {
  const slot = FAZA_COLORS[faza] || "cat-3";
  return `<span class="type-tag"><span class="dot" style="background:var(--${slot})"></span>${esc(faza || "—")}</span>`;
}
// Faza 1 (A2/A9): nowe projekty nie ustawiaja juz Typ_projektu wprost - "typ" to teraz zbior
// Typ_etapu jego sub-projektow (harmonogram). Dla jednego reprezentatywnego tagu na karcie/
// tabeli/kanbanie uzywamy pierwszego sub-projektu; projekty sprzed migracji bez zadnego
// sub-projektu (nie powinno sie zdarzac po migracji startowej, ale na wszelki wypadek) spadaja
// na stary Typ_projektu.
function projectPrimaryType(p) {
  const stages = tasksForProject(p.ID_Projektu);
  if (stages.length) return stages[0].Typ_etapu || stages[0].Nazwa_zadania;
  return p.Typ_projektu;
}
function initials(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?";
}
function personColorSlot(name) {
  // Prosty, deterministyczny hash (suma kodow znakow modulo liczba slotow kategorii) - ten
  // sam string zawsze daje ten sam kolor, bez potrzeby utrzymywania osobnej mapy/tabeli
  // przypisan kolor<->osoba. Reuzywa juz istniejaca, zwalidowana palete --cat-1..--cat-8
  // (rozroznialna dla CVD, patrz komentarz w style.css), zamiast wprowadzac nowa tylko pod
  // ten jeden cel.
  let h = 0;
  for (const ch of (name || "")) h = (h * 31 + ch.charCodeAt(0)) % 8;
  return `cat-${h + 1}`;
}
function avatarCircleHtml(name) {
  // Wspolny "wnetrze kolka" dla ownera/czlonka zespolu - prawdziwe zdjecie (Zdjecie_URL w
  // zespol), jesli osoba o tym Imie_i_nazwisko je ma, inaczej fallback na kolorowe inicjaly
  // (ta sama paleta co dotad - personColorSlot()). Owner na projektach to wolny tekst (nazwa),
  // nie FK, wiec dopasowanie po nazwisku - to samo ograniczenie co assigned_project_ids() w
  // server.py (patrz komentarz tam), tu bez wiekszych konsekwencji (czysto wizualne).
  const person = STATE.team.find(t => t.Imie_i_nazwisko === name);
  const slot = personColorSlot(name);
  if (person?.Zdjecie_URL) {
    return `<span class="avatar-circle has-photo"><img src="${esc(person.Zdjecie_URL)}" alt="${esc(name)}"></span>`;
  }
  return `<span class="avatar-circle" style="background:var(--${slot})">${esc(initials(name))}</span>`;
}
function ownerTagHtml(name) {
  if (!name) return "—";
  return `<span class="owner-tag">${avatarCircleHtml(name)}${esc(name)}</span>`;
}

/* ---------------------------------------------------------------- backend API (Flask + SQLite) */
async function apiRequest(method, path, body) {
  const headers = { "X-Requested-With": "fetch" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const resp = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    let message = `${method} ${path} -> ${resp.status}`;
    try { const err = await resp.json(); if (err.error) message = err.error; } catch (e) { /* brak JSON w odpowiedzi bledu */ }
    const httpError = new Error(message);
    httpError.status = resp.status;
    throw httpError;
  }
  if (resp.status === 204) return null;
  return resp.json();
}
const apiGet = (path) => apiRequest("GET", path);
const apiPost = (path, body) => apiRequest("POST", path, body);
const apiPut = (path, body) => apiRequest("PUT", path, body);
const apiDelete = (path) => apiRequest("DELETE", path);

function reviveDates(list, fields) {
  // parseDateInput (nie "new Date(str)") - stringi z API sa "yyyy-mm-dd", a "new Date('yyyy-mm-dd')"
  // jest wg specyfikacji parsowane jako polnoc UTC, nie polnoc czasu lokalnego, co przy ujemnej
  // strefie czasowej cofa dzien (np. "2026-07-09" -> 8 lipca lokalnie).
  (list || []).forEach(row => (fields || []).forEach(f => { if (row[f]) row[f] = parseDateInput(row[f]); }));
}
function serializeForApi(rec, dateFields) {
  const out = { ...rec };
  (dateFields || []).forEach(f => { if (out[f] instanceof Date) out[f] = dateInputVal(out[f]); });
  // "" z niewybranego <select> (np. opcjonalne ID_Osoby_wlasciciela) musi stac sie NULL, nie
  // pustym stringiem - inaczej narusza klucz obcy w SQLite ("" nie istnieje jako ID w tabeli).
  Object.keys(out).forEach(k => { if (out[k] === "") out[k] = null; });
  return out;
}
async function persistEntity({ isNew, endpoint, id, fields, dateFields, errorLabel }) {
  // Wspolny "ogon" wszystkich save*FromForm: serializacja + zapis przez API + ozywienie dat.
  // Walidacja, budowa "fields" i nawigacja po zapisie zostaja per-encja (naprawde sie roznia) -
  // ten wycinek byl identyczny we wszystkich 8 funkcjach, wiec latwo o rozjazd przy kolejnej zmianie.
  let saved;
  try {
    const payload = serializeForApi(fields, dateFields);
    saved = isNew ? await apiPost(endpoint, payload) : await apiPut(`${endpoint}/${id}`, payload);
  } catch (e) {
    alert(`Nie udało się zapisać (${errorLabel}): ` + e.message);
    return null;
  }
  reviveDates([saved], dateFields);
  return saved;
}
async function deleteEntity(endpoint, errorLabel) {
  // Wspolny "ogon" wszystkich delete*(): try/apiDelete/catch-alert byl identyczny w 9
  // funkcjach (ten sam rozjazd, ktory persistEntity() juz rozwiazal dla save*FromForm).
  try {
    await apiDelete(endpoint);
    return true;
  } catch (e) {
    alert(`Nie udało się usunąć (${errorLabel}): ` + e.message);
    return false;
  }
}
function requireExisting(rec, label) {
  if (rec) return true;
  // Rekord zniknal ze STATE (np. usuniety w innej karcie/przez inna osobe, skoro backend jest
  // teraz wspoldzielony) - bez tej checki Object.assign(undefined, ...) rzuca nieprzechwycony wyjatek.
  alert(`Ten ${label} nie istnieje już w bazie (mógł zostać usunięty w międzyczasie) — odśwież stronę.`);
  closeModal();
  return false;
}

function reindex() {
  STATE.projectById = new Map(STATE.projects.map(p => [p.ID_Projektu, p]));
  STATE.teamById = new Map(STATE.team.map(t => [t.ID_Osoby, t]));
  STATE.subcontractorById = new Map(STATE.subcontractors.map(s => [s.ID_Podwykonawcy, s]));
  STATE.clientById = new Map(STATE.clients.map(c => [c.ID_Klienta, c]));
}

// Etykiety wyswietlane uzytkownikowi - celowo inne niz wewnetrzne wartosci Rola w bazie
// (Specjalista/Architekt_PM), zeby nie ruszac danych/logiki uprawnien przy zmianie nazewnictwa.
const ROLE_LABELS = { Specjalista: "Architekt", Pracownik_biurowy: "Pracownik biurowy", Architekt_PM: "Architekt Prowadzący", COO: "COO", Admin: "Admin" };

function showDashboard() {
  $("#emptyState").style.display = "none";
  $("#tabs").style.display = "flex";
  $("#footerNote").style.display = "block";
  $("#btnPrint").style.display = "inline-block";
  $("#btnExport").style.display = "inline-block";
  $("#btnExecReport").style.display = "inline-block";
  $("#notifBellWrap").style.display = "block";
  $("#userMenu").style.display = "flex";
}

function updateFileInfo() {
  const label = PORTFOLIO_RESTRICTED_ROLES.includes(STATE.me.role) ? "Twoich projektów" : "projektów";
  $("#fileInfo").innerHTML = `🔗 Połączono z serwerem · ${STATE.projects.length} ${label}`;
}

function updateUserMenu() {
  $("#userMenuName").textContent = STATE.me.name || STATE.me.email || "";
  $("#userMenuRole").textContent = ROLE_LABELS[STATE.me.role] || STATE.me.role || "";
}

async function loadFromApi() {
  const data = await apiGet("/api/bootstrap");
  STATE.projects = data.projects || []; STATE.team = data.team || [];
  STATE.assignments = data.assignments || []; STATE.tasks = data.tasks || [];
  STATE.milestones = data.milestones || []; STATE.risks = data.risks || [];
  STATE.statusReports = data.statusReports || [];
  STATE.subcontractors = data.subcontractors || []; STATE.subcontractorAssignments = data.subcontractorAssignments || [];
  STATE.tickets = data.tickets || [];
  STATE.ideapool = data.ideapool || [];
  STATE.clients = data.clients || []; STATE.clientContacts = data.clientContacts || [];
  STATE.checklists = data.checklists || [];
  STATE.taskStages = data.taskStages || [];
  STATE.parcels = data.parcels || [];
  STATE.labelConfig = data.labelConfig || [];
  STATE.me = {
    role: data.me.role, personId: data.me.personId, name: data.me.name, email: data.me.email,
    assignedProjectIds: data.me.assignedProjectIds || [],
  };
  // users/backups nie wchodza w sklad /api/bootstrap (widoczne tylko dla COO/Admin, po co
  // ciagnac je przy kazdym logowaniu kazdej roli) - dociagane osobno, ale tylko raz tutaj,
  // tak zeby renderUsers() nizej mogl pozostac zwyklym synchronicznym render*() jak reszta.
  if (FULL_ACCESS_ROLES.includes(STATE.me.role)) {
    // Dwa niezalezne zapytania - rownolegle zamiast po kolei, oszczedza jeden pelny round-trip.
    [STATE.users, STATE.backups] = await Promise.all([apiGet("/api/users"), apiGet("/api/backup")]);
  }
  // Powiadomienia sa "moje wlasne" niezaleznie od roli (patrz /api/powiadomienia w server.py) -
  // bespoke endpoint, nie czesc /api/bootstrap, wiec osobne zapytanie tutaj dla kazdej roli.
  STATE.notifications = await apiGet("/api/powiadomienia");
  Object.keys(DATE_FIELDS).forEach(key => reviveDates(STATE[key], DATE_FIELDS[key]));
  reindex();
  showDashboard();
  updateFileInfo();
  updateUserMenu();
  renderAll();
  renderNotificationBell();
}

async function refreshNotifications() {
  STATE.notifications = await apiGet("/api/powiadomienia");
  renderNotificationBell();
}

function notificationText(n) {
  const preview = (n.Tresc || "").length > 90 ? n.Tresc.slice(0, 90) + "…" : n.Tresc;
  return renderCommentText(preview);
}

function notificationItemHtml(n) {
  const unread = n.Przeczytane !== "Tak";
  return `<button type="button" class="notif-item ${unread ? "unread" : ""}" data-notif-open="${esc(n.ID_Powiadomienia)}">
    <div class="notif-line"><span class="notif-author">${esc(n.Autor || "—")}</span> wspomniał(a) o Tobie</div>
    <div class="notif-line">${notificationText(n)}</div>
    <div class="notif-meta">${esc(fmtDateTime(n.Data_utworzenia))}</div>
  </button>`;
}

function renderNotificationPanel() {
  const panel = $("#notifPanel");
  if (!panel) return;
  const unreadCount = STATE.notifications.filter(n => n.Przeczytane !== "Tak").length;
  panel.innerHTML = `
    <div class="notif-panel-head">
      <h4>Powiadomienia</h4>
      ${unreadCount ? `<button type="button" class="notif-mark-all" data-notif-mark-all>Oznacz wszystkie jako przeczytane</button>` : ""}
    </div>
    ${STATE.notifications.length ? STATE.notifications.map(notificationItemHtml).join("") : `<div class="notif-empty">Brak powiadomień.</div>`}
  `;
}

function renderNotificationBell() {
  const wrap = $("#notifBellWrap");
  if (!wrap) return;
  const unreadCount = STATE.notifications.filter(n => n.Przeczytane !== "Tak").length;
  const badge = $("#notifBadge");
  badge.textContent = unreadCount > 9 ? "9+" : String(unreadCount);
  badge.style.display = unreadCount ? "flex" : "none";
  if ($("#notifPanel").classList.contains("open")) renderNotificationPanel();
}

function toggleNotificationPanel() {
  const panel = $("#notifPanel");
  const opening = !panel.classList.contains("open");
  panel.classList.toggle("open", opening);
  if (opening) renderNotificationPanel();
}

function closeNotificationPanel() {
  $("#notifPanel")?.classList.remove("open");
}

async function markAllNotificationsRead() {
  await apiPost("/api/powiadomienia/przeczytaj-wszystkie", {});
  STATE.notifications.forEach(n => { n.Przeczytane = "Tak"; });
  renderNotificationBell();
}

async function openNotification(id) {
  const n = STATE.notifications.find(x => x.ID_Powiadomienia === id);
  if (!n) return;
  if (n.Przeczytane !== "Tak") {
    n.Przeczytane = "Tak";
    renderNotificationBell();
    apiPost(`/api/powiadomienia/${id}/przeczytane`, {}).catch(() => {});
  }
  closeNotificationPanel();
  const ticket = STATE.tickets.find(t => t.ID_Tickietu === n.ID_Tickietu);
  if (ticket) {
    openTicketForm(ticket.ID_Projektu, ticket.ID_Tickietu);
    return;
  }
  // Specjalista ma portfolio zawezone do WLASNYCH projektow (scoped_rows() w server.py) -
  // ktos moze zostac oznaczony w komentarzu na projekcie, do ktorego jeszcze nie jest
  // przypisany (np. pytanie o opinie specjalisty spoza zespolu), wiec tego ticketu moze
  // po prostu nie byc w jego/jej STATE.tickets - bez tego klik po cichu nic by nie robil.
  alert("Nie masz dostępu do tego ticketu — poproś o dodanie do zespołu tego projektu.");
}

function showConnectionError(err) {
  console.error(err);
  $("#emptyState").innerHTML = `
    <h2>Nie udało się połączyć z serwerem</h2>
    <p>Upewnij się, że backend działa — uruchom <code>python3 server.py</code> w katalogu projektu
       i trzymaj go uruchomionego, a następnie odśwież tę stronę.</p>
    <p style="color:var(--text-muted);font-size:12px">${esc(err.message || String(err))}</p>`;
  $("#emptyState").style.display = "block";
}

function showLoginScreen(googleEnabled) {
  $("#emptyState").innerHTML = `
    <h2>Zaloguj się</h2>
    <form id="loginForm" style="max-width:320px;margin:20px auto;text-align:left;display:flex;flex-direction:column;gap:12px">
      <label class="f-label">E-mail<input type="email" id="loginEmail" required autocomplete="username"></label>
      <label class="f-label">Hasło<input type="password" id="loginPassword" required autocomplete="current-password"></label>
      <div id="loginError" style="color:var(--status-critical);font-size:12.5px;min-height:16px"></div>
      <button type="submit">Zaloguj się</button>
      ${googleEnabled ? `<button type="button" class="secondary" id="btnGoogleLogin">Zaloguj się przez Google</button>` : ""}
    </form>
  `;
  $("#emptyState").style.display = "block";
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#loginError").textContent = "";
    try {
      await apiPost("/api/auth/login", { email: $("#loginEmail").value, password: $("#loginPassword").value });
      await boot();
    } catch (err) {
      $("#loginError").textContent = err.message || "Nie udało się zalogować.";
    }
  });
  if (googleEnabled) {
    $("#btnGoogleLogin").addEventListener("click", () => { window.location.href = "/api/auth/google/login"; });
  }
}

function showPendingScreen(me) {
  $("#emptyState").innerHTML = `
    <h2>Konto oczekuje na zatwierdzenie</h2>
    <p>Zalogowano jako <b>${esc(me.email)}</b>, ale administrator jeszcze nie nadał Ci roli w systemie.
       Skontaktuj się z Adminem lub COO, żeby uzyskać dostęp.</p>
    <button class="secondary" id="btnPendingLogout">Wyloguj</button>
  `;
  $("#emptyState").style.display = "block";
  $("#btnPendingLogout").addEventListener("click", async () => { await apiPost("/api/auth/logout"); window.location.reload(); });
}

/* ---------------------------------------------------------------- eksport do Excela (recznie, migawka) */
const EXPORT_HEADERS = {
  Projekty: ["ID_Projektu", "Nazwa", "Sygnatura", "Symbol_projektu", "Nazwa_zamierzenia_budowlanego", "Typ_projektu", "Funkcja_biura", "Segment", "Owner", "Kierownik_projektu", "ID_Osoby_sponsora", "Status", "Faza",
    "Priorytet", "RAG_Status", "Tagi", "Data_rozpoczecia", "Data_zakonczenia_planowana", "Data_zakonczenia_rzeczywista",
    "Procent_postepu", "Budzet_calkowity", "Budzet_wydany", "Waluta", "Przychod_planowany", "Przychod_rzeczywisty",
    "Szacowane_roboczogodziny", "Stawka_godzinowa_srednia", "Lokalizacja_Adres", "Miasto", "Powierzchnia_m2",
    "Liczba_jednostek", "Inwestor_Klient", "Opis", "Link_do_dokumentacji", "Data_ostatniej_aktualizacji", "Komentarz"],
  Zespol: ["ID_Osoby", "Imie_i_nazwisko", "Stanowisko_Rola", "Dzial", "Email", "Telefon",
    "Dostepnosc_FTE_procent", "Stawka_godzinowa", "Data_dolaczenia", "Aktywny"],
  Przypisania: ["ID_Przypisania", "ID_Projektu", "ID_Osoby", "Rola_w_projekcie", "Procent_zaangazowania",
    "Data_od", "Data_do", "Status"],
  Harmonogram: ["ID_Zadania", "ID_Projektu", "Nazwa_zadania", "Kategoria", "ID_Osoby_odpowiedzialnej",
    "Data_start_plan", "Data_koniec_plan", "Data_start_rzeczywista", "Data_koniec_rzeczywista",
    "Procent_ukonczenia", "ID_Zadania_poprzedzajacego", "Kamien_milowy", "Status", "Priorytet", "Uwagi"],
  Zadania_Tickety: ["ID_Tickietu", "ID_Projektu", "ID_Etapu", "Tytul", "Opis", "ID_Osoby_przypisanej",
    "ID_Podwykonawcy", "Wycena_podwykonawcy",
    "Data_utworzenia", "Termin", "Szacowane_roboczogodziny", "Rzeczywiste_roboczogodziny",
    "Priorytet", "Status", "Data_zakonczenia"],
  Kamienie_milowe: ["ID_Kamienia", "ID_Projektu", "Nazwa_kamienia", "Data_planowana", "Data_rzeczywista",
    "Status", "ID_Osoby_odpowiedzialnej"],
  Ryzyka_i_Problemy: ["ID", "ID_Projektu", "Typ", "Opis", "Kategoria", "Prawdopodobienstwo", "Wplyw",
    "Priorytet", "ID_Osoby_wlasciciela", "Plan_mitygacji", "Status", "Data_identyfikacji", "Data_zamkniecia"],
  Raporty_statusowe: ["Data_raportu", "ID_Projektu", "RAG_Status", "Procent_postepu",
    "Budzet_wydany_skumulowany", "Kluczowe_osiagniecia", "Kluczowe_problemy", "Nastepne_kroki", "Autor_raportu"],
  Podwykonawcy: ["ID_Podwykonawcy", "Nazwa", "Branza", "Typ_wspolpracy", "Osoba_kontaktowa", "Email",
    "Telefon", "NIP", "Miasto", "Ocena", "Status", "Uwagi"],
  Przypisania_Podwykonawcow: ["ID_Przypisania_Podw", "ID_Projektu", "ID_Podwykonawcy", "Branza", "Zakres_prac",
    "Data_od", "Data_do", "Data_zakonczenia_rzeczywista", "Wartosc_umowy", "Waluta", "Status", "Uwagi"],
};

function buildWorkbook() {
  const wb = XLSX.utils.book_new();
  const map = {
    Projekty: STATE.projects, Zespol: STATE.team, Przypisania: STATE.assignments,
    Harmonogram: STATE.tasks, Zadania_Tickety: STATE.tickets, Kamienie_milowe: STATE.milestones,
    Ryzyka_i_Problemy: STATE.risks, Raporty_statusowe: STATE.statusReports, Podwykonawcy: STATE.subcontractors,
    Przypisania_Podwykonawcow: STATE.subcontractorAssignments,
  };
  Object.entries(map).forEach(([sheetName, rows]) => {
    const headers = EXPORT_HEADERS[sheetName];
    const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
    XLSX.utils.sheet_add_aoa(ws, [headers], { origin: "A1" });
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  });
  return wb;
}

function exportToExcel() {
  XLSX.writeFile(buildWorkbook(), "Baza_Projektow.xlsx");
}

/* ---------------------------------------------------------------- derived data helpers */
function assignmentsForProject(pid) { return STATE.assignments.filter(a => a.ID_Projektu === pid); }
function assignmentsForPerson(oid) { return STATE.assignments.filter(a => a.ID_Osoby === oid); }
function tasksForProject(pid) { return STATE.tasks.filter(t => t.ID_Projektu === pid); }
function milestonesForProject(pid) { return STATE.milestones.filter(m => m.ID_Projektu === pid); }
function checklistForProject(pid) { return STATE.checklists.filter(c => c.ID_Projektu === pid); }
function parcelsForProject(pid) { return STATE.parcels.filter(d => d.ID_Projektu === pid); }
// Faza 2 (A7): sklada pojedyncze pola lokalizacji urzedowej w jeden czytelny wiersz do wyswietlenia
// (formularz trzyma je jako osobne pola, ale w widoku detali jeden wiersz jest czytelniejszy).
function formatLokalizacjaUrzedowa(p) {
  const parts = [
    p.Ulica,
    [p.Kod_pocztowy, p.Miejscowosc].filter(Boolean).join(" "),
    p.Gmina ? `gm. ${p.Gmina}` : "",
    p.Powiat ? `pow. ${p.Powiat}` : "",
    p.Wojewodztwo ? `woj. ${p.Wojewodztwo}` : "",
    p.Kraj,
  ].filter(Boolean);
  return parts.join(", ");
}
function risksForProject(pid) { return STATE.risks.filter(r => r.ID_Projektu === pid); }
function reportsForProject(pid) {
  return STATE.statusReports.filter(r => r.ID_Projektu === pid)
    .sort((a, b) => (b.Data_raportu?.getTime() || 0) - (a.Data_raportu?.getTime() || 0));
}
function personName(oid) { return STATE.teamById.get(oid)?.Imie_i_nazwisko || oid || "—"; }
function projectName(pid) { return STATE.projectById.get(pid)?.Nazwa || pid || "—"; }
function subcontractorAssignmentsForProject(pid) { return STATE.subcontractorAssignments.filter(a => a.ID_Projektu === pid); }
function subcontractorAssignmentsForSubcontractor(sid) { return STATE.subcontractorAssignments.filter(a => a.ID_Podwykonawcy === sid); }
function subcontractorName(sid) { return STATE.subcontractorById.get(sid)?.Nazwa || sid || "—"; }
// Faza 1 (B5): zadania_etapy to n:n zadanie<->etap - mirror wzorca STATE.assignments (klient
// robi wlasny join zamiast trzymac zagniezdzona strukture w STATE.tickets/tasks).
function stageIdsForTicket(tid) { return STATE.taskStages.filter(e => e.ID_Tickietu === tid).map(e => e.ID_Zadania); }
function ticketIdsForStage(sid) { return STATE.taskStages.filter(e => e.ID_Zadania === sid).map(e => e.ID_Tickietu); }
function stageName(sid) { return STATE.tasks.find(t => t.ID_Zadania === sid)?.Nazwa_zadania || sid || "—"; }

/* ---------------------------------------------------------------- tickety, terminowosc, koszt realny, marza */
function ticketsForProject(pid) { return STATE.tickets.filter(t => t.ID_Projektu === pid); }
function ticketsForPerson(oid) { return STATE.tickets.filter(t => t.ID_Osoby_przypisanej === oid); }
function ticketsForSubcontractor(sid) { return STATE.tickets.filter(t => t.ID_Podwykonawcy === sid); }
function ticketAssigneeLabel(t) {
  if (t.ID_Podwykonawcy) return "🔧 " + subcontractorName(t.ID_Podwykonawcy);
  if (t.ID_Osoby_przypisanej) return personName(t.ID_Osoby_przypisanej);
  return "—";
}
function subcontractorTicketCostForProject(pid) {
  return ticketsForProject(pid).reduce((s, t) => s + (t.ID_Podwykonawcy ? num(t.Wycena_podwykonawcy) : 0), 0);
}
function subcontractorCostByProjectMap() {
  // Jedno przejscie po STATE.tickets zamiast N (jeden na kazdy projekt) przez
  // subcontractorTicketCostForProject() w petli - patrz uzycie w renderOverview/
  // buildExecutiveReportHtml, jedyne miejsca liczace to dla calego portfela naraz.
  const map = new Map();
  for (const t of STATE.tickets) {
    if (t.ID_Podwykonawcy) map.set(t.ID_Projektu, (map.get(t.ID_Projektu) || 0) + num(t.Wycena_podwykonawcy));
  }
  return map;
}
function subcontractorOnTimeStats(sid) {
  const tickets = ticketsForSubcontractor(sid);
  const done = tickets.filter(t => t.Status === "Zrobione" && t.Termin instanceof Date && t.Data_zakonczenia instanceof Date);
  const onTime = done.filter(t => t.Data_zakonczenia <= t.Termin);
  return {
    pct: done.length ? Math.round(onTime.length / done.length * 100) : null,
    doneTotal: done.length, onTimeTotal: onTime.length,
    overdue: tickets.filter(isOverdueTicket).length,
    total: tickets.length,
  };
}
function personRate(oid) { return num(STATE.teamById.get(oid)?.Stawka_godzinowa); }

function today0() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
const DONE_TICKET_STATUSES = ["Zrobione", "Zarchiwizowane"];
// Wspolna regula: wchodzac w status "done" ustaw date zakonczenia (jesli jeszcze jej nie ma),
// wychodzac z niego - wyczysc. Uzywane zarowno przy przeciaganiu w Kanbanie, jak i w formularzu.
function deriveTicketCompletionDate(newStatus, currentDate) {
  return DONE_TICKET_STATUSES.includes(newStatus) ? (currentDate || new Date()) : null;
}
function isOverdueTicket(t) {
  return t.Termin instanceof Date && t.Termin < today0() && !DONE_TICKET_STATUSES.includes(t.Status);
}
const NON_OVERDUE_STAGE_STATUSES = ["Zakonczone", "Wstrzymany", "Anulowany"];
function isOverdueStage(t) {
  // Wstrzymany/Anulowany dopisane w Faza 1 (Status przenosi sie z projekty na sub-projekt, A9) -
  // wstrzymany/anulowany etap swiadomie nie posuwa sie naprzod, wiec nie jest "opozniony"
  // w sensie wymagajacym uwagi, tak jak zwykly "W trakcie"/"Nie rozpoczete" po terminie.
  return t.Data_koniec_plan instanceof Date && t.Data_koniec_plan < today0() && !NON_OVERDUE_STAGE_STATUSES.includes(t.Status);
}
function ticketEffectiveStatus(t) { return isOverdueTicket(t) ? "Opoznione" : t.Status; }
function ticketStatusBadge(status) {
  if (status === "Zrobione") return "good";
  if (status === "Opoznione" || status === "Zablokowane") return "critical";
  if (status === "Do przegladu") return "serious";
  if (status === "W trakcie" || status === "W tym tygodniu") return "warning";
  return "muted"; // Backlog, Zarchiwizowane i kazda inna/brak wartosci
}
const KANBAN_KOLUMNY = ["Backlog", "W tym tygodniu", "W trakcie", "Do przegladu", "Zrobione", "Zablokowane", "Zarchiwizowane"];

function realCostForProject(pid) {
  return ticketsForProject(pid).reduce((s, t) => s + num(t.Rzeczywiste_roboczogodziny) * personRate(t.ID_Osoby_przypisanej), 0);
}
function realHoursForProject(pid) {
  return ticketsForProject(pid).reduce((s, t) => s + num(t.Rzeczywiste_roboczogodziny), 0);
}

function projectTags(p) {
  return (p.Tagi || "").split(",").map(s => s.trim()).filter(Boolean);
}
function allProjectTags() {
  return Array.from(new Set(STATE.projects.flatMap(projectTags))).sort();
}
function projectRevenue(p) {
  return num(p.Przychod_rzeczywisty) > 0 ? num(p.Przychod_rzeczywisty) : num(p.Przychod_planowany);
}
function projectRevenueIsActual(p) { return num(p.Przychod_rzeczywisty) > 0; }
function projectMargin(p, subCostOverride) {
  // subCostOverride: opcjonalna z gory policzona wartosc z subcontractorCostByProjectMap()
  // (patrz tam) dla wolajacych, ktorzy licza to dla calego portfela naraz - bez tego kazde
  // wywolanie w petli po projektach osobno skanowaloby cale STATE.tickets.
  const revenue = projectRevenue(p);
  const subCost = subCostOverride ?? subcontractorTicketCostForProject(p.ID_Projektu);
  const cost = num(p.Budzet_wydany) + subCost;
  if (!revenue) return null;
  const margin = revenue - cost;
  return { revenue, cost, subCost, margin, marginPct: margin / revenue * 100, markupPct: cost ? margin / cost * 100 : null };
}

/* ---------------------------------------------------------------- analityka finansowa i wydajnosciowa per projekt */
function estimatedTicketHoursForProject(pid) {
  return ticketsForProject(pid).reduce((s, t) => s + num(t.Szacowane_roboczogodziny), 0);
}
function projectExpectedProgress(p) {
  const start = p.Data_rozpoczecia, end = p.Data_zakonczenia_planowana;
  if (!(start instanceof Date) || !(end instanceof Date) || end <= start) return null;
  const now = today0();
  if (now <= start) return 0;
  if (now >= end) return 1;
  return (now - start) / (end - start);
}
function projectScheduleVariance(p) {
  const expected = projectExpectedProgress(p);
  if (expected == null) return null;
  return num(p.Procent_postepu) - expected;
}
function projectBudgetVariance(p) {
  const tot = num(p.Budzet_calkowity);
  if (!tot) return null;
  const spent = num(p.Budzet_wydany) + subcontractorTicketCostForProject(p.ID_Projektu);
  return num(p.Procent_postepu) - (spent / tot);
}
function varianceAccent(v) {
  if (v == null) return "";
  if (v >= -0.05) return "accent-good";
  if (v >= -0.20) return "accent-warning";
  return "accent-critical";
}
function computeOnTimeStats(tasks, tickets) {
  const doneStages = tasks.filter(t => t.Status === "Zakonczone" && t.Data_koniec_plan instanceof Date && t.Data_koniec_rzeczywista instanceof Date);
  const onTimeStages = doneStages.filter(t => t.Data_koniec_rzeczywista <= t.Data_koniec_plan);
  const doneTickets = tickets.filter(t => t.Status === "Zrobione" && t.Termin instanceof Date && t.Data_zakonczenia instanceof Date);
  const onTimeTickets = doneTickets.filter(t => t.Data_zakonczenia <= t.Termin);
  const doneTotal = doneStages.length + doneTickets.length;
  const onTimeTotal = onTimeStages.length + onTimeTickets.length;
  return {
    pct: doneTotal ? Math.round(onTimeTotal / doneTotal * 100) : null,
    doneTotal, onTimeTotal,
    overdueStages: tasks.filter(isOverdueStage).length,
    overdueTickets: tickets.filter(isOverdueTicket).length,
  };
}
function projectOnTimeStats(pid) {
  return computeOnTimeStats(tasksForProject(pid), ticketsForProject(pid));
}

/* ---------------------------------------------------------------- powiadomienia (opoznienia) */
function getNotifications() {
  const items = [];
  const in7 = new Date(); in7.setDate(in7.getDate() + 7);
  STATE.tickets.forEach(t => {
    if (isOverdueTicket(t)) {
      items.push({ sev: "critical", pid: t.ID_Projektu, text: `Ticket „${t.Tytul}” (${t.ID_Tickietu}) — ${ticketAssigneeLabel(t)} — termin minął ${fmtDate(t.Termin)}` });
    }
  });
  STATE.tasks.forEach(t => {
    if (isOverdueStage(t)) {
      items.push({ sev: "critical", pid: t.ID_Projektu, text: `Etap „${t.Nazwa_zadania}” (${projectName(t.ID_Projektu)}) — plan zakończenia minął ${fmtDate(t.Data_koniec_plan)}` });
    }
  });
  STATE.milestones.forEach(m => {
    if (m.Data_planowana instanceof Date && m.Data_planowana < today0() && m.Status !== "Zakonczone") {
      items.push({ sev: "critical", pid: m.ID_Projektu, text: `Kamień milowy „${m.Nazwa_kamienia}” (${projectName(m.ID_Projektu)}) — minął termin ${fmtDate(m.Data_planowana)}` });
    } else if (m.Data_planowana instanceof Date && m.Data_planowana >= today0() && m.Data_planowana <= in7 && m.Status !== "Zakonczone") {
      items.push({ sev: "warning", pid: m.ID_Projektu, text: `Kamień milowy „${m.Nazwa_kamienia}” (${projectName(m.ID_Projektu)}) — zbliża się termin ${fmtDate(m.Data_planowana)}` });
    }
  });
  STATE.projects.forEach(p => {
    if (p.RAG_Status === "Czerwony") items.push({ sev: "critical", pid: p.ID_Projektu, text: `Projekt „${p.Nazwa}” ma czerwony status RAG` });
  });
  const sevOrder = { critical: 0, warning: 1 };
  return items.sort((a, b) => sevOrder[a.sev] - sevOrder[b.sev]);
}

/* ---------------------------------------------------------------- wskazniki terminowosci */
function onTimeStats() {
  return computeOnTimeStats(STATE.tasks, STATE.tickets);
}

/* ================================================================== VIEW: PRZEGLAD */
function renderOverview() {
  const P = STATE.projects;
  const total = P.length;
  const byStatus = (s) => P.filter(p => p.Status === s).length;
  const byRag = (r) => P.filter(p => p.RAG_Status === r).length;
  const budTotal = P.reduce((s, p) => s + num(p.Budzet_calkowity), 0);
  const budSpent = P.reduce((s, p) => s + num(p.Budzet_wydany), 0);
  const openRisks = STATE.risks.filter(r => r.Status !== "Zamkniete").length;
  const ot = onTimeStats();
  const notifications = getNotifications();

  const today = new Date();
  const in90 = new Date(); in90.setDate(today.getDate() + 90);
  const upcomingMilestones = STATE.milestones
    .filter(m => m.Data_planowana instanceof Date && m.Data_planowana >= today && m.Data_planowana <= in90 && m.Status !== "Zakonczone")
    .sort((a, b) => a.Data_planowana - b.Data_planowana);

  const redProjects = P.filter(p => p.RAG_Status === "Czerwony");

  const byType = {};
  TYPE_ORDER.forEach(t => byType[t] = 0);
  P.forEach(p => { byType[p.Typ_projektu] = (byType[p.Typ_projektu] || 0) + 1; });
  const maxTypeCount = Math.max(1, ...Object.values(byType));

  const byPriority = {};
  PRIORYTETY.forEach(pr => byPriority[pr] = 0);
  P.forEach(p => { byPriority[p.Priorytet] = (byPriority[p.Priorytet] || 0) + 1; });
  const maxPriorityCount = Math.max(1, ...Object.values(byPriority));
  const priorityColor = { "Wysoki": "status-critical", "Sredni": "status-warning", "Niski": "status-good" };

  const ragCounts = { Zielony: byRag("Zielony"), Zolty: byRag("Zolty"), Czerwony: byRag("Czerwony") };
  const ragTotal = Math.max(1, ragCounts.Zielony + ragCounts.Zolty + ragCounts.Czerwony);

  const tagCounts = {};
  P.forEach(p => projectTags(p).forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxTagCount = Math.max(1, ...topTags.map(t => t[1]));

  const subCostMap = subcontractorCostByProjectMap();
  const marginRows = P.map(p => ({ p, m: projectMargin(p, subCostMap.get(p.ID_Projektu) || 0) })).filter(x => x.m).sort((a, b) => b.m.marginPct - a.m.marginPct);
  const maxAbsMarginPct = Math.max(1, ...marginRows.map(x => Math.abs(x.m.marginPct)));
  const portfolioRevenue = P.reduce((s, p) => s + projectRevenue(p), 0);
  const portfolioMargin = portfolioRevenue - budSpent;

  const html = `
    ${PORTFOLIO_RESTRICTED_ROLES.includes(STATE.me.role) ? `<div class="panel" style="margin-bottom:16px;padding:10px 16px"><div class="kpi-sub">${total === 0
        ? "Nie masz jeszcze przypisanych projektów — poniższy widok będzie pusty, dopóki COO/Admin nie przypisze Cię do projektu (przez „Zespół projektu” na karcie projektu) albo sam/a nie założysz nowego."
        : "Widoczne wyłącznie projekty, do których jesteś przypisany/a — poniższe liczby (i cały ten widok) dotyczą tylko ich, nie całej firmy."}</div></div>` : ""}
    <div class="kpi-grid">
      <div class="kpi-tile"><div class="kpi-label">${PORTFOLIO_RESTRICTED_ROLES.includes(STATE.me.role) ? "Twoje projekty" : "Projekty ogółem"}</div><div class="kpi-value">${total}</div></div>
      <div class="kpi-tile"><div class="kpi-label">W realizacji</div><div class="kpi-value">${byStatus("W realizacji")}</div></div>
      <div class="kpi-tile accent-critical"><div class="kpi-label">Wstrzymane</div><div class="kpi-value">${byStatus("Wstrzymany")}</div></div>
      <div class="kpi-tile accent-good"><div class="kpi-label">Zakończone</div><div class="kpi-value">${byStatus("Zakonczony")}</div></div>
      <div class="kpi-tile ${ot.pct == null ? "" : ot.pct >= 80 ? "accent-good" : "accent-warning"}"><div class="kpi-label">Terminowość</div><div class="kpi-value">${ot.pct == null ? "—" : ot.pct + "%"}</div><div class="kpi-sub">${ot.onTimeTotal}/${ot.doneTotal} zakończonych na czas</div></div>
      <div class="kpi-tile accent-critical"><div class="kpi-label">Opóźnione etapy/tickety</div><div class="kpi-value">${ot.overdueStages + ot.overdueTickets}</div></div>
      <div class="kpi-tile accent-critical"><div class="kpi-label">RAG czerwony</div><div class="kpi-value">${byRag("Czerwony")}</div></div>
      <div class="kpi-tile accent-critical"><div class="kpi-label">Otwarte ryzyka</div><div class="kpi-value">${openRisks}</div></div>
      <div class="kpi-tile ${portfolioMargin >= 0 ? "accent-good" : "accent-critical"}"><div class="kpi-label">Marża portfela</div><div class="kpi-value">${portfolioRevenue ? Math.round(portfolioMargin / portfolioRevenue * 100) + "%" : "—"}</div><div class="kpi-sub">${fmtMoney(portfolioMargin)}</div></div>
    </div>

    <div class="panel">
      <div class="section-head" style="margin-bottom:4px"><h3 style="margin:0">🔔 Powiadomienia (${notifications.length})</h3></div>
      ${notifications.length ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px">${notifications.slice(0, 12).map(n => `
        <div class="dp-list-item clickable" data-open-project="${esc(n.pid)}" style="cursor:pointer;margin:0">
          <div class="title" style="font-size:12.5px">${badge(n.sev === "critical" ? "Opóźnione" : "Zbliża się", n.sev)} ${esc(n.text)}</div>
        </div>`).join("")}</div>` : `<div class="kpi-sub">Brak alertów — wszystko na czas.</div>`}
    </div>

    <div class="two-col">
      <div class="panel">
        <h3>Budżet portfela</h3>
        <div class="hbar-row">
          <div class="hbar-label">Wydany / Całkowity</div>
          <div class="hbar-track"><div class="hbar-fill" style="width:${Math.min(100, budTotal ? budSpent / budTotal * 100 : 0)}%;background:var(--accent)"></div></div>
          <div class="hbar-value">${budTotal ? Math.round(budSpent / budTotal * 100) : 0}%</div>
        </div>
        <div class="kpi-sub" style="margin-top:6px">${fmtMoney(budSpent)} z ${fmtMoney(budTotal)} (${FINANCIAL_RESTRICTED_ROLES.includes(STATE.me.role) ? "dane finansowe ukryte dla tej roli" : "suma widocznych projektów, PLN"})</div>

        <h3 style="margin-top:20px">RAG portfela</h3>
        <div class="segmented-bar">
          ${ragCounts.Zielony ? `<div style="flex:${ragCounts.Zielony};background:var(--status-good)"></div>` : ""}
          ${ragCounts.Zolty ? `<div style="flex:${ragCounts.Zolty};background:var(--status-warning)"></div>` : ""}
          ${ragCounts.Czerwony ? `<div style="flex:${ragCounts.Czerwony};background:var(--status-critical)"></div>` : ""}
        </div>
        <div class="kpi-sub" style="margin-top:6px">Zielony ${ragCounts.Zielony} · Żółty ${ragCounts.Zolty} · Czerwony ${ragCounts.Czerwony} (z ${ragTotal})</div>

        <h3 style="margin-top:20px">Projekty wg priorytetu</h3>
        ${PRIORYTETY.map(pr => `
          <div class="hbar-row">
            <div class="hbar-label">${esc(pr)}</div>
            <div class="hbar-track"><div class="hbar-fill" style="width:${byPriority[pr] / maxPriorityCount * 100}%;background:var(--${priorityColor[pr]})"></div></div>
            <div class="hbar-value">${byPriority[pr]}</div>
          </div>`).join("")}

        <h3 style="margin-top:20px">Projekty wg typu</h3>
        ${TYPE_ORDER.map(t => `
          <div class="hbar-row">
            <div class="hbar-label">${esc(t)}</div>
            <div class="hbar-track"><div class="hbar-fill" style="width:${byType[t] / maxTypeCount * 100}%;background:var(--${TYPE_COLORS[t]})"></div></div>
            <div class="hbar-value">${byType[t]}</div>
          </div>`).join("")}

        ${topTags.length ? `<h3 style="margin-top:20px">Najczęstsze tagi</h3>
        ${topTags.map(([tag, count]) => `
          <div class="hbar-row">
            <div class="hbar-label">${esc(tag)}</div>
            <div class="hbar-track"><div class="hbar-fill" style="width:${count / maxTagCount * 100}%;background:var(--text-muted)"></div></div>
            <div class="hbar-value">${count}</div>
          </div>`).join("")}` : ""}
      </div>

      <div class="panel">
        <h3>Marża wg projektu (przychód vs. koszt)</h3>
        ${marginRows.length ? marginRows.map(({ p, m }) => `
          <div class="hbar-row clickable" data-open-project="${esc(p.ID_Projektu)}" style="cursor:pointer">
            <div class="hbar-label" title="${esc(p.Nazwa)}">${esc(p.Nazwa)}</div>
            <div class="hbar-track"><div class="hbar-fill" style="width:${Math.abs(m.marginPct) / maxAbsMarginPct * 100}%;background:var(${m.margin >= 0 ? "--status-good" : "--status-critical"})"></div></div>
            <div class="hbar-value" style="width:auto;white-space:nowrap">${Math.round(m.marginPct)}%</div>
          </div>`).join("") : `<div class="kpi-sub">Brak danych o przychodach — uzupełnij pole „Przychód” w projektach.</div>`}
        <div class="kpi-sub" style="margin-top:6px">Marża % liczona względem przychodu; mark-up % (na karcie projektu) względem kosztu.</div>

        <h3 style="margin-top:20px">Projekty wymagające uwagi (RAG czerwony)</h3>
        ${redProjects.length ? redProjects.map(p => `
          <div class="dp-list-item clickable" data-open-project="${esc(p.ID_Projektu)}" style="cursor:pointer">
            <div class="title">${esc(p.Nazwa)}</div>
            <div class="meta">${esc(p.Owner)} · ${esc(p.Status)} · ${fmtPctFraction(p.Procent_postepu)} postępu</div>
          </div>`).join("") : `<div class="kpi-sub">Brak — żaden projekt nie ma czerwonego statusu.</div>`}

        <h3 style="margin-top:20px">Nadchodzące kamienie milowe (90 dni)</h3>
        ${upcomingMilestones.length ? upcomingMilestones.map(m => `
          <div class="dp-list-item clickable" data-open-project="${esc(m.ID_Projektu)}" style="cursor:pointer">
            <div class="title">${esc(m.Nazwa_kamienia)}</div>
            <div class="meta">${esc(projectName(m.ID_Projektu))} · ${fmtDate(m.Data_planowana)} · ${esc(m.Status)}</div>
          </div>`).join("") : `<div class="kpi-sub">Brak kamieni milowych w najbliższych 90 dniach.</div>`}
      </div>
    </div>
  `;
  $("#view-przeglad").innerHTML = html;
}

/* ================================================================== VIEW: PROJEKTY */
let projectFilters = { typ: "", status: "", owner: "", rag: "", q: "", tag: "", terminOd: "", terminDo: "", sort: "priorytet", view: "cards" };
const PRIORITY_RANK = { "Wysoki": 0, "Sredni": 1, "Niski": 2 };

function renderProjectsFilters() {
  const owners = Array.from(new Set(STATE.projects.map(p => p.Owner).filter(Boolean))).sort();
  const statuses = Array.from(new Set(STATE.projects.map(p => p.Status).filter(Boolean)));
  const allTags = allProjectTags();
  return `
    <div class="filters">
      <input type="text" id="fProjQ" placeholder="Szukaj po nazwie…" value="${esc(projectFilters.q)}">
      <select id="fProjTyp"><option value="">Wszystkie typy</option>${TYPE_ORDER.map(t => `<option ${projectFilters.typ === t ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
      <select id="fProjStatus"><option value="">Wszystkie statusy</option>${statuses.map(s => `<option ${projectFilters.status === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
      <select id="fProjOwner"><option value="">Wszyscy ownerzy</option>${owners.map(o => `<option ${projectFilters.owner === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>
      <select id="fProjRag"><option value="">Wszystkie RAG</option>
        <option value="Zielony" ${projectFilters.rag === "Zielony" ? "selected" : ""}>Zielony</option>
        <option value="Zolty" ${projectFilters.rag === "Zolty" ? "selected" : ""}>Żółty</option>
        <option value="Czerwony" ${projectFilters.rag === "Czerwony" ? "selected" : ""}>Czerwony</option>
      </select>
      ${allTags.length ? `<select id="fProjTag"><option value="">Wszystkie tagi</option>${allTags.map(t => `<option ${projectFilters.tag === t ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>` : ""}
      <label style="display:flex;align-items:center;gap:4px;font-size:12.5px;color:var(--text-secondary)">Termin od
        <input type="date" id="fProjTerminOd" value="${esc(projectFilters.terminOd)}">
      </label>
      <label style="display:flex;align-items:center;gap:4px;font-size:12.5px;color:var(--text-secondary)">do
        <input type="date" id="fProjTerminDo" value="${esc(projectFilters.terminDo)}">
      </label>
      <select id="fProjSort">
        <option value="priorytet" ${projectFilters.sort === "priorytet" ? "selected" : ""}>Sortuj: priorytet</option>
        <option value="rag" ${projectFilters.sort === "rag" ? "selected" : ""}>Sortuj: RAG (najgorsze pierwsze)</option>
        <option value="termin" ${projectFilters.sort === "termin" ? "selected" : ""}>Sortuj: najbliższy termin</option>
        <option value="kategoria" ${projectFilters.sort === "kategoria" ? "selected" : ""}>Sortuj: kategoria</option>
        <option value="nazwa" ${projectFilters.sort === "nazwa" ? "selected" : ""}>Sortuj: nazwa A-Z</option>
      </select>
      <span class="count" id="fProjCount"></span>
    </div>`;
}

function filteredProjects() {
  const ragRank = { "Czerwony": 0, "Zolty": 1, "Zielony": 2 };
  const list = STATE.projects.filter(p => {
    if (projectFilters.typ && p.Typ_projektu !== projectFilters.typ) return false;
    if (projectFilters.status && p.Status !== projectFilters.status) return false;
    if (projectFilters.owner && p.Owner !== projectFilters.owner) return false;
    if (projectFilters.rag && p.RAG_Status !== projectFilters.rag) return false;
    if (projectFilters.tag && !projectTags(p).includes(projectFilters.tag)) return false;
    if (projectFilters.q && !(p.Nazwa || "").toLowerCase().includes(projectFilters.q.toLowerCase())) return false;
    const terminOd = parseDateInput(projectFilters.terminOd);
    if (terminOd && (!p.Data_zakonczenia_planowana || p.Data_zakonczenia_planowana < terminOd)) return false;
    const terminDo = parseDateInput(projectFilters.terminDo);
    if (terminDo && (!p.Data_zakonczenia_planowana || p.Data_zakonczenia_planowana > terminDo)) return false;
    return true;
  });
  const sort = projectFilters.sort;
  list.sort((a, b) => {
    if (sort === "rag") return (ragRank[a.RAG_Status] ?? 3) - (ragRank[b.RAG_Status] ?? 3);
    if (sort === "termin") return (a.Data_zakonczenia_planowana?.getTime() ?? Infinity) - (b.Data_zakonczenia_planowana?.getTime() ?? Infinity);
    if (sort === "kategoria") return (TYPE_ORDER.indexOf(a.Typ_projektu) + 1 || 99) - (TYPE_ORDER.indexOf(b.Typ_projektu) + 1 || 99);
    if (sort === "nazwa") return (a.Nazwa || "").localeCompare(b.Nazwa || "");
    return (PRIORITY_RANK[a.Priorytet] ?? 3) - (PRIORITY_RANK[b.Priorytet] ?? 3);
  });
  return list;
}

function projectCardHtml(p) {
  const spent = num(p.Budzet_wydany), tot = num(p.Budzet_calkowity);
  const budPct = tot ? Math.min(100, spent / tot * 100) : 0;
  const over = tot && spent > tot;
  const primaryType = projectPrimaryType(p);
  const slot = labelColor("Typ_etapu", primaryType) || TYPE_COLORS[primaryType] || "cat-3";
  return `
    <div class="project-card" style="border-left-color:var(--${slot})" data-open-project="${esc(p.ID_Projektu)}">
      <div class="pc-top">
        <div>
          <div class="pc-name">${esc(p.Nazwa)}</div>
          <div class="pc-meta">${typeTag(primaryType)} · ${esc(p.Miasto || "")}</div>
        </div>
        ${badge(ragLabel(p.RAG_Status), ragClass(p.RAG_Status))}
      </div>
      <div class="pc-row"><span>Owner</span><b>${ownerTagHtml(p.Owner)}</b></div>
      <div class="pc-row"><span>Kierownik projektu</span><b>${esc(p.Kierownik_projektu)}</b></div>
      ${p.ID_Osoby_sponsora ? `<div class="pc-row"><span>Sponsor</span><b>${esc(personName(p.ID_Osoby_sponsora))}</b></div>` : ""}
      <div class="pc-row"><span>Status</span><b>${esc(p.Status)}</b></div>
      <div class="pc-row"><span>Termin (plan)</span><b>${fmtDate(p.Data_zakonczenia_planowana)}</b></div>
      <div class="pc-row"><span>Postęp</span><b>${fmtPctFraction(p.Procent_postepu)}</b></div>
      <div class="progress-track"><div class="progress-fill" style="width:${num(p.Procent_postepu) * 100}%"></div></div>
      <div class="pc-row" style="margin-top:8px"><span>Budżet</span><b>${fmtMoney(p.Budzet_wydany, p.Waluta)} / ${fmtMoney(p.Budzet_calkowity, p.Waluta)}</b></div>
      <div class="progress-track"><div class="progress-fill ${over ? "over" : ""}" style="width:${budPct}%"></div></div>
      ${projectTags(p).length ? `<div class="tag-chips">${projectTags(p).map(t => `<span class="tag-chip">${esc(t)}</span>`).join("")}</div>` : ""}
    </div>`;
}

function renderProjectsTable(list) {
  const groups = new Map();
  list.forEach(p => {
    const key = p.Kierownik_projektu || "— bez kierownika projektu —";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  });
  const keys = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b, "pl"));
  return keys.map(key => {
    const rows = groups.get(key);
    return `
      <div class="table-group">
        <div class="table-group-head">${esc(key)}<span class="count-pill">${rows.length}</span></div>
        <div class="panel" style="overflow-x:auto">
          <table class="data-table">
            <thead><tr>
              <th>Nazwa</th><th>Owner</th><th>Typ</th><th>Status</th><th>Priorytet</th><th>RAG</th><th>Termin (plan)</th><th>Go Live</th><th>Postęp</th><th>Budżet</th>
            </tr></thead>
            <tbody>
              ${rows.map(p => `
                <tr class="clickable" data-open-project="${esc(p.ID_Projektu)}">
                  <td>${esc(p.Nazwa)}</td>
                  <td>${ownerTagHtml(p.Owner)}</td>
                  <td>${typeTag(projectPrimaryType(p))}</td>
                  <td>${badge(p.Status || "—", projectStatusClass(p.Status))}</td>
                  <td>${badge(p.Priorytet || "—", priorityBadgeClass(p.Priorytet))}</td>
                  <td>${badge(ragLabel(p.RAG_Status), ragClass(p.RAG_Status))}</td>
                  <td>${fmtDate(p.Data_zakonczenia_planowana)}</td>
                  <td>${fmtDate(p.Data_go_live)}</td>
                  <td>${fmtPctFraction(p.Procent_postepu)}</td>
                  <td>${fmtMoney(p.Budzet_wydany, p.Waluta)} / ${fmtMoney(p.Budzet_calkowity, p.Waluta)}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>`;
  }).join("");
}

function renderProjects() {
  const list = filteredProjects();
  const view = projectFilters.view || "cards";
  $("#view-projekty").innerHTML = `
    <div class="section-head">
      <h2>Projekty</h2>
      <div style="display:flex;align-items:center;gap:10px">
        <div class="view-toggle">
          <button type="button" class="view-toggle-btn ${view === "cards" ? "active" : ""}" data-proj-view="cards">Karty</button>
          <button type="button" class="view-toggle-btn ${view === "tabela" ? "active" : ""}" data-proj-view="tabela">Tabela wg architekta</button>
          <button type="button" class="view-toggle-btn ${view === "kanban" ? "active" : ""}" data-proj-view="kanban">Kanban</button>
        </div>
        ${can("create", "projekty") ? `<button data-add-project="1">+ Nowy projekt</button>` : ""}
      </div>
    </div>
    ${renderProjectsFilters()}
    ${(() => {
      const hint = can("create", "projekty")
        ? "Brak projektów spełniających kryteria — dostosuj filtry albo dodaj nowy projekt."
        : "Brak projektów spełniających kryteria — dostosuj filtry (widzisz tylko projekty, do których jesteś przypisany/a).";
      if (view === "tabela") return list.length ? renderProjectsTable(list) : `<div class="empty-hint">${hint}</div>`;
      if (view === "kanban") return renderProjectsKanban(list);
      return `<div class="card-grid">${list.map(projectCardHtml).join("") || `<div class="empty-hint">${hint}</div>`}</div>`;
    })()}
  `;
  $("#fProjCount").textContent = `${list.length} / ${STATE.projects.length} projektów`;
  $("#fProjQ").addEventListener("input", e => { projectFilters.q = e.target.value; renderProjects(); });
  $("#fProjTyp").addEventListener("change", e => { projectFilters.typ = e.target.value; renderProjects(); });
  $("#fProjStatus").addEventListener("change", e => { projectFilters.status = e.target.value; renderProjects(); });
  $("#fProjOwner").addEventListener("change", e => { projectFilters.owner = e.target.value; renderProjects(); });
  $("#fProjRag").addEventListener("change", e => { projectFilters.rag = e.target.value; renderProjects(); });
  $("#fProjTag")?.addEventListener("change", e => { projectFilters.tag = e.target.value; renderProjects(); });
  $("#fProjTerminOd").addEventListener("change", e => { projectFilters.terminOd = e.target.value; renderProjects(); });
  $("#fProjTerminDo").addEventListener("change", e => { projectFilters.terminDo = e.target.value; renderProjects(); });
  $("#fProjSort").addEventListener("change", e => { projectFilters.sort = e.target.value; renderProjects(); });
}

function projectKanbanCardHtml(p) {
  // Faza 1 (A9): Status jest teraz WYLICZANY z sub-projektow, nie przeciagany recznie - karta
  // wiec juz nie jest draggable (byla dawniej, patrz usunieta moveProjectToStatus/KANBAN_MOVE_
  // HANDLERS["project"] - zmiana statusu odbywa sie teraz przez edycje sub-projektow).
  return `
    <div class="kanban-card" data-open-project="${esc(p.ID_Projektu)}">
      <div class="kc-title">${esc(p.Nazwa)}</div>
      <div class="kc-meta">${typeTag(projectPrimaryType(p))} · ${esc(p.Kierownik_projektu || "—")}</div>
      <div class="kc-meta">Owner: ${ownerTagHtml(p.Owner)}</div>
      <div class="kc-meta">Termin: ${fmtDate(p.Data_zakonczenia_planowana)} · ${fmtPctFraction(p.Procent_postepu)}</div>
      ${p.Data_go_live instanceof Date ? `<div class="kc-meta">Go Live: ${fmtDate(p.Data_go_live)}</div>` : ""}
      <div class="kc-foot">
        ${badge(ragLabel(p.RAG_Status), ragClass(p.RAG_Status))}
        ${badge(p.Priorytet || "—", priorityBadgeClass(p.Priorytet))}
      </div>
    </div>`;
}

function renderProjectsKanban(list) {
  return `<div class="kanban-board">${STATUSES.map(status => {
    const items = list.filter(p => p.Status === status);
    return `
      <div class="kanban-col" data-drop-status="${esc(status)}">
        <div class="kanban-col-head">${esc(status)}<span class="count-pill">${items.length}</span></div>
        <div class="kanban-col-body">
          ${items.map(projectKanbanCardHtml).join("") || `<div class="kanban-empty">Brak projektów</div>`}
        </div>
      </div>`;
  }).join("")}</div>`;
}

/* ================================================================== VIEW: ZESPOL */

const HOURS_PER_DAY = 8; // zalozenie: pelny etat (100% FTE) = 8h dziennie - nominalny dobowy wymiar czasu pracy (Art. 129 KP)
// Art. 134 KP: przy dniowce >=6h pracownikowi przysluguje co najmniej 15-minutowa przerwa,
// wliczana do czasu pracy (placona, ale nieproduktywna) - obowiazkowa dla kazdego etatowego
// pracownika biurowego. Art. 141 KP: pracodawca MOZE dodatkowo wprowadzic jedna przerwe na
// posilek do 60 minut, NIEWLICZANA do czasu pracy (bezplatna) - powszechna praktyka w biurach,
// przyjeto typowe 30 minut (brak w danych zrodlowych informacji o konkretnej polityce firmy,
// wiec to swiadome zalozenie, nie odczyt z bazy). Obie przerwy razem redukuja liczbe godzin
// realnie dostepnych pod przydzial zadan projektowych - stad PRODUCTIVE_HOURS_PER_DAY ponizej,
// osobno od HOURS_PER_DAY (ktory zostaje "czym jest pelny etat" bez zmian).
const BREAK_MINUTES_PER_DAY = 15;
const LUNCH_MINUTES_PER_DAY = 30;
const PRODUCTIVE_HOURS_PER_DAY = HOURS_PER_DAY - (BREAK_MINUTES_PER_DAY + LUNCH_MINUTES_PER_DAY) / 60;

const _workingDaysCache = new Map();
function workingDaysInMonth(year, month) {
  // Liczy dni pon-pt w danym miesiacu (month: 0-11). Bez kalendarza swiat - swieta ruchome
  // rok do roku, a utrzymanie takiej listy to osobny koszt nadal niewspolmierny do tego, co
  // dzisiejszy model (suma % zaangazowania) i tak juz upraszcza. Swiadome uproszczenie -
  // dlatego liczba dni robionych jest pokazana wprost w UI, nie ukryta w jednej liczbie godzin.
  // Memoizowane po (rok, miesiac) - renderTeam() woła to raz na osobe, zawsze z tym samym
  // "dzis", wiec bez cache to ten sam 28-31-krotny liczacy loop powtarzany na kazdy wiersz.
  const key = year * 12 + month;
  if (_workingDaysCache.has(key)) return _workingDaysCache.get(key);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const day = new Date(year, month, d).getDay();
    if (day !== 0 && day !== 6) count++;
  }
  _workingDaysCache.set(key, count);
  return count;
}

// Obciazenie liczone z zadan (ticketow) i ich roboczogodzin, nie z % zaangazowania w
// przypisaniach projektowych (decyzja uzytkownika - poprzedni model % byl przyblizeniem
// "ile procent czasu ktos jest przypisany do projektu", nie realna praca do wykonania).
// harmonogram/etapy nie maja w ogole pola z godzinami - jedynym zrodlem godzin sa
// zadania_tickety.Szacowane_roboczogodziny. Ticket ma tylko jeden termin (Termin), nie zakres
// dat, wiec cala jego szacowana liczba godzin trafia w calosci do miesiaca terminu - swiadome
// uproszczenie zamiast proracji godzin na dni miedzy utworzeniem a terminem.
function taskHoursForPersonInMonth(oid, refDate) {
  return STATE.tickets
    .filter(t => t.ID_Osoby_przypisanej === oid && t.Termin instanceof Date
      && t.Termin.getFullYear() === refDate.getFullYear() && t.Termin.getMonth() === refDate.getMonth())
    .reduce((s, t) => s + num(t.Szacowane_roboczogodziny), 0);
}
function workloadHoursInfo(person, refDate = new Date()) {
  const fte = num(person.Dostepnosc_FTE_procent, 100) / 100;
  const workDays = workingDaysInMonth(refDate.getFullYear(), refDate.getMonth());
  const capacityHours = workDays * PRODUCTIVE_HOURS_PER_DAY * fte;
  const assignedHours = taskHoursForPersonInMonth(person.ID_Osoby, refDate);
  return {
    workDays,
    capacityHours,
    assignedHours,
    dailyCapacityHours: PRODUCTIVE_HOURS_PER_DAY * fte,
    percent: capacityHours ? Math.round((assignedHours / capacityHours) * 100) : 0,
  };
}

let teamFilters = { view: "cards" };

function teamCardHtml(person) {
  // Lista przypisan do projektow zostaje jako informacja kontekstowa (do jakich projektow
  // ktos nalezy), ale nie jest juz zrodlem liczby obciazenia - patrz workloadHoursInfo().
  const myAssignments = assignmentsForPerson(person.ID_Osoby).filter(a => a.Status === "Aktywny");
  const fte = num(person.Dostepnosc_FTE_procent, 100);
  const hrs = workloadHoursInfo(person);
  const cls = hrs.percent > 100 ? "over" : hrs.percent >= 90 ? "warn" : "";
  return `
    <div class="team-card" data-open-person="${esc(person.ID_Osoby)}">
      <div class="tc-name">${esc(person.Imie_i_nazwisko)}</div>
      <div class="tc-role">${esc(person.Stanowisko_Rola)} · ${esc(person.Dzial)}</div>
      <div class="pc-row"><span>Obciążenie</span><b>${hrs.percent}% / ${fte}%</b></div>
      <div class="workload-track"><div class="workload-fill ${cls}" style="width:${Math.min(150, hrs.percent) / 1.5}%"></div></div>
      <div class="tc-hours">${hrs.assignedHours.toFixed(0)}h / ${hrs.capacityHours.toFixed(0)}h w tym miesiącu · ${hrs.workDays} dni rob. × ${hrs.dailyCapacityHours.toFixed(2)}h/dzień (${HOURS_PER_DAY}h − ${BREAK_MINUTES_PER_DAY + LUNCH_MINUTES_PER_DAY} min przerw/lunch)</div>
      <div class="tc-projects">
        ${myAssignments.map(a => `<div>• ${esc(projectName(a.ID_Projektu))} — ${esc(a.Rola_w_projekcie)} (${pctOrDash(a.Procent_zaangazowania)})</div>`).join("") || "<div>Brak aktywnych przypisań.</div>"}
      </div>
    </div>`;
}

function renderTeamTable(list) {
  const groups = new Map();
  list.forEach(person => {
    const key = person.Dzial || "— bez działu —";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(person);
  });
  const keys = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b, "pl"));
  return keys.map(key => {
    const rows = groups.get(key);
    return `
      <div class="table-group">
        <div class="table-group-head">${esc(key)}<span class="count-pill">${rows.length}</span></div>
        <div class="panel" style="overflow-x:auto">
          <table class="data-table">
            <thead><tr>
              <th>Imię i nazwisko</th><th>Rola</th><th>Obciążenie</th><th class="num">Godziny (przyp. / pojemność)</th><th class="num">FTE</th><th>Email</th>
            </tr></thead>
            <tbody>
              ${rows.map(person => {
                const fte = num(person.Dostepnosc_FTE_procent, 100);
                const hrs = workloadHoursInfo(person);
                return `
                <tr class="clickable" data-open-person="${esc(person.ID_Osoby)}">
                  <td>${esc(person.Imie_i_nazwisko)}</td>
                  <td>${esc(person.Stanowisko_Rola || "—")}</td>
                  <td>${badge(hrs.percent + "%", hrs.percent > 100 ? "critical" : hrs.percent >= 90 ? "warning" : "good")}</td>
                  <td class="num">${hrs.assignedHours.toFixed(0)}h / ${hrs.capacityHours.toFixed(0)}h</td>
                  <td class="num">${fte}%</td>
                  <td>${esc(person.Email || "—")}</td>
                </tr>`; }).join("")}
            </tbody>
          </table>
        </div>
      </div>`;
  }).join("");
}

function renderTeam() {
  const view = teamFilters.view || "cards";
  const body = view === "tabela"
    ? renderTeamTable(STATE.team) || `<div class="empty-hint">Brak osób w zespole — kliknij „+ Dodaj osobę”.</div>`
    : `<div class="team-grid">${STATE.team.map(teamCardHtml).join("") || `<div class="empty-hint">Brak osób w zespole — kliknij „+ Dodaj osobę”.</div>`}</div>`;
  $("#view-zespol").innerHTML = `
    <div class="section-head">
      <h2>Zespół</h2>
      <div style="display:flex;align-items:center;gap:10px">
        <div class="view-toggle">
          <button type="button" class="view-toggle-btn ${view === "cards" ? "active" : ""}" data-team-view="cards">Karty</button>
          <button type="button" class="view-toggle-btn ${view === "tabela" ? "active" : ""}" data-team-view="tabela">Tabela wg działu</button>
        </div>
        ${can("create", "zespol") ? `<button data-add-team="1">+ Dodaj osobę</button>` : ""}
      </div>
    </div>
    ${PORTFOLIO_RESTRICTED_ROLES.includes(STATE.me.role) ? `<div class="empty-hint" style="margin-bottom:12px">Obciążenie i lista projektów uwzględniają tylko projekty, do których i Ty jesteś przypisany/a — mogą nie odzwierciedlać pełnego obciążenia danej osoby.</div>` : ""}
    ${body}
  `;
}

/* ================================================================== VIEW: PODWYKONAWCY (biblioteka) */
let subFilters = { branza: "", status: "" };

function renderSubcontractors() {
  const list = STATE.subcontractors.filter(s => {
    if (subFilters.branza && s.Branza !== subFilters.branza) return false;
    if (subFilters.status && s.Status !== subFilters.status) return false;
    return true;
  });
  const cards = list.map(s => {
    const assigns = subcontractorAssignmentsForSubcontractor(s.ID_Podwykonawcy);
    const active = assigns.filter(a => a.Status === "Aktywny" || a.Status === "Planowany");
    return `
      <div class="team-card" data-open-subcontractor="${esc(s.ID_Podwykonawcy)}">
        <div class="tc-name">${esc(s.Nazwa)}</div>
        <div class="tc-role">${esc(s.Branza)} · ${esc(s.Typ_wspolpracy)}</div>
        <div style="margin:6px 0">${badge(s.Status, subStatusBadge(s.Status))} ${badge("Ocena: " + (s.Ocena || "brak"), "muted")}</div>
        <div class="pc-row"><span>Kontakt</span><b>${esc(s.Osoba_kontaktowa || "—")}</b></div>
        <div class="pc-row"><span>Miasto</span><b>${esc(s.Miasto || "—")}</b></div>
        <div class="tc-projects">
          <div style="font-weight:600;color:var(--text-primary);margin-bottom:2px">Projekty (${active.length} aktywne/planowane)</div>
          ${active.map(a => `<div>• ${esc(projectName(a.ID_Projektu))} — ${esc(a.Zakres_prac)}</div>`).join("") || "<div>Brak bieżących przypisań.</div>"}
        </div>
      </div>`;
  });
  const branze = Array.from(new Set(STATE.subcontractors.map(s => s.Branza).filter(Boolean)));
  $("#view-podwykonawcy").innerHTML = `
    <div class="section-head"><h2>Podwykonawcy (biblioteka branżystów)</h2>${can("create", "podwykonawcy") ? `<button data-add-subcontractor="1">+ Dodaj podwykonawcę</button>` : ""}</div>
    <div class="filters">
      <select id="fSubBranza"><option value="">Wszystkie branże</option>${branze.map(b => `<option ${subFilters.branza === b ? "selected" : ""}>${esc(b)}</option>`).join("")}</select>
      <select id="fSubStatus"><option value="">Wszystkie statusy</option>${STATUSY_PODWYKONAWCOW.map(s => `<option ${subFilters.status === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
      <span class="count">${list.length} / ${STATE.subcontractors.length} podwykonawców</span>
    </div>
    ${PORTFOLIO_RESTRICTED_ROLES.includes(STATE.me.role) ? `<div class="empty-hint" style="margin-bottom:12px">Liczba aktywnych/planowanych projektów uwzględnia tylko projekty, do których i Ty jesteś przypisany/a.</div>` : ""}
    <div class="team-grid">${cards.join("") || `<div class="empty-hint">Brak podwykonawców w bibliotece — kliknij „+ Dodaj podwykonawcę”.</div>`}</div>
  `;
  $("#fSubBranza").addEventListener("change", e => { subFilters.branza = e.target.value; renderSubcontractors(); });
  $("#fSubStatus").addEventListener("change", e => { subFilters.status = e.target.value; renderSubcontractors(); });
}

/* ================================================================== VIEW: ZADANIA (tickety) */
let ticketFilters = { projekt: "", osoba: "", statuses: [], onlyOverdue: false, view: "kanban" };

function ticketCardHtml(t) {
  const overdue = isOverdueTicket(t);
  const isSub = !!t.ID_Podwykonawcy;
  const editable = can("update", "zadania_tickety", t);
  return `
    <div class="kanban-card ${isSub ? "subcontractor" : ""} ${overdue ? "overdue" : ""}" draggable="${editable}" data-drag-kind="ticket" data-drag-id="${esc(t.ID_Tickietu)}" ${editable ? `data-open-ticket="${esc(t.ID_Tickietu)}"` : ""}>
      <div class="kc-title">${esc(t.Tytul)}</div>
      <div class="kc-meta">${esc(projectName(t.ID_Projektu))}</div>
      <div class="kc-meta">${esc(ticketAssigneeLabel(t))} · ${fmtDate(t.Termin)}</div>
      ${t.ID_Osoby_zglaszajacej ? `<div class="kc-meta">zgłosił: ${esc(personName(t.ID_Osoby_zglaszajacej))}</div>` : ""}
      <div class="kc-foot">
        ${isSub ? badge("Podwykonawca", "sub") : ""}
        ${badge(t.Priorytet || "—", t.Priorytet === "Wysoki" ? "critical" : t.Priorytet === "Niski" ? "muted" : "warning")}
        ${overdue ? badge("Opoznione", "critical") : ""}
      </div>
    </div>`;
}

function renderTicketsKanban(list) {
  return `<div class="kanban-board">${KANBAN_KOLUMNY.map(status => {
    const items = list.filter(t => t.Status === status);
    return `
      <div class="kanban-col" data-drop-status="${esc(status)}">
        <div class="kanban-col-head">${esc(status)}<span class="count-pill">${items.length}</span></div>
        <div class="kanban-col-body">
          ${items.map(ticketCardHtml).join("") || `<div class="kanban-empty">Brak zadań</div>`}
        </div>
      </div>`;
  }).join("")}</div>`;
}

function renderTickets() {
  const list = STATE.tickets.filter(t => {
    if (ticketFilters.projekt && t.ID_Projektu !== ticketFilters.projekt) return false;
    if (ticketFilters.osoba && t.ID_Osoby_przypisanej !== ticketFilters.osoba) return false;
    if (ticketFilters.statuses.length && !ticketFilters.statuses.includes(ticketEffectiveStatus(t))) return false;
    if (ticketFilters.onlyOverdue && !isOverdueTicket(t)) return false;
    return true;
  }).sort((a, b) => (a.Termin?.getTime() || 0) - (b.Termin?.getTime() || 0));
  const view = ticketFilters.view || "kanban";

  $("#view-zadania").innerHTML = `
    <div class="section-head">
      <h2>Zadania (tickety)</h2>
      <div style="display:flex;align-items:center;gap:10px">
        <div class="view-toggle">
          <button type="button" class="view-toggle-btn ${view === "kanban" ? "active" : ""}" data-tk-view="kanban">Kanban</button>
          <button type="button" class="view-toggle-btn ${view === "lista" ? "active" : ""}" data-tk-view="lista">Lista</button>
        </div>
        ${can("create", "zadania_tickety") ? `<button data-add-ticket="">+ Nowy ticket</button>` : ""}
      </div>
    </div>
    <div class="filters">
      <select id="fTkProj"><option value="">Wszystkie projekty</option>${STATE.projects.map(p => `<option value="${esc(p.ID_Projektu)}" ${ticketFilters.projekt === p.ID_Projektu ? "selected" : ""}>${esc(p.Nazwa)}</option>`).join("")}</select>
      <select id="fTkOsoba"><option value="">Wszystkie osoby</option>${STATE.team.map(t => `<option value="${esc(t.ID_Osoby)}" ${ticketFilters.osoba === t.ID_Osoby ? "selected" : ""}>${esc(t.Imie_i_nazwisko)}</option>`).join("")}</select>
      ${view === "lista" ? `<div class="status-chips">
        <button type="button" class="status-chip badge badge-muted ${!ticketFilters.statuses.length ? "active" : ""}" data-tk-status-filter="">Wszystkie</button>
        ${STATUSY_TICKIETOW.map(s => `<button type="button" class="status-chip badge badge-${ticketStatusBadge(s)} ${ticketFilters.statuses.includes(s) ? "active" : ""}" data-tk-status-filter="${esc(s)}"><span class="dot" style="background:currentColor"></span>${esc(s)}</button>`).join("")}
      </div>` : ""}
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-secondary)">
        <input type="checkbox" id="fTkOverdue" ${ticketFilters.onlyOverdue ? "checked" : ""}> tylko opóźnione
      </label>
      <span class="count">${list.length} / ${STATE.tickets.length} zadań</span>
    </div>
    ${view === "kanban" ? renderTicketsKanban(list) : `
    <div class="panel" style="overflow-x:auto">
      <table class="data-table">
        <thead><tr>
          <th>ID</th><th>Tytuł</th><th>Projekt</th><th>Osoba</th><th>Termin</th><th>Priorytet</th>
          <th class="num">Szac. rbh</th><th class="num">Rzecz. rbh</th><th>Status</th>
        </tr></thead>
        <tbody>
          ${list.map(t => `
            <tr ${can("update", "zadania_tickety", t) ? `class="clickable" data-open-ticket="${esc(t.ID_Tickietu)}"` : ""}>
              <td>${esc(t.ID_Tickietu)}</td>
              <td>${esc(t.Tytul)}</td>
              <td>${esc(projectName(t.ID_Projektu))}</td>
              <td>${esc(ticketAssigneeLabel(t))}</td>
              <td>${fmtDate(t.Termin)}</td>
              <td>${esc(t.Priorytet)}</td>
              <td class="num">${t.Szacowane_roboczogodziny ?? "—"}</td>
              <td class="num">${t.Rzeczywiste_roboczogodziny ?? "—"}</td>
              <td>${badge(ticketEffectiveStatus(t), ticketStatusBadge(ticketEffectiveStatus(t)))}</td>
            </tr>`).join("") || `<tr><td colspan="9" class="empty-hint">Brak zadań — dodaj tickety z poziomu karty projektu.</td></tr>`}
        </tbody>
      </table>
    </div>`}`;
  $("#fTkProj").addEventListener("change", e => { ticketFilters.projekt = e.target.value; renderTickets(); });
  $("#fTkOsoba").addEventListener("change", e => { ticketFilters.osoba = e.target.value; renderTickets(); });
  $("#fTkOverdue").addEventListener("change", e => { ticketFilters.onlyOverdue = e.target.checked; renderTickets(); });
}

const ticketMoveSeq = new Map(); // ID_Tickietu -> numer najnowszego w locie zadania PUT

async function moveTicketToStatus(tid, newStatus) {
  const t = STATE.tickets.find(x => x.ID_Tickietu === tid);
  if (!t || t.Status === newStatus || !KANBAN_KOLUMNY.includes(newStatus)) return;
  if (!can("update", "zadania_tickety", t)) return; // unika bezuzytecznego 403 z proba optymistycznej zmiany
  const prevStatus = t.Status, prevDone = t.Data_zakonczenia;
  t.Status = newStatus;
  t.Data_zakonczenia = deriveTicketCompletionDate(newStatus, t.Data_zakonczenia);
  renderTickets();
  // Szybkie podwojne przeciagniecie tego samego ticketu (zanim pierwszy PUT sie zakonczy)
  // odpala dwa rownolegle zadania - stosujemy tylko odpowiedz z NAJNOWSZEGO z nich, zeby
  // wolniejsza odpowiedz starszego przeciagniecia (siegajaca po sieci w dowolnej kolejnosci)
  // nie nadpisala juz poprawnego, nowszego stanu bez zadnego komunikatu o bledzie.
  const seq = (ticketMoveSeq.get(tid) || 0) + 1;
  ticketMoveSeq.set(tid, seq);
  try {
    const payload = serializeForApi({ Status: t.Status, Data_zakonczenia: t.Data_zakonczenia }, ["Data_zakonczenia"]);
    const saved = await apiPut(`/api/zadania_tickety/${tid}`, payload);
    if (ticketMoveSeq.get(tid) !== seq) return; // nowsze przeciagniecie juz w toku
    reviveDates([saved], DATE_FIELDS.tickets);
    Object.assign(t, saved);
  } catch (e) {
    if (ticketMoveSeq.get(tid) !== seq) return;
    t.Status = prevStatus; t.Data_zakonczenia = prevDone;
    alert("Nie udało się zmienić statusu zadania: " + e.message);
  }
  renderTickets();
}

// Uogolniony kanban drag&drop - karty dowolnego "rodzaju" (na razie ticket/project) niosa
// data-drag-kind + data-drag-id zamiast osobnego atrybutu per typ (byl tu tylko
// data-drag-ticket, dopoki istnial jeden kanban). KANBAN_MOVE_HANDLERS to rejestr
// {kind: moveFn} zamiast twardego wywolania moveTicketToStatus - drop dispatch'uje przez
// niego, wiec dodanie kolejnego przeciaganego typu (np. ideapool) to jeden nowy wpis, nie
// kopiowanie piatego zestawu listenerow.
// "project" usuniety z tego rejestru w Faza 1 - Status projektu (master) jest teraz wyliczany
// z sub-projektow, wiec przeciaganie karty projektu miedzy kolumnami statusu juz nic nie zapisuje.
const KANBAN_MOVE_HANDLERS = { ticket: moveTicketToStatus };
document.addEventListener("dragstart", (e) => {
  const card = e.target.closest("[data-drag-kind]");
  if (!card) return;
  e.dataTransfer.setData("text/plain", `${card.getAttribute("data-drag-kind")}|${card.getAttribute("data-drag-id")}`);
  e.dataTransfer.effectAllowed = "move";
  setTimeout(() => card.classList.add("dragging"), 0);
});
document.addEventListener("dragend", (e) => {
  const card = e.target.closest("[data-drag-kind]");
  if (card) card.classList.remove("dragging");
  $all(".kanban-col.drag-over").forEach(c => c.classList.remove("drag-over"));
});
document.addEventListener("dragover", (e) => {
  const col = e.target.closest("[data-drop-status]");
  if (!col) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  col.classList.add("drag-over");
});
document.addEventListener("dragleave", (e) => {
  const col = e.target.closest("[data-drop-status]");
  if (col && !col.contains(e.relatedTarget)) col.classList.remove("drag-over");
});
document.addEventListener("drop", (e) => {
  const col = e.target.closest("[data-drop-status]");
  if (!col) return;
  e.preventDefault();
  col.classList.remove("drag-over");
  const [kind, id] = (e.dataTransfer.getData("text/plain") || "").split("|");
  const handler = KANBAN_MOVE_HANDLERS[kind];
  if (handler && id) handler(id, col.getAttribute("data-drop-status"));
});

/* ================================================================== VIEW: GANTT */
let ganttFilters = { projekt: "", typ: "", osoba: "", groupBy: "projekt", view: "skrocony" };

function renderGanttFilters() {
  const condensed = ganttFilters.view === "skrocony";
  return `
    <div class="section-head">
      <h2>Harmonogram</h2>
      ${can("create", "harmonogram") ? `<button data-add-task="">+ Dodaj etap</button>` : ""}
    </div>
    <div class="filters">
      <div class="view-toggle">
        <button type="button" class="view-toggle-btn ${!condensed ? "active" : ""}" data-gantt-view="szczegoly">Szczegółowy</button>
        <button type="button" class="view-toggle-btn ${condensed ? "active" : ""}" data-gantt-view="skrocony">Skrócony (czas trwania)</button>
      </div>
      ${condensed ? "" : `<select id="fGanttGroupBy">
        <option value="projekt" ${ganttFilters.groupBy === "projekt" ? "selected" : ""}>Grupuj wg: projektu</option>
        <option value="osoba" ${ganttFilters.groupBy === "osoba" ? "selected" : ""}>Grupuj wg: osoby (zespół)</option>
      </select>`}
      <select id="fGanttProj"><option value="">Wszystkie projekty</option>${STATE.projects.map(p => `<option value="${esc(p.ID_Projektu)}" ${ganttFilters.projekt === p.ID_Projektu ? "selected" : ""}>${esc(p.Nazwa)}</option>`).join("")}</select>
      <select id="fGanttTyp"><option value="">Wszystkie typy</option>${TYPE_ORDER.map(t => `<option ${ganttFilters.typ === t ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
      ${condensed ? "" : `<select id="fGanttOsoba"><option value="">Wszyscy odpowiedzialni</option>${STATE.team.map(t => `<option value="${esc(t.ID_Osoby)}" ${ganttFilters.osoba === t.ID_Osoby ? "selected" : ""}>${esc(t.Imie_i_nazwisko)}</option>`).join("")}</select>`}
      <span class="count" id="fGanttCount"></span>
    </div>`;
}

function projectGanttPseudoStatus(p) {
  // Mapuje projekt na "status zadania" (TASK_STATUSES) tylko na potrzeby paska Gantta w
  // widoku skroconym - ten sam kolorowy jezyk (nie rozpoczete/w trakcie/zakonczone/opoznione),
  // co szczegolowe etapy, zeby oba widoki byly wizualnie spojne mimo innego zrodla danych.
  if (p.Status === "Zakonczony") return "Zakonczone";
  const end = p.Data_zakonczenia_planowana;
  if (end instanceof Date && end < today0()) return "Opoznione";
  const start = p.Data_rozpoczecia;
  if (start instanceof Date && start > new Date()) return "Nie rozpoczete";
  return "W trakcie";
}

function filteredProjectsForGantt() {
  return STATE.projects.filter(p => {
    if (ganttFilters.projekt && p.ID_Projektu !== ganttFilters.projekt) return false;
    if (ganttFilters.typ && p.Typ_projektu !== ganttFilters.typ) return false;
    return true;
  });
}

function buildGanttCondensed(projects) {
  const pseudoTasks = projects
    .filter(p => p.Data_rozpoczecia instanceof Date || p.Data_zakonczenia_planowana instanceof Date)
    .map(p => ({
      ID_Zadania: p.ID_Projektu,
      ID_Projektu: p.ID_Projektu,
      Nazwa_zadania: p.Nazwa,
      Data_start_plan: p.Data_rozpoczecia || p.Data_zakonczenia_planowana,
      Data_koniec_plan: p.Data_zakonczenia_planowana || p.Data_rozpoczecia,
      Status: projectGanttPseudoStatus(p),
      Procent_ukonczenia: p.Procent_postepu,
      ID_Osoby_odpowiedzialnej: null,
      // Dodatkowe pola tylko na potrzeby widoku skroconego (kolor per architekt prowadzacy +
      // bogatszy tooltip) - detailed view (prawdziwe zadania harmonogramu) ich nie ma i nie
      // potrzebuje, barFor() siega po nie tylko gdy opts.condensed.
      _owner: p.Owner,
      _goLive: p.Data_go_live,
      _ticketCount: ticketsForProject(p.ID_Projektu).length,
    }));
  return buildGantt(pseudoTasks, { groupBy: "projekt", hideGroupHeader: true, condensed: true });
}

function buildGantt(tasks, opts = {}) {
  if (!tasks.length) return `<div class="kpi-sub">${opts.condensed ? "Brak projektów z ustawionymi datami." : "Brak zadań spełniających kryteria."}</div>`;
  const starts = tasks.map(t => t.Data_start_plan).filter(d => d instanceof Date);
  const ends = tasks.map(t => t.Data_koniec_plan).filter(d => d instanceof Date);
  if (!starts.length || !ends.length) return `<div class="kpi-sub">Brak dat w harmonogramie.</div>`;
  let tMin = new Date(Math.min(...starts.map(d => d.getTime())));
  let tMax = new Date(Math.max(...ends.map(d => d.getTime())));
  tMin = new Date(tMin.getFullYear(), tMin.getMonth() - 1, 1);
  tMax = new Date(tMax.getFullYear(), tMax.getMonth() + 2, 0);
  const totalMs = tMax.getTime() - tMin.getTime();
  const today = new Date();
  const todayPct = Math.min(100, Math.max(0, (today.getTime() - tMin.getTime()) / totalMs * 100));

  const months = [];
  let cur = new Date(tMin.getFullYear(), tMin.getMonth(), 1);
  while (cur <= tMax) { months.push(new Date(cur)); cur.setMonth(cur.getMonth() + 1); }

  const monthTicks = months.map(m => {
    const left = (m.getTime() - tMin.getTime()) / totalMs * 100;
    const isJan = m.getMonth() === 0;
    const label = isJan ? m.getFullYear() : (m.getMonth() % 3 === 0 ? m.toLocaleDateString("pl-PL", { month: "short" }) : "");
    return `<div class="gantt-month-tick${isJan ? " year-tick" : ""}" style="left:${left}%">${label}</div>`;
  }).join("");

  const groupBy = opts.groupBy || "projekt";
  const groupKeyOf = (t) => groupBy === "osoba" ? (t.ID_Osoby_odpowiedzialnej || "—") : t.ID_Projektu;
  const groupLabelOf = (key) => groupBy === "osoba" ? personName(key) : projectName(key);
  const groupClickAttr = (key) => groupBy === "osoba" ? `data-open-person="${esc(key)}"` : `data-open-project="${esc(key)}"`;

  const grouped = new Map();
  tasks.forEach(t => { const k = groupKeyOf(t); if (!grouped.has(k)) grouped.set(k, []); grouped.get(k).push(t); });

  const barFor = (t) => {
    const s = t.Data_start_plan, e = t.Data_koniec_plan;
    if (!(s instanceof Date) || !(e instanceof Date)) return "";
    let left = (s.getTime() - tMin.getTime()) / totalMs * 100;
    let width = Math.max(0.6, (e.getTime() - s.getTime()) / totalMs * 100);
    const pct = num(t.Procent_ukonczenia) * 100;
    if (opts.condensed) {
      // Kolor paska per architekt prowadzacy (Owner), nie per status - "kolory projektow w tym
      // widoku przypisz per architekt prowadzacy" - ten sam deterministyczny hash co
      // ownerTagHtml() gdzie indziej w apce (kazdy architekt ma stale, rozpoznawalne barwe we
      // wszystkich widokach). Tooltip: nazwa, owner, go live (miesiac), liczba ticketow,
      // procent realizacji - dokladnie w tej kolejnosci, na wprost zyczenie uzytkownika.
      // Brak ownera dostaje neutralny szary zamiast personColorSlot("") - haszowanie pustego
      // stringa zawsze daje ten sam slot (cat-1), wiec bez tego wszystkie projekty bez ownera
      // "przypadkiem" dzielilyby jeden kolor z realnym architektem o tym samym hashu, bez
      // wyjasnienia w legendzie (ktora i tak pomija puste nazwy - patrz filter(Boolean) nizej).
      const bg = t._owner ? `var(--${personColorSlot(t._owner)})` : "var(--text-muted)";
      const goLiveLabel = t._goLive instanceof Date ? `${MIESIACE_PL[t._goLive.getMonth()]} ${t._goLive.getFullYear()}` : "—";
      const title = [
        t.Nazwa_zadania,
        `Owner: ${t._owner || "—"}`,
        `Go Live: ${goLiveLabel}`,
        `Tickety: ${t._ticketCount}`,
        `Realizacja: ${Math.round(pct)}%`,
      ].map(esc).join("&#10;");
      return `<div class="gantt-bar" style="left:${left}%;width:${width}%;background:${bg}"
          title="${title}">
          <div class="fill-progress" style="width:${pct}%"></div>
          <span>${esc(t.Nazwa_zadania)} — ${esc(t._owner || "—")} · ${Math.round(pct)}%</span>
        </div>`;
    }
    const cls = taskStatusClass(t.Status);
    return `<div class="gantt-bar status-${cls}" style="left:${left}%;width:${width}%"
        title="${esc(t.Nazwa_zadania)}&#10;${fmtDate(s)} — ${fmtDate(e)}&#10;${Math.round(pct)}% ukończenia&#10;Odpowiedzialny: ${esc(personName(t.ID_Osoby_odpowiedzialnej))}">
        <div class="fill-progress" style="width:${pct}%"></div>
        <span>${esc(t.Nazwa_zadania)}</span>
      </div>`;
  };

  const rowsHtml = Array.from(grouped.entries()).map(([key, ptasks]) => {
    ptasks.sort((a, b) => (a.Data_start_plan?.getTime() || 0) - (b.Data_start_plan?.getTime() || 0));
    const groupHeader = opts.hideGroupHeader ? "" : `
      <div class="gantt-group-row">
        <div class="gantt-label-col" ${groupClickAttr(key)}>${esc(groupLabelOf(key))}</div>
        <div class="gantt-timeline-col"></div>
      </div>`;
    const rows = ptasks.map(t => `
      <div class="gantt-row" data-task-id="${esc(t.ID_Zadania)}" data-open-project="${esc(t.ID_Projektu)}" title="${opts.condensed ? "Kliknij, aby otworzyć projekt" : "Kliknij, aby edytować etap"}">
        <div class="gantt-label-col" title="${esc(t.Nazwa_zadania)}">${esc(t.Nazwa_zadania)}</div>
        <div class="gantt-track">
          <div class="gantt-today" style="position:absolute;left:${todayPct}%;top:0;bottom:0;border-left:1px dashed var(--status-critical)"></div>
          ${barFor(t)}
        </div>
      </div>`).join("");
    return groupHeader + rows;
  }).join("");

  const legendHtml = opts.condensed
    ? (() => {
        // Kolor paska = architekt prowadzacy w tym widoku (nie status) - legenda pokazuje wiec
        // liste WYSTEPUJACYCH architektow z ich barwa, zamiast statusow (patrz barFor()).
        const owners = Array.from(new Set(tasks.map(t => t._owner).filter(Boolean))).sort((a, b) => a.localeCompare(b, "pl"));
        const ownerItems = owners.map(name =>
          `<span class="item"><span class="swatch" style="background:var(--${personColorSlot(name)})"></span>${esc(name)}</span>`
        ).join("");
        const noOwnerItem = tasks.some(t => !t._owner)
          ? `<span class="item"><span class="swatch" style="background:var(--text-muted)"></span>Brak ownera</span>` : "";
        return `${ownerItems}${noOwnerItem}<span class="item">┊ <span style="color:var(--status-critical)">— dziś</span></span>`;
      })()
    : `
      <span class="item"><span class="swatch status-notstarted"></span>Nie rozpoczęte</span>
      <span class="item"><span class="swatch status-progress"></span>W trakcie</span>
      <span class="item"><span class="swatch status-done"></span>Zakończone</span>
      <span class="item"><span class="swatch status-delayed"></span>Opóźnione</span>
      <span class="item">┊ <span style="color:var(--status-critical)">— dziś</span></span>`;

  return `
    <div class="gantt-scroll">
      <div class="gantt-wrap">
        <div class="gantt-header-row">
          <div class="gantt-label-col">Zadanie / Projekt</div>
          <div class="gantt-timeline-col">${monthTicks}</div>
        </div>
        <div class="gantt-body">${rowsHtml}</div>
      </div>
    </div>
    <div class="gantt-legend">${legendHtml}</div>`;
}

function filteredTasks() {
  return STATE.tasks.filter(t => {
    if (ganttFilters.projekt && t.ID_Projektu !== ganttFilters.projekt) return false;
    if (ganttFilters.osoba && t.ID_Osoby_odpowiedzialnej !== ganttFilters.osoba) return false;
    if (ganttFilters.typ) {
      const proj = STATE.projectById.get(t.ID_Projektu);
      if (!proj || proj.Typ_projektu !== ganttFilters.typ) return false;
    }
    return true;
  });
}

function harmonogramStatusBadgeClass(status) {
  if (status === "Zakonczone") return "good";
  if (status === "Opoznione") return "critical";
  if (status === "W trakcie") return "active";
  return "muted"; // Nie rozpoczete i kazda inna/brak wartosci
}
function ganttProjectTaskTableHtml(tasks) {
  // Widok skrocony pokazuje projekt jako JEDEN pasek (celowo, patrz buildGanttCondensed) - gdy
  // uzytkownik zawezi filtr do KONKRETNEGO projektu, dopisz tez tabele z etapami harmonogramu
  // pod spodem, zeby nie trzeba bylo przelaczac sie na widok Szczegolowy tylko po to, zeby
  // zobaczyc rozbicie na etapy jednego, juz wybranego projektu.
  if (!tasks.length) return `<div class="kpi-sub" style="margin-top:14px">Brak etapów harmonogramu dla tego projektu.</div>`;
  const sorted = [...tasks].sort((a, b) => (a.Data_start_plan?.getTime() || 0) - (b.Data_start_plan?.getTime() || 0));
  return `
    <div class="section-head" style="margin-top:18px"><h2 style="font-size:14px">Etapy harmonogramu tego projektu (${sorted.length})</h2></div>
    <div class="panel" style="overflow-x:auto">
      <table class="data-table">
        <thead><tr>
          <th>Zadanie / etap</th><th>Kategoria</th><th>Start (plan)</th><th>Koniec (plan)</th>
          <th>Status</th><th>Postęp</th><th>Priorytet</th><th>Odpowiedzialny</th>
        </tr></thead>
        <tbody>
          ${sorted.map(t => `
            <tr class="clickable" data-task-id="${esc(t.ID_Zadania)}">
              <td>${esc(t.Nazwa_zadania)}</td>
              <td>${esc(t.Kategoria || "—")}</td>
              <td>${fmtDate(t.Data_start_plan)}</td>
              <td>${fmtDate(t.Data_koniec_plan)}</td>
              <td>${badge(t.Status || "—", harmonogramStatusBadgeClass(t.Status))}</td>
              <td>${fmtPctFraction(t.Procent_ukonczenia)}</td>
              <td>${t.Priorytet ? badge(t.Priorytet, priorityBadgeClass(t.Priorytet)) : "—"}</td>
              <td>${esc(personName(t.ID_Osoby_odpowiedzialnej))}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

function renderGanttView() {
  const condensed = ganttFilters.view === "skrocony";
  const body = condensed ? buildGanttCondensed(filteredProjectsForGantt()) : buildGantt(filteredTasks(), { groupBy: ganttFilters.groupBy });
  const taskTable = condensed && ganttFilters.projekt ? ganttProjectTaskTableHtml(filteredTasks()) : "";
  $("#view-gantt").innerHTML = `${renderGanttFilters()}<div class="panel">${body}</div>${taskTable}`;
  $("#fGanttCount").textContent = condensed
    ? `${filteredProjectsForGantt().filter(p => p.Data_rozpoczecia instanceof Date || p.Data_zakonczenia_planowana instanceof Date).length} projektów`
    : `${filteredTasks().length} zadań`;
  $("#fGanttProj").addEventListener("change", e => { ganttFilters.projekt = e.target.value; renderGanttView(); });
  $("#fGanttTyp").addEventListener("change", e => { ganttFilters.typ = e.target.value; renderGanttView(); });
  if (!condensed) {
    $("#fGanttGroupBy").addEventListener("change", e => { ganttFilters.groupBy = e.target.value; renderGanttView(); });
    $("#fGanttOsoba").addEventListener("change", e => { ganttFilters.osoba = e.target.value; renderGanttView(); });
  }
}

/* ================================================================== VIEW: RYZYKA */
let riskFilters = { projekt: "", status: "" };

function renderRyzyka() {
  const rows = STATE.risks.filter(r => {
    if (riskFilters.projekt && r.ID_Projektu !== riskFilters.projekt) return false;
    if (riskFilters.status && r.Status !== riskFilters.status) return false;
    return true;
  }).sort((a, b) => (a.Status === "Otwarte" ? -1 : 1) - (b.Status === "Otwarte" ? -1 : 1));

  $("#view-ryzyka").innerHTML = `
    <div class="filters">
      <select id="fRiskProj"><option value="">Wszystkie projekty</option>${STATE.projects.map(p => `<option value="${esc(p.ID_Projektu)}" ${riskFilters.projekt === p.ID_Projektu ? "selected" : ""}>${esc(p.Nazwa)}</option>`).join("")}</select>
      <select id="fRiskStatus"><option value="">Wszystkie statusy</option>
        <option ${riskFilters.status === "Otwarte" ? "selected" : ""}>Otwarte</option>
        <option ${riskFilters.status === "W trakcie" ? "selected" : ""}>W trakcie</option>
        <option ${riskFilters.status === "Zamkniete" ? "selected" : ""}>Zamknięte</option>
      </select>
      <span class="count">${rows.length} pozycji</span>
    </div>
    <div class="panel" style="overflow-x:auto">
      <table class="data-table">
        <thead><tr>
          <th>Projekt</th><th>Typ</th><th>Opis</th><th>Kategoria</th><th>Priorytet</th><th>Właściciel</th><th>Status</th><th>Zidentyfikowano</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr class="clickable" data-open-project="${esc(r.ID_Projektu)}">
              <td>${esc(projectName(r.ID_Projektu))}</td>
              <td>${esc(r.Typ)}</td>
              <td>${esc(r.Opis)}</td>
              <td>${esc(r.Kategoria)}</td>
              <td>${esc(r.Priorytet)}</td>
              <td>${esc(personName(r.ID_Osoby_wlasciciela))}</td>
              <td>${badge(r.Status, riskStatusBadge(r.Status))}</td>
              <td>${fmtDate(r.Data_identyfikacji)}</td>
            </tr>`).join("") || `<tr><td colspan="8" class="empty-hint">Brak ryzyk i problemów spełniających kryteria.</td></tr>`}
        </tbody>
      </table>
    </div>`;
  $("#fRiskProj").addEventListener("change", e => { riskFilters.projekt = e.target.value; renderRyzyka(); });
  $("#fRiskStatus").addEventListener("change", e => { riskFilters.status = e.target.value; renderRyzyka(); });
}

/* ================================================================== VIEW: UZYTKOWNICY (tylko COO/Admin) */
function roleBadgeClass(role) { return role == null ? "warning" : role === "Admin" || role === "COO" ? "good" : "muted"; }
function fmtBytes(n) { return n == null ? "—" : n < 1024 * 1024 ? Math.round(n / 1024) + " KB" : (n / 1024 / 1024).toFixed(1) + " MB"; }

/* ---------- Etykiety (Faza 2, A13) - edytowalny slownik Typ_etapu/Segment/Funkcja_biura ---------- */
const LABEL_CATEGORIES = [["Typ_etapu", "Typ etapu (sub-projektu)"], ["Segment", "Segment"], ["Funkcja_biura", "Funkcja biura"]];
const LABEL_COLOR_CHOICES = ["cat-1", "cat-2", "cat-3", "cat-4", "cat-5", "cat-6", "cat-7", "cat-8"];
// Wszystkie etykiety kategorii (w tym NIEaktywne, wyszarzone) - do panelu zarzadzania.
// labelsForCategory() (tylko aktywne) zostaje osobno, uzywane w dropdownach formularzy.
function allLabelsForCategory(kategoria) {
  return STATE.labelConfig.filter(e => e.Kategoria === kategoria).sort((a, b) => (a.Kolejnosc ?? 0) - (b.Kolejnosc ?? 0));
}
function renderLabelAdminSection() {
  return `
    <div class="section-head"><h2>Etykiety</h2></div>
    <div class="panel" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px">
      ${LABEL_CATEGORIES.map(([kat, label]) => {
        const items = allLabelsForCategory(kat);
        return `
        <div>
          <div class="section-head" style="margin-bottom:8px"><h4 style="margin:0">${esc(label)}</h4>
            <button class="icon-btn" data-add-label="${esc(kat)}">+ Dodaj</button></div>
          ${items.map((e, i) => `
            <div class="dp-list-item" style="opacity:${e.Aktywna === "Nie" ? "0.5" : "1"}">
              <div class="item-actions">
                <button class="icon-btn" data-move-label="${esc(e.ID_Etykiety)}" data-dir="up" ${i === 0 ? "disabled" : ""}>↑</button>
                <button class="icon-btn" data-move-label="${esc(e.ID_Etykiety)}" data-dir="down" ${i === items.length - 1 ? "disabled" : ""}>↓</button>
                <button class="icon-btn" data-edit-label="${esc(e.ID_Etykiety)}">Edytuj</button>
                <button class="icon-btn" data-toggle-label-active="${esc(e.ID_Etykiety)}">${e.Aktywna === "Nie" ? "Aktywuj" : "Dezaktywuj"}</button>
                <button class="icon-btn danger" data-delete-label="${esc(e.ID_Etykiety)}">Usuń</button>
              </div>
              <div class="title"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;background:var(--${e.Kolor || "cat-3"})"></span>${esc(e.Wartosc)}</div>
            </div>`).join("") || `<div class="empty-hint">Brak etykiet.</div>`}
        </div>`;
      }).join("")}
    </div>
  `;
}
function openLabelForm(kategoria, id = null) {
  const e = id ? STATE.labelConfig.find(x => x.ID_Etykiety === id) : {};
  if (id && !requireExisting(e, "etykieta")) return;
  const body = `
    ${fInput("Wartość *", "Wartosc", e.Wartosc, "text", "required")}
    ${fSelect("Kolor", "Kolor", pairs(LABEL_COLOR_CHOICES), e.Kolor || "cat-3")}
  `;
  openModal(id ? "Edytuj etykietę" : "Nowa etykieta", body, {
    submitLabel: "Zapisz",
    onSubmit: (data) => saveLabelFromForm(data, kategoria, id),
  });
}
async function saveLabelFromForm(data, kategoria, id) {
  if (!data.Wartosc) { alert("Podaj wartość etykiety."); return; }
  const isNew = !id;
  const existing = isNew ? {} : STATE.labelConfig.find(x => x.ID_Etykiety === id);
  if (!isNew && !requireExisting(existing, "etykieta")) return;
  const fields = isNew
    ? { Kategoria: kategoria, Wartosc: data.Wartosc, Kolor: data.Kolor, Kolejnosc: allLabelsForCategory(kategoria).length, Aktywna: "Tak" }
    : { Wartosc: data.Wartosc, Kolor: data.Kolor };
  const saved = await persistEntity({ isNew, endpoint: "/api/etykiety_konfiguracji", id, fields, errorLabel: "etykiety" });
  if (!saved) return;
  if (isNew) STATE.labelConfig.push(saved); else Object.assign(existing, saved);
  closeModal();
  renderAll();
}
async function deleteLabel(id) {
  if (!confirm("Usunąć tę etykietę? Projekty/etapy, które już jej używają, zachowają starą wartość jako zwykły tekst, ale nie będzie już można jej wybrać dla nowych.")) return;
  if (!await deleteEntity(`/api/etykiety_konfiguracji/${id}`, "etykiety")) return;
  STATE.labelConfig = STATE.labelConfig.filter(e => e.ID_Etykiety !== id);
  renderAll();
}
async function toggleLabelActive(id) {
  const e = STATE.labelConfig.find(x => x.ID_Etykiety === id);
  if (!e) return;
  const prev = e.Aktywna;
  e.Aktywna = prev === "Nie" ? "Tak" : "Nie";
  renderAll();
  try {
    const saved = await apiPut(`/api/etykiety_konfiguracji/${id}`, { Aktywna: e.Aktywna });
    Object.assign(e, saved);
  } catch (err) {
    e.Aktywna = prev;
    alert("Nie udało się zaktualizować etykiety: " + err.message);
  }
  renderAll();
}
async function moveLabel(id, dir) {
  const e = STATE.labelConfig.find(x => x.ID_Etykiety === id);
  if (!e) return;
  const siblings = allLabelsForCategory(e.Kategoria);
  const idx = siblings.findIndex(x => x.ID_Etykiety === id);
  const swapIdx = dir === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= siblings.length) return;
  const other = siblings[swapIdx];
  const myOrder = e.Kolejnosc, otherOrder = other.Kolejnosc;
  e.Kolejnosc = otherOrder; other.Kolejnosc = myOrder;
  renderAll();
  try {
    await Promise.all([
      apiPut(`/api/etykiety_konfiguracji/${e.ID_Etykiety}`, { Kolejnosc: e.Kolejnosc }),
      apiPut(`/api/etykiety_konfiguracji/${other.ID_Etykiety}`, { Kolejnosc: other.Kolejnosc }),
    ]);
  } catch (err) {
    e.Kolejnosc = myOrder; other.Kolejnosc = otherOrder;
    alert("Nie udało się zmienić kolejności: " + err.message);
    renderAll();
  }
}

function renderUsers() {
  $("#view-uzytkownicy").innerHTML = `
    <div class="section-head"><h2>Użytkownicy</h2><button data-add-user="1">+ Dodaj użytkownika</button></div>
    <div class="panel" style="overflow-x:auto">
      <table class="data-table">
        <thead><tr>
          <th>E-mail</th><th>Imię i nazwisko</th><th>Rola</th><th>Powiązana osoba</th><th>Aktywny</th><th>Ostatnie logowanie</th><th></th>
        </tr></thead>
        <tbody>
          ${STATE.users.map(u => `
            <tr>
              <td>${esc(u.Email)}</td>
              <td>${esc(u.Imie_i_nazwisko || "—")}</td>
              <td>${badge(u.Rola == null ? "Oczekujące" : (ROLE_LABELS[u.Rola] || u.Rola), roleBadgeClass(u.Rola))}</td>
              <td>${esc(personName(u.ID_Osoby) || "—")}</td>
              <td>${badge(u.Aktywny ? "Tak" : "Nie", u.Aktywny ? "good" : "critical")}</td>
              <td>${fmtDate(u.Data_ostatniego_logowania)}</td>
              <td class="item-actions">
                <button class="icon-btn" data-edit-user="${esc(u.ID_Uzytkownika)}">Edytuj</button>
                <button class="icon-btn" data-reset-password-user="${esc(u.ID_Uzytkownika)}">Hasło</button>
                <button class="icon-btn ${u.Aktywny ? "danger" : ""}" data-toggle-active-user="${esc(u.ID_Uzytkownika)}">${u.Aktywny ? "Dezaktywuj" : "Aktywuj"}</button>
              </td>
            </tr>`).join("") || `<tr><td colspan="7" class="empty-hint">Brak użytkowników.</td></tr>`}
        </tbody>
      </table>
    </div>

    ${renderLabelAdminSection()}

    <div class="section-head"><h2>Backup bazy danych</h2><button data-backup-now="1">Backup teraz</button></div>
    <div class="panel" style="overflow-x:auto">
      <table class="data-table">
        <thead><tr><th>Plik</th><th>Rozmiar</th></tr></thead>
        <tbody>
          ${STATE.backups.slice(0, 15).map(b => `<tr><td>${esc(b.name)}</td><td class="num">${fmtBytes(b.size)}</td></tr>`).join("")
            || `<tr><td colspan="2" class="empty-hint">Brak backupów — kliknij „Backup teraz” albo poczekaj na start serwera.</td></tr>`}
        </tbody>
      </table>
      ${STATE.backups.length > 15 ? `<div class="empty-hint">... i ${STATE.backups.length - 15} starszych (widoczne w baza_danych/backups/)</div>` : ""}
    </div>
  `;
}

function unlinkedTeamOptionsPairs(currentUid) {
  const linkedElsewhere = new Set(STATE.users.filter(u => u.ID_Uzytkownika !== currentUid && u.ID_Osoby).map(u => u.ID_Osoby));
  return [["", "— brak —"], ...STATE.team.filter(t => !linkedElsewhere.has(t.ID_Osoby)).map(t => [t.ID_Osoby, t.Imie_i_nazwisko])];
}

function openUserForm(uid = null) {
  const u = uid ? STATE.users.find(x => x.ID_Uzytkownika === uid) : {};
  if (!requireExisting(u, "użytkownik")) return;
  const body = `
    ${fInput("E-mail *", "Email", u.Email, "email", "required")}
    ${fInput("Imię i nazwisko", "Imie_i_nazwisko", u.Imie_i_nazwisko)}
    ${fSelect("Rola", "Rola", [["", "Oczekujące (brak dostępu)"], ["Specjalista", "Architekt"], ["Pracownik_biurowy", "Pracownik biurowy"], ["Architekt_PM", "Architekt Prowadzący"], ["COO", "COO"], ["Admin", "Admin"]], u.Rola || "")}
    ${fSelect("Powiązana osoba z zespołu", "ID_Osoby", unlinkedTeamOptionsPairs(uid), u.ID_Osoby)}
    ${fSelect("Aktywny", "Aktywny", [["Tak", "Tak"], ["Nie", "Nie"]], u.Aktywny === 0 ? "Nie" : "Tak")}
    <div class="empty-hint full" style="grid-column:1/-1">Role Architekt, Pracownik biurowy i Architekt Prowadzący wymagają powiązanej osoby z zespołu (do niej odnoszą się przydzielone projekty i tickety).</div>
  `;
  openModal(uid ? "Edytuj użytkownika" : "Nowy użytkownik", body, {
    submitLabel: "Zapisz",
    onSubmit: (data) => saveUserFromForm(data, uid),
  });
}

async function saveUserFromForm(data, uid) {
  if (!data.Email) { alert("Podaj adres e-mail."); return; }
  const isNew = !uid;
  const existing = isNew ? {} : STATE.users.find(x => x.ID_Uzytkownika === uid);
  if (!requireExisting(existing, "użytkownik")) return;
  const fields = {
    Email: data.Email.trim().toLowerCase(), Imie_i_nazwisko: data.Imie_i_nazwisko,
    Rola: data.Rola || null, ID_Osoby: data.ID_Osoby || null,
    Aktywny: data.Aktywny === "Nie" ? 0 : 1,
  };
  const saved = await persistEntity({ isNew, endpoint: "/api/users", id: uid, fields, dateFields: DATE_FIELDS.users, errorLabel: "użytkownik" });
  if (!saved) return;
  if (isNew) STATE.users.push(saved); else Object.assign(existing, saved);
  closeModal();
  renderAll();
  if (isNew) resetUserPassword(saved.ID_Uzytkownika, true);
}

function resetUserPassword(uid, isInitial = false) {
  // Drugie pole (wlasne haslo wywolujacego) - backend wymaga go jako potwierdzenia
  // step-up przy resecie cudzego hasla (audyt bezpieczenstwa, 2026-07-10): bez tego
  // skradzione ciasteczko sesji admina wystarczyloby do przejecia dowolnego konta.
  const body = fInput(
    isInitial ? "Hasło początkowe (min. 8 znaków)" : "Nowe hasło (min. 8 znaków)",
    "new_password", "", "password", "required minlength=8"
  ) + fInput("Twoje hasło (potwierdzenie)", "admin_password", "", "password", "required autocomplete=current-password");
  openModal(isInitial ? "Ustaw hasło początkowe" : "Zresetuj hasło", body, {
    submitLabel: "Ustaw hasło",
    onSubmit: (data) => submitNewPassword(uid, data.new_password, data.admin_password),
  });
}

async function submitNewPassword(uid, pw, adminPassword) {
  if (!pw || pw.length < 8) { alert("Hasło musi mieć co najmniej 8 znaków."); return; }
  if (!adminPassword) { alert("Potwierdź własne hasło, żeby kontynuować."); return; }
  try {
    await apiPost(`/api/users/${uid}/reset-password`, { new_password: pw, admin_password: adminPassword });
    closeModal();
    alert("Hasło zostało ustawione.");
  } catch (e) {
    alert("Nie udało się ustawić hasła: " + e.message);
  }
}

async function toggleUserActive(uid) {
  const u = STATE.users.find(x => x.ID_Uzytkownika === uid);
  if (!requireExisting(u, "użytkownik")) return;
  const nextActive = u.Aktywny ? 0 : 1;
  if (!nextActive && !confirm(`Dezaktywować konto ${u.Email}? Straci dostęp natychmiast, nawet jeśli jest aktualnie zalogowane.`)) return;
  const saved = await persistEntity({ isNew: false, endpoint: "/api/users", id: uid, fields: { Aktywny: nextActive }, dateFields: DATE_FIELDS.users, errorLabel: "użytkownik" });
  if (!saved) return;
  Object.assign(u, saved);
  renderAll();
}

async function triggerBackupNow() {
  try {
    await apiPost("/api/backup");
    STATE.backups = await apiGet("/api/backup");
  } catch (e) {
    alert("Nie udało się utworzyć backupu: " + e.message);
    return;
  }
  renderAll();
}

/* ================================================================== MODAL / FORMULARZE */
let modalSubmitHandler = null;

function openModal(title, bodyHtml, { onSubmit, submitLabel = "Zapisz", wide = false } = {}) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = bodyHtml;
  $("#modalSubmit").textContent = submitLabel;
  $("#modalSubmit").disabled = false;
  $("#modalBox").classList.toggle("wide", wide);
  $("#modalOverlay").classList.add("open");
  $("#modalBox").classList.add("open");
  modalSubmitHandler = onSubmit;
  const first = $("#modalBody").querySelector("input,select,textarea");
  if (first) setTimeout(() => first.focus(), 30);
}
function closeModal() {
  $("#modalOverlay").classList.remove("open");
  $("#modalBox").classList.remove("open");
  modalSubmitHandler = null;
}
$("#modalForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!modalSubmitHandler) return;
  // Tekst wpisany w pole tagow, ale nie zatwierdzony Enterem/przecinkiem, nie ma atrybutu
  // "name" (celowo, zeby nie trafial do FormData jako smiec) - bez tego commitu ginalby po
  // cichu przy submicie zamiast zostac zapisany jako tag.
  $all(".tag-chip-input", e.target).forEach(addTagFromInput);
  // Pole daty jest zwyklym <input type="text">, wiec natywny "required" pilnuje tylko
  // niepustosci, nie poprawnosci formatu - odkad parseDateInput() odrzuca nieprawidlowe
  // daty zamiast je po cichu "zaokraglac", wpisanie np. "31.04.2026" w wymagane pole bez
  // tej blokady zapisywaloby sie jako calkowity brak terminu, bez jakiegokolwiek komunikatu.
  // Jedno miejsce w generycznym handlerze submitu pokrywa wszystkie wymagane pola daty we
  // wszystkich formularzach (Termin, Data_start_plan, Data_koniec_plan, Data_planowana,
  // Data_zakonczenia_planowana), zamiast dopisywac ten sam warunek do kazdego save*FromForm.
  const badDate = $all(".date-input[required]", e.target).find(el => el.value.trim() && !parseDateInput(el.value));
  if (badDate) {
    alert(`Nieprawidłowa data: "${badDate.value}". Popraw pole przed zapisem.`);
    badDate.focus();
    return;
  }
  // Bez blokady przycisku szybki podwojny klik/Enter odpalal dwa POST-y zanim pierwszy
  // zdazyl odpowiedziec (submit nie byl w ogole await'owany) - oba widzialy isNew=true
  // (STATE jeszcze nieodswiezone) i tworzyly dwa duplikaty rekordu z jednej akcji uzytkownika.
  const data = Object.fromEntries(new FormData(e.target).entries());
  const btn = $("#modalSubmit");
  btn.disabled = true;
  try {
    await modalSubmitHandler(data);
  } finally {
    btn.disabled = false;
  }
});
$("#modalCancel").addEventListener("click", closeModal);
$("#modalClose").addEventListener("click", closeModal);
$("#modalOverlay").addEventListener("click", closeModal);
$("#modalForm").addEventListener("change", (e) => {
  const group = e.target.closest("[data-checkbox-group]");
  if (!group) return;
  const checked = $all("input[type=checkbox]:checked", group).map(cb => cb.value);
  const hidden = group.querySelector("input[type=hidden]");
  if (hidden) hidden.value = JSON.stringify(checked);
});

function fInput(label, name, value, type = "text", extra = "") {
  if (type === "date") {
    const d = value instanceof Date ? value : parseDateInput(value);
    const v = dateDisplayVal(d);
    return `<label class="f-label date-field">${esc(label)}<span class="date-input-wrap"><input name="${name}" type="text" class="date-input" value="${esc(v)}" placeholder="dd.mm.rrrr" autocomplete="off" ${extra}><svg class="date-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2.5" stroke="currentColor" stroke-width="1.6"/><path d="M3 9.5H21" stroke="currentColor" stroke-width="1.6"/><path d="M8 3V6.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M16 3V6.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span></label>`;
  }
  const v = value ?? "";
  return `<label class="f-label">${esc(label)}<input name="${name}" type="${type}" value="${esc(v)}" ${extra}></label>`;
}
function optionsHtml(pairsList, selected) {
  return pairsList.map(([v, l]) => `<option value="${esc(v)}" ${v === selected ? "selected" : ""}>${esc(l)}</option>`).join("");
}
function fSelect(label, name, options, selected, extra = "") {
  return `<label class="f-label">${esc(label)}<select name="${name}" ${extra}>${optionsHtml(options, selected)}</select></label>`;
}
function fTextarea(label, name, value, extra = "") {
  return `<label class="f-label full">${esc(label)}<textarea name="${name}" rows="3" ${extra}>${esc(value ?? "")}</textarea></label>`;
}
function tagChipHtml(tag) {
  return `<span class="tag-chip removable" data-tag="${esc(tag)}">${esc(tag)}<button type="button" class="tag-chip-remove" aria-label="Usuń tag ${esc(tag)}">&times;</button></span>`;
}
// Chipy + input tekstowy zamiast zwyklego pola CSV - hidden input trzyma te sama wartosc CSV co
// wczesniej (name="Tagi"), wiec FormData/saveProjectFromForm czytaja go bez zadnych zmian.
function fTagsInput(label, name, valueCsv, suggestions = []) {
  const tags = (valueCsv || "").split(",").map(s => s.trim()).filter(Boolean);
  return `<label class="f-label full">${esc(label)}
    <div class="tag-chips-editable" data-tags-field>
      ${tags.map(tagChipHtml).join("")}
      <input type="text" class="tag-chip-input" list="tagi-suggestions" placeholder="Dodaj tag i Enter" autocomplete="off">
    </div>
    <datalist id="tagi-suggestions">${suggestions.map(s => `<option value="${esc(s)}">`).join("")}</datalist>
    <input type="hidden" name="${name}" value="${esc(tags.join(","))}">
  </label>`;
}
// Multiselect checkboxow (Faza 1, A2: "Typ projektu: multiselect zamiast pojedynczego wyboru") -
// hidden input trzyma JSON-owa liste zaznaczonych wartosci (mirror wzorca fTagsInput powyzej,
// tylko zamknieta lista opcji zamiast dowolnego tekstu), synchronizowany przez delegowany
// listener "change" na #modalForm (patrz nizej) - FormData/saveProjectFromForm czytaja go
// jak zwykle pole tekstowe, potem JSON.parse() na liste przed wyslaniem do API.
// `options` = [value, label] pary (mirror fSelect/optionsHtml) - value bywa nieczytelnym ID
// (np. ID_Zadania etapu "ZAD005"), wiec potrzebny osobny label, nie sama wartosc jak na starcie.
function fCheckboxGroup(label, name, options, selectedValues = []) {
  const selected = new Set(selectedValues);
  return `<label class="f-label full" data-checkbox-group="${name}">${esc(label)}
    <div class="checkbox-group">
      ${options.map(([v, l]) => `<label class="checkbox-chip"><input type="checkbox" value="${esc(v)}" ${selected.has(v) ? "checked" : ""}> ${esc(l)}</label>`).join("") || `<span class="empty-hint">Brak dostępnych opcji.</span>`}
    </div>
    <input type="hidden" name="${name}" value='${esc(JSON.stringify([...selected]))}'>
  </label>`;
}
function pairs(arr) { return arr.map(x => [x, x]); }
// Faza 2 (A13): Typ_etapu/Segment/Funkcja_biura sa teraz edytowalnym slownikiem
// (STATE.labelConfig, mirror etykiety_konfiguracji w server.py) zamiast statycznych tablic -
// posortowane wg Kolejnosc, tylko aktywne (Aktywna !== "Nie", ten sam warunek co
// active_label_values() w server.py).
function labelsForCategory(kategoria) {
  return STATE.labelConfig
    .filter(e => e.Kategoria === kategoria && e.Aktywna !== "Nie")
    .sort((a, b) => (a.Kolejnosc ?? 0) - (b.Kolejnosc ?? 0));
}
function labelPairsFor(kategoria) { return labelsForCategory(kategoria).map(e => [e.Wartosc, e.Wartosc]); }
function labelColor(kategoria, wartosc) {
  return STATE.labelConfig.find(e => e.Kategoria === kategoria && e.Wartosc === wartosc)?.Kolor;
}
function teamOptionsPairs() { return [["", "— wybierz —"], ...STATE.team.map(t => [t.ID_Osoby, t.Imie_i_nazwisko])]; }
// Sponsor projektu = czlonek zarzadu odpowiedzialny za finansowanie - zawezone do
// istniejacej, prawdziwej wartosci enuma Dzial="Zarzad" (nic nowego nie trzeba dodawac do
// zespol, zeby wiedziec "kto jest w zarzadzie").
function boardMemberOptionsPairs() { return [["", "— wybierz —"], ...STATE.team.filter(t => t.Dzial === "Zarzad").map(t => [t.ID_Osoby, t.Imie_i_nazwisko])]; }
function clientOptionsPairs() { return [["", "— brak / spoza rejestru —"], ...STATE.clients.map(c => [c.ID_Klienta, c.Nazwa])]; }
function assignedTeamOptionsPairs(pid, mustIncludeId) {
  const assignedIds = new Set(assignmentsForProject(pid).map(a => a.ID_Osoby));
  const assigned = STATE.team.filter(t => assignedIds.has(t.ID_Osoby));
  // brak pid lub brak przypisan do projektu -> pelna lista, zeby nie blokowac wyboru pustym dropdownem
  let list = assigned.length ? assigned : STATE.team;
  // istniejaca wartosc pola (np. osoba zdjeta z przypisan projektu po tym, jak ja wybrano)
  // musi zostac opcja - inaczej znika z listy, <select> spada na puste "--wybierz--" i zapis
  // formularza po cichu wyzerowuje pole mimo ze uzytkownik go nie ruszal.
  if (mustIncludeId && !list.some(t => t.ID_Osoby === mustIncludeId)) {
    const extra = STATE.team.find(t => t.ID_Osoby === mustIncludeId);
    if (extra) list = [extra, ...list];
  }
  return [["", "— wybierz —"], ...list.map(t => [t.ID_Osoby, t.Imie_i_nazwisko])];
}
function teamNamePairs() { return [["", "— wybierz —"], ...STATE.team.map(t => [t.Imie_i_nazwisko, t.Imie_i_nazwisko])]; }

/* ---------- Formularz: Projekt ---------- */
function openProjectForm(pid = null) {
  const p = pid ? STATE.projectById.get(pid) : {};
  if (!requireExisting(p, "projekt")) return;
  // Architekt prowadzacy tworzacy NOWY projekt zawsze konczy jako jego Owner/Kierownik
  // (server.py wymusza to bezwarunkowo przy zapisie, patrz _default_project_owner_for_architekt) -
  // domyslne zaznaczenie tutaj to tylko odzwierciedlenie tego z gory, zeby formularz od razu
  // pokazywal prawdziwy wynik, a nie mylaco sugerowal wybor, ktory i tak zostanie nadpisany.
  const architektDefaultOwner = !pid && STATE.me.role === "Architekt_PM" ? STATE.me.name : null;
  // Faza 1 (A9, warsztat 22.07.2026): Status/RAG_Status projektu (master) sa dzis WYLICZANE z
  // jego sub-projektow (harmonogram) - nie ma juz tu edytowalnych pol, tylko odczyt. Edycja
  // Statusu/RAG-a per sub-projekt zyje w formularzu etapu (openTaskForm), nie tutaj. Typ_projektu/
  // Faza tez znikaja z tego formularza - "typ" nowego projektu to teraz multiselect Typow_etapow
  // ponizej (A2), tworzacy sub-projekty; Faza usunieta jako duplikat Typ_projektu (A10).
  const statusRagInfo = pid ? `
    <div class="form-section-title">Status i RAG (wyliczane z sub-projektów)</div>
    <div style="grid-column:1/-1;display:flex;gap:8px;margin-bottom:4px">
      ${badge(p.Status || "Planowanie", projectStatusClass(p.Status))}
      ${p.RAG_Status ? badge(ragLabel(p.RAG_Status), ragClass(p.RAG_Status)) : badge("Brak sub-projektów", "muted")}
    </div>` : "";
  const body = `
    <div class="form-section-title">Dane podstawowe</div>
    ${fInput("Nazwa projektu *", "Nazwa", p.Nazwa, "text", "required")}
    ${fInput("Sygnatura (numer)", "Sygnatura", p.Sygnatura)}
    ${fInput("Symbol projektu", "Symbol_projektu", p.Symbol_projektu)}
    ${fTextarea("Nazwa zamierzenia budowlanego (oficjalny tytuł z PFU)", "Nazwa_zamierzenia_budowlanego", p.Nazwa_zamierzenia_budowlanego)}
    ${fSelect("Funkcja biura", "Funkcja_biura", labelPairsFor("Funkcja_biura"), p.Funkcja_biura)}
    ${fSelect("Segment", "Segment", labelPairsFor("Segment"), p.Segment)}
    ${fSelect("Owner *", "Owner", teamNamePairs(), p.Owner || architektDefaultOwner)}
    ${fSelect("Kierownik projektu", "Kierownik_projektu", teamNamePairs(), p.Kierownik_projektu || architektDefaultOwner)}
    ${fSelect("Sponsor (zarząd)", "ID_Osoby_sponsora", boardMemberOptionsPairs(), p.ID_Osoby_sponsora)}
    ${fSelect("Priorytet", "Priorytet", pairs(PRIORYTETY), p.Priorytet || "Sredni")}
    ${fTagsInput("Tagi", "Tagi", p.Tagi, allProjectTags())}
    ${statusRagInfo}
    ${!pid ? fCheckboxGroup("Etapy / sub-projekty (wybierz typy)", "Typy_etapow", labelPairsFor("Typ_etapu"), []) : ""}

    <div class="form-section-title">Terminy i postęp</div>
    ${fInput("Data rozpoczęcia", "Data_rozpoczecia", p.Data_rozpoczecia, "date")}
    ${fInput("Zakończenie (plan) *", "Data_zakonczenia_planowana", p.Data_zakonczenia_planowana, "date", "required")}
    ${fInput("Zakończenie (rzeczywiste)", "Data_zakonczenia_rzeczywista", p.Data_zakonczenia_rzeczywista, "date")}
    ${fInput("Data „Go Live”", "Data_go_live", p.Data_go_live, "date")}
    ${fInput("Postęp (%)", "Procent_postepu_pct", p.Procent_postepu != null ? Math.round(p.Procent_postepu * 100) : 0, "number", "min=0 max=100")}

    <div class="form-section-title">Wycena i budżet</div>
    ${fInput("Budżet całkowity", "Budzet_calkowity", p.Budzet_calkowity, "number", "min=0 step=1000")}
    ${fInput("Budżet wydany", "Budzet_wydany", p.Budzet_wydany, "number", "min=0 step=1000")}
    ${fInput("Waluta", "Waluta", p.Waluta || "PLN")}
    ${fInput("Przychód planowany", "Przychod_planowany", p.Przychod_planowany, "number", "min=0 step=1000")}
    ${fInput("Przychód rzeczywisty", "Przychod_rzeczywisty", p.Przychod_rzeczywisty, "number", "min=0 step=1000")}
    ${fInput("Szacowane roboczogodziny", "Szacowane_roboczogodziny", p.Szacowane_roboczogodziny, "number", "min=0 step=1")}
    ${fInput("Śr. stawka godzinowa (PLN/h)", "Stawka_godzinowa_srednia", p.Stawka_godzinowa_srednia, "number", "min=0 step=0.01")}

    <div class="form-section-title">Lokalizacja</div>
    ${fInput("Adres / lokalizacja", "Lokalizacja_Adres", p.Lokalizacja_Adres)}
    ${fInput("Miasto", "Miasto", p.Miasto)}
    ${fInput("Powierzchnia (m²)", "Powierzchnia_m2", p.Powierzchnia_m2, "number", "min=0")}
    ${fInput("Liczba jednostek", "Liczba_jednostek", p.Liczba_jednostek, "number", "min=0")}
    ${fInput("Inwestor / Klient (opis, jeśli brak w rejestrze)", "Inwestor_Klient", p.Inwestor_Klient)}
    ${fSelect("Klient (z rejestru)", "ID_Klienta", clientOptionsPairs(), p.ID_Klienta)}

    <div class="form-section-title">Lokalizacja urzędowa (do wniosków/pism)</div>
    ${fInput("Kraj", "Kraj", p.Kraj)}
    ${fInput("Województwo", "Wojewodztwo", p.Wojewodztwo)}
    ${fInput("Powiat", "Powiat", p.Powiat)}
    ${fInput("Gmina", "Gmina", p.Gmina)}
    ${fInput("Miejscowość", "Miejscowosc", p.Miejscowosc)}
    ${fInput("Ulica", "Ulica", p.Ulica)}
    ${fInput("Kod pocztowy", "Kod_pocztowy", p.Kod_pocztowy)}

    <div class="form-section-title">Zakres projektu (karta projektowa)</div>
    ${fTextarea("Opis / zakres", "Opis", p.Opis)}
    ${fTextarea("Komentarz PMO", "Komentarz", p.Komentarz)}
  `;
  openModal(pid ? "Edytuj projekt" : "Nowy projekt", body, {
    wide: true,
    submitLabel: "Zapisz projekt",
    onSubmit: (data) => saveProjectFromForm(data, pid),
  });
  // Sugestia daty Go Live na podstawie terminu zakonczenia ("zgodnie z terminami zakonczenia
  // projektu") - tylko gdy pole Go Live jest jeszcze puste, zeby nie nadpisywac wartosci
  // wpisanej juz recznie. Parsuje/formatuje samodzielnie (parseDateInput/dateDisplayVal),
  // zamiast liczyc na globalny focusout-reformatter (ktory nie odpalilby sie na polu Go Live,
  // bo ustawienie .value przez JS nie jest tym samym co realne opuszczenie pola przez usera).
  const terminField = $('#modalForm [name="Data_zakonczenia_planowana"]');
  const goLiveField = $('#modalForm [name="Data_go_live"]');
  terminField?.addEventListener("focusout", () => {
    if (!goLiveField || goLiveField.value.trim()) return;
    const parsed = parseDateInput(terminField.value);
    if (parsed) goLiveField.value = dateDisplayVal(parsed);
  });
}

async function saveProjectFromForm(data, pid) {
  if (!data.Nazwa || !data.Owner || !data.Data_zakonczenia_planowana) {
    alert("Uzupełnij wymagane pola: nazwa, owner, zakończenie (plan).");
    return;
  }
  const isNew = !pid;
  const existing = isNew ? {} : STATE.projectById.get(pid);
  if (!requireExisting(existing, "projekt")) return;
  const fields = {
    Nazwa: data.Nazwa, Funkcja_biura: data.Funkcja_biura, Segment: data.Segment,
    Sygnatura: data.Sygnatura, Symbol_projektu: data.Symbol_projektu,
    Nazwa_zamierzenia_budowlanego: data.Nazwa_zamierzenia_budowlanego,
    Owner: data.Owner, Kierownik_projektu: data.Kierownik_projektu, ID_Osoby_sponsora: data.ID_Osoby_sponsora,
    Priorytet: data.Priorytet,
    Tagi: data.Tagi,
    // Typ_projektu/Status/Faza/RAG_Status celowo pominiete (Faza 1, A9/A10) - Status/RAG sa
    // teraz wyliczane z sub-projektow (serwer i tak by je zignorowal, patrz strip_computed_
    // fields()), a Typ_projektu/Faza zastapione przez multiselect Typy_etapow ponizej (tylko
    // przy tworzeniu - istniejacy projekt zarzadza sub-projektami z karty projektu).
    ...(isNew ? { Typy_etapow: JSON.parse(data.Typy_etapow || "[]") } : {}),
    Data_rozpoczecia: parseDateInput(data.Data_rozpoczecia),
    Data_zakonczenia_planowana: parseDateInput(data.Data_zakonczenia_planowana),
    Data_zakonczenia_rzeczywista: parseDateInput(data.Data_zakonczenia_rzeczywista),
    Data_go_live: parseDateInput(data.Data_go_live),
    Procent_postepu: num(data.Procent_postepu_pct) / 100,
    Budzet_calkowity: num(data.Budzet_calkowity), Budzet_wydany: num(data.Budzet_wydany),
    Waluta: data.Waluta || "PLN",
    Przychod_planowany: data.Przychod_planowany ? num(data.Przychod_planowany) : null,
    Przychod_rzeczywisty: data.Przychod_rzeczywisty ? num(data.Przychod_rzeczywisty) : null,
    Szacowane_roboczogodziny: num(data.Szacowane_roboczogodziny),
    Stawka_godzinowa_srednia: num(data.Stawka_godzinowa_srednia),
    Lokalizacja_Adres: data.Lokalizacja_Adres, Miasto: data.Miasto,
    Kraj: data.Kraj, Wojewodztwo: data.Wojewodztwo, Powiat: data.Powiat, Gmina: data.Gmina,
    Miejscowosc: data.Miejscowosc, Ulica: data.Ulica, Kod_pocztowy: data.Kod_pocztowy,
    Powierzchnia_m2: data.Powierzchnia_m2 ? num(data.Powierzchnia_m2) : null,
    Liczba_jednostek: data.Liczba_jednostek ? num(data.Liczba_jednostek) : null,
    Inwestor_Klient: data.Inwestor_Klient, ID_Klienta: data.ID_Klienta, Opis: data.Opis,
    Link_do_dokumentacji: existing.Link_do_dokumentacji || "",
    Data_ostatniej_aktualizacji: new Date(),
    Komentarz: data.Komentarz,
  };
  const saved = await persistEntity({ isNew, endpoint: "/api/projekty", id: pid, fields, dateFields: DATE_FIELDS.projects, errorLabel: "projekt" });
  if (!saved) return;
  if (isNew) { STATE.projects.push(saved); STATE.projectById.set(saved.ID_Projektu, saved); }
  else { Object.assign(existing, saved); }
  closeModal();
  renderAll();
  openProjectDetail(saved.ID_Projektu);
}

async function releaseProject(pid) {
  const p = STATE.projectById.get(pid);
  if (!requireExisting(p, "projekt")) return;
  if (!confirm(`Zwolnić projekt "${p.Nazwa}"? Usunie to Ciebie jako Ownera/Kierownika projektu i Twoje przypisanie do zespołu - projekt wróci do stanu nieprzypisanego, gotowy dla kogoś innego.`)) return;
  let saved;
  try {
    saved = await apiPost(`/api/projekty/${pid}/zwolnij`, {});
  } catch (e) {
    alert("Nie udało się zwolnić projektu: " + e.message);
    return;
  }
  Object.assign(p, saved);
  STATE.assignments = STATE.assignments.filter(a => !(a.ID_Projektu === pid && a.ID_Osoby === STATE.me.personId));
  closeDetail();
  renderAll();
}

// "Przypisz projekt" (Faza 2, A16, warsztat 22.07.2026) - odwrotnosc releaseProject() powyzej:
// COO/Admin przepisuje projekt na nowa osobe (np. przy odejsciu poprzedniego prowadzacego).
function openAssignProjectForm(pid) {
  const p = STATE.projectById.get(pid);
  if (!requireExisting(p, "projekt")) return;
  const body = `
    <div class="empty-hint full" style="grid-column:1/-1">Ustawi wskazaną osobę jako Ownera i Kierownika projektu oraz utworzy jej przypisanie (jeśli jeszcze go nie ma). Istniejące przypisanie poprzedniego prowadzącego NIE zostanie usunięte - zrób to osobno w sekcji „Zespół projektu”, jeśli potrzebne.</div>
    ${fSelect("Nowy Owner / Kierownik projektu *", "ID_Osoby", teamOptionsPairs(), "")}
  `;
  openModal(`Przypisz projekt „${p.Nazwa}”`, body, {
    submitLabel: "Przypisz",
    onSubmit: (data) => saveAssignProjectFromForm(data, pid),
  });
}

async function saveAssignProjectFromForm(data, pid) {
  if (!data.ID_Osoby) { alert("Wybierz osobę."); return; }
  const p = STATE.projectById.get(pid);
  const personName = STATE.teamById.get(data.ID_Osoby)?.Imie_i_nazwisko || data.ID_Osoby;
  if (!confirm(`Przypisać projekt „${p.Nazwa}” do „${personName}”? Ustawi ją jako Ownera i Kierownika projektu.`)) return;
  let saved;
  try {
    saved = await apiPost(`/api/projekty/${pid}/przypisz`, { ID_Osoby: data.ID_Osoby });
  } catch (e) {
    alert("Nie udało się przypisać projektu: " + e.message);
    return;
  }
  Object.assign(p, saved);
  closeModal();
  // Serwer moglo dodac nowy wiersz przypisania (jesli osoba jeszcze nie byla przypisana) -
  // pelny reload jest tu prostszy niz zgadywanie, czy INSERT faktycznie sie wykonal.
  await loadFromApi();
  renderAll();
  openProjectDetail(pid);
}

// "Polacz projekty" (Faza 1, A3, warsztat 22.07.2026) - narzedzie administracyjne dla COO/Admin
// do reczengo scalania dzis rozjechanych wierszy tego samego tematu (np. "konkurs 97 = projekt
// Wieliszew") pod jeden master. Nieodwracalne (usuwa oprozniowe zrodlowe wiersze projekty po
// stronie serwera), stad podwojne potwierdzenie (etykieta submitu + confirm()).
function openMergeProjectsForm(masterPid) {
  const master = STATE.projectById.get(masterPid);
  if (!requireExisting(master, "projekt")) return;
  const others = STATE.projects.filter(p => p.ID_Projektu !== masterPid);
  const body = `
    <div class="empty-hint full" style="grid-column:1/-1">
      Wybrane projekty zostaną scalone w <b>${esc(master.Nazwa)}</b> (${esc(masterPid)}): ich
      sub-projekty/zadania/przypisania/ryzyka/raporty/podwykonawcy/checklisty przejdą pod ten
      projekt, a opróżnione wiersze źródłowe zostaną <b>trwale usunięte</b>. Operacja jest
      nieodwracalna.
    </div>
    ${fCheckboxGroup("Projekty źródłowe do połączenia", "zrodlowe", others.map(p => [p.ID_Projektu, `${p.Nazwa} (${p.ID_Projektu})`]), [])}
  `;
  openModal(`Połącz projekty w „${master.Nazwa}”`, body, {
    submitLabel: "Połącz (nieodwracalne)",
    onSubmit: (data) => saveMergeProjectsFromForm(data, masterPid),
  });
}

async function saveMergeProjectsFromForm(data, masterPid) {
  const zrodlowe = JSON.parse(data.zrodlowe || "[]");
  if (!zrodlowe.length) { alert("Wybierz przynajmniej jeden projekt źródłowy."); return; }
  const master = STATE.projectById.get(masterPid);
  const names = zrodlowe.map(id => STATE.projectById.get(id)?.Nazwa || id).join(", ");
  if (!confirm(`Na pewno połączyć [${names}] w „${master.Nazwa}”? Źródłowe wiersze projektów zostaną trwale usunięte (ich dane przejdą pod ten projekt). Tej operacji NIE można cofnąć.`)) return;
  try {
    await apiPost(`/api/projekty/${masterPid}/polacz`, { zrodlowe });
  } catch (e) {
    alert("Nie udało się połączyć projektów: " + e.message);
    return;
  }
  closeModal();
  // Scalanie dotyka zbyt wielu tabel naraz (harmonogram/tickety/przypisania/ryzyka/raporty/
  // podwykonawcy/checklisty), zeby recznie rekoncyliowac kazda z osobna w STATE - pelny
  // reload z /api/bootstrap jest tu prostszy i bezpieczniejszy niz osiem osobnych patchy.
  await loadFromApi();
  renderAll();
  openProjectDetail(masterPid);
}

async function deleteProject(pid) {
  if (!confirm("Usunąć projekt wraz z powiązanymi przypisaniami, harmonogramem, kamieniami milowymi i ryzykami? Tej operacji nie można cofnąć.")) return;
  if (!await deleteEntity(`/api/projekty/${pid}`, "projekt")) return;
  STATE.projects = STATE.projects.filter(p => p.ID_Projektu !== pid);
  STATE.assignments = STATE.assignments.filter(a => a.ID_Projektu !== pid);
  STATE.tasks = STATE.tasks.filter(t => t.ID_Projektu !== pid);
  STATE.milestones = STATE.milestones.filter(m => m.ID_Projektu !== pid);
  STATE.risks = STATE.risks.filter(r => r.ID_Projektu !== pid);
  STATE.statusReports = STATE.statusReports.filter(r => r.ID_Projektu !== pid);
  STATE.tickets = STATE.tickets.filter(t => t.ID_Projektu !== pid);
  STATE.subcontractorAssignments = STATE.subcontractorAssignments.filter(a => a.ID_Projektu !== pid);
  STATE.projectById.delete(pid);
  closeDetail();
  renderAll();
}

/* ---------- Formularz: Osoba w zespole ---------- */
function canManageAvatar(personId) {
  // Mirror _can_manage_avatar() w server.py - wlasne zdjecie kazdy, cudze tylko COO/Admin.
  // Celowo INNA regula niz can("update", "zespol") (create-only dla Architekt_PM od tej sesji) -
  // przeslanie WLASNEGO zdjecia to nie edycja cudzych danych HR, ktorej ta restrykcja dotyczy.
  return FULL_ACCESS_ROLES.includes(STATE.me.role) || STATE.me.personId === personId;
}
function avatarRowHtml(t, oid) {
  const circle = t.Zdjecie_URL
    ? `<span class="avatar-circle large has-photo"><img src="${esc(t.Zdjecie_URL)}" alt=""></span>`
    : `<span class="avatar-circle large" style="background:var(--${personColorSlot(t.Imie_i_nazwisko)})">${esc(initials(t.Imie_i_nazwisko))}</span>`;
  return `<div class="avatar-upload-row" data-avatar-row="${esc(oid)}">
    ${circle}
    <div class="avatar-upload-actions">
      <label class="avatar-upload-btn">Wybierz zdjęcie<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-avatar-file="${esc(oid)}" hidden></label>
      ${t.Zdjecie_URL ? `<button type="button" class="icon-btn danger" data-avatar-remove="${esc(oid)}">Usuń zdjęcie</button>` : ""}
    </div>
  </div>`;
}
function avatarSectionHtml(t, oid) {
  if (!oid || !canManageAvatar(oid)) return "";
  return `<div class="form-section-title">Zdjęcie profilowe</div>${avatarRowHtml(t, oid)}`;
}
function refreshAvatarRow(personId) {
  const row = document.querySelector(`[data-avatar-row="${personId}"]`);
  const person = STATE.teamById.get(personId);
  if (row && person) row.outerHTML = avatarRowHtml(person, personId);
}
async function uploadAvatar(personId, file) {
  const formData = new FormData();
  formData.append("photo", file);
  const resp = await fetch(`/api/zespol/${personId}/avatar`, { method: "POST", headers: { "X-Requested-With": "fetch" }, body: formData });
  if (!resp.ok) {
    let message = "Nie udało się przesłać zdjęcia.";
    try { const err = await resp.json(); if (err.error) message = err.error; } catch (e) { /* brak JSON w odpowiedzi bledu */ }
    alert(message);
    return;
  }
  const { Zdjecie_URL } = await resp.json();
  const person = STATE.teamById.get(personId);
  if (person) person.Zdjecie_URL = Zdjecie_URL;
  refreshAvatarRow(personId);
  renderAll();
}
async function removeAvatar(personId) {
  try {
    await apiDelete(`/api/zespol/${personId}/avatar`);
  } catch (e) {
    alert("Nie udało się usunąć zdjęcia: " + e.message);
    return;
  }
  const person = STATE.teamById.get(personId);
  if (person) person.Zdjecie_URL = null;
  refreshAvatarRow(personId);
  renderAll();
}

function openTeamForm(oid = null) {
  const t = oid ? STATE.teamById.get(oid) : {};
  if (!requireExisting(t, "osoba")) return;
  const body = `
    ${avatarSectionHtml(t, oid)}
    ${fInput("Imię i nazwisko *", "Imie_i_nazwisko", t.Imie_i_nazwisko, "text", "required")}
    ${fInput("Stanowisko / rola", "Stanowisko_Rola", t.Stanowisko_Rola)}
    ${fSelect("Dział", "Dzial", pairs(DZIALY), t.Dzial)}
    ${fInput("Email", "Email", t.Email, "email")}
    ${fInput("Telefon", "Telefon", t.Telefon)}
    ${fInput("Dostępność FTE (%)", "Dostepnosc_FTE_procent", t.Dostepnosc_FTE_procent ?? 100, "number", "min=0 max=100")}
    ${fInput("Stawka godzinowa (PLN/h)", "Stawka_godzinowa", t.Stawka_godzinowa, "number", "min=0 step=0.01")}
    ${fSelect("Aktywny", "Aktywny", [["Tak", "Tak"], ["Nie", "Nie"]], t.Aktywny || "Tak")}
  `;
  openModal(oid ? "Edytuj osobę" : "Nowa osoba w zespole", body, {
    submitLabel: "Zapisz osobę",
    onSubmit: (data) => saveTeamFromForm(data, oid),
  });
}

async function saveTeamFromForm(data, oid) {
  if (!data.Imie_i_nazwisko) { alert("Podaj imię i nazwisko."); return; }
  const isNew = !oid;
  const existing = isNew ? {} : STATE.teamById.get(oid);
  if (!requireExisting(existing, "osoba")) return;
  const fields = {
    Imie_i_nazwisko: data.Imie_i_nazwisko, Stanowisko_Rola: data.Stanowisko_Rola,
    Dzial: data.Dzial, Email: data.Email, Telefon: data.Telefon,
    Dostepnosc_FTE_procent: num(data.Dostepnosc_FTE_procent, 100),
    Stawka_godzinowa: data.Stawka_godzinowa ? num(data.Stawka_godzinowa) : null,
    Data_dolaczenia: existing.Data_dolaczenia || new Date(),
    Aktywny: data.Aktywny,
  };
  const saved = await persistEntity({ isNew, endpoint: "/api/zespol", id: oid, fields, dateFields: DATE_FIELDS.team, errorLabel: "osoba" });
  if (!saved) return;
  if (isNew) { STATE.team.push(saved); STATE.teamById.set(saved.ID_Osoby, saved); }
  else { Object.assign(existing, saved); }
  closeModal();
  renderAll();
  openPersonDetail(saved.ID_Osoby);
}

async function deleteTeamMember(oid) {
  if (!confirm("Usunąć osobę? Powiązane przypisania do projektów zostaną również usunięte.")) return;
  if (!await deleteEntity(`/api/zespol/${oid}`, "osoba")) return;
  STATE.team = STATE.team.filter(t => t.ID_Osoby !== oid);
  STATE.assignments = STATE.assignments.filter(a => a.ID_Osoby !== oid);
  STATE.tasks.forEach(t => { if (t.ID_Osoby_odpowiedzialnej === oid) t.ID_Osoby_odpowiedzialnej = null; });
  STATE.tickets.forEach(t => { if (t.ID_Osoby_przypisanej === oid) t.ID_Osoby_przypisanej = null; });
  STATE.milestones.forEach(m => { if (m.ID_Osoby_odpowiedzialnej === oid) m.ID_Osoby_odpowiedzialnej = null; });
  STATE.risks.forEach(r => { if (r.ID_Osoby_wlasciciela === oid) r.ID_Osoby_wlasciciela = null; });
  STATE.teamById.delete(oid);
  closeDetail();
  renderAll();
}

/* ---------- Formularz: Przypisanie do projektu ---------- */
function openAssignmentForm(pid, aid = null) {
  const a = aid ? STATE.assignments.find(x => x.ID_Przypisania === aid) : {};
  if (!requireExisting(a, "przypisanie")) return;
  const body = `
    ${fSelect("Osoba *", "ID_Osoby", teamOptionsPairs(), a.ID_Osoby)}
    ${fSelect("Rola w projekcie", "Rola_w_projekcie", pairs(ROLE_W_PROJEKCIE), a.Rola_w_projekcie || "Czlonek zespolu")}
    ${fInput("Zaangażowanie (%)", "Procent_zaangazowania", a.Procent_zaangazowania ?? 50, "number", "min=0 max=200")}
    ${fInput("Data od", "Data_od", a.Data_od || dateInputVal(new Date()), "date")}
    ${fInput("Data do", "Data_do", a.Data_do, "date")}
    ${fSelect("Status", "Status", [["Aktywny", "Aktywny"], ["Zakonczony", "Zakończony"]], a.Status || "Aktywny")}
  `;
  openModal(aid ? "Edytuj przypisanie" : "Dodaj osobę do zespołu projektu", body, {
    submitLabel: "Zapisz",
    onSubmit: (data) => saveAssignmentFromForm(data, pid, aid),
  });
}

async function saveAssignmentFromForm(data, pid, aid) {
  if (!data.ID_Osoby) { alert("Wybierz osobę."); return; }
  const isNew = !aid;
  const existing = isNew ? {} : STATE.assignments.find(x => x.ID_Przypisania === aid);
  if (!requireExisting(existing, "przypisanie")) return;
  const fields = {
    ID_Projektu: pid, ID_Osoby: data.ID_Osoby,
    Rola_w_projekcie: data.Rola_w_projekcie, Procent_zaangazowania: num(data.Procent_zaangazowania),
    Data_od: parseDateInput(data.Data_od), Data_do: parseDateInput(data.Data_do), Status: data.Status,
  };
  const saved = await persistEntity({ isNew, endpoint: "/api/przypisania", id: aid, fields, dateFields: DATE_FIELDS.assignments, errorLabel: "przypisanie" });
  if (!saved) return;
  if (isNew) STATE.assignments.push(saved);
  else Object.assign(existing, saved);
  closeModal();
  renderAll();
  openProjectDetail(pid);
}

async function deleteAssignment(aid, pid) {
  if (!confirm("Usunąć to przypisanie z zespołu projektu?")) return;
  if (!await deleteEntity(`/api/przypisania/${aid}`, "przypisanie")) return;
  STATE.assignments = STATE.assignments.filter(a => a.ID_Przypisania !== aid);
  renderAll();
  openProjectDetail(pid);
}

/* ---------- Formularz: Etap harmonogramu (Gantt) ---------- */
function openTaskForm(pid, tid = null) {
  const t = tid ? STATE.tasks.find(x => x.ID_Zadania === tid) : {};
  if (!requireExisting(t, "etap")) return;
  const currentPid = pid || t.ID_Projektu || "";
  const body = `
    ${!pid ? fSelect("Projekt *", "ID_Projektu", [["", "— wybierz —"],
        ...STATE.projects.filter(p => can("create", "harmonogram", { ID_Projektu: p.ID_Projektu })).map(p => [p.ID_Projektu, p.Nazwa])],
        currentPid) : ""}
    ${fInput("Nazwa etapu *", "Nazwa_zadania", t.Nazwa_zadania, "text", "required")}
    ${fSelect("Typ etapu (sub-projektu)", "Typ_etapu", [["", "— brak —"], ...labelPairsFor("Typ_etapu")], t.Typ_etapu)}
    ${fSelect("Kategoria", "Kategoria", [["", "— wybierz —"], ...pairs(KATEGORIE_ZADAN)], t.Kategoria)}
    ${fSelect("Odpowiedzialny", "ID_Osoby_odpowiedzialnej", teamOptionsPairs(), t.ID_Osoby_odpowiedzialnej)}
    ${fInput("Start (plan) *", "Data_start_plan", t.Data_start_plan, "date", "required")}
    ${fInput("Koniec (plan) *", "Data_koniec_plan", t.Data_koniec_plan, "date", "required")}
    ${fInput("% ukończenia", "Procent_ukonczenia_pct", t.Procent_ukonczenia != null ? Math.round(t.Procent_ukonczenia * 100) : 0, "number", "min=0 max=100")}
    ${fSelect("Status", "Status", pairs(TASK_STATUSES), t.Status || "Nie rozpoczete")}
    ${fSelect("RAG status", "RAG_Status", [["", "— brak —"], ["Zielony", "Zielony"], ["Zolty", "Żółty"], ["Czerwony", "Czerwony"]], t.RAG_Status)}
    ${fSelect("Priorytet", "Priorytet", pairs(PRIORYTETY), t.Priorytet || "Sredni")}
    ${fSelect("Kamień milowy", "Kamien_milowy", [["Nie", "Nie"], ["Tak", "Tak"]], t.Kamien_milowy || "Nie")}
    ${fTextarea("Uwagi", "Uwagi", t.Uwagi)}
  `;
  openModal(tid ? "Edytuj etap harmonogramu" : "Nowy etap harmonogramu", body, {
    wide: true,
    submitLabel: "Zapisz etap",
    onSubmit: (data) => saveTaskFromForm(data, pid, tid),
  });
}

async function saveTaskFromForm(data, pid, tid) {
  const finalPid = pid || data.ID_Projektu;
  if (!finalPid || !data.Nazwa_zadania || !data.Data_start_plan || !data.Data_koniec_plan) {
    alert("Uzupełnij projekt, nazwę etapu oraz daty start/koniec (plan).");
    return;
  }
  const isNew = !tid;
  const existing = isNew ? {} : STATE.tasks.find(x => x.ID_Zadania === tid);
  if (!requireExisting(existing, "etap")) return;
  const fields = {
    ID_Projektu: finalPid, Nazwa_zadania: data.Nazwa_zadania, Kategoria: data.Kategoria,
    Typ_etapu: data.Typ_etapu || null,
    ID_Osoby_odpowiedzialnej: data.ID_Osoby_odpowiedzialnej || null,
    Data_start_plan: parseDateInput(data.Data_start_plan), Data_koniec_plan: parseDateInput(data.Data_koniec_plan),
    Data_start_rzeczywista: existing.Data_start_rzeczywista || null, Data_koniec_rzeczywista: existing.Data_koniec_rzeczywista || null,
    Procent_ukonczenia: num(data.Procent_ukonczenia_pct) / 100,
    ID_Zadania_poprzedzajacego: existing.ID_Zadania_poprzedzajacego || null,
    Kamien_milowy: data.Kamien_milowy, Status: data.Status, RAG_Status: data.RAG_Status || null,
    Priorytet: data.Priorytet, Uwagi: data.Uwagi,
  };
  const saved = await persistEntity({ isNew, endpoint: "/api/harmonogram", id: tid, fields, dateFields: DATE_FIELDS.tasks, errorLabel: "etap" });
  if (!saved) return;
  if (isNew) STATE.tasks.push(saved);
  else Object.assign(existing, saved);
  closeModal();
  renderAll();
  if (pid) openProjectDetail(pid); else renderGanttView();
}

async function deleteTask(tid, pid) {
  if (!confirm("Usunąć ten etap harmonogramu?")) return;
  if (!await deleteEntity(`/api/harmonogram/${tid}`, "etap")) return;
  STATE.tasks = STATE.tasks.filter(t => t.ID_Zadania !== tid);
  STATE.tickets.forEach(t => { if (t.ID_Etapu === tid) t.ID_Etapu = null; });
  STATE.taskStages = STATE.taskStages.filter(e => e.ID_Zadania !== tid); // mirror ON DELETE CASCADE w schema.sql
  renderAll();
  openProjectDetail(pid);
}

/* ---------- Formularz: Zadanie (ticket) przypisane do osoby ---------- */
// Faza 1 (B5): jeden ticket moze byc przypiety do kilku etapow naraz (zadania_etapy, n:n) -
// zastepuje dawny pojedynczy <select> ID_Etapu (mirror fCheckboxGroup, patrz openTicketForm).
function stageCheckboxPairs(pid) {
  return tasksForProject(pid).map(t => [t.ID_Zadania, t.Nazwa_zadania]);
}

function renderCommentText(tresc) {
  // Wzmianki wstawiane przez autocomplete jako "@[Imie Nazwisko]" (patrz pickMentionSuggestion) -
  // wyodrebnij PRZED esc() calej tresci (zeby nie zgubic ich w HTML-escapowanym tekscie), a
  // dopiero po esc() wstaw z powrotem jako stylowany span (kazde imie tez indywidualnie esc(),
  // ale dopiero raz, PO glownym escapowaniu - w przeciwnym razie znaki typu "&" w imieniu
  // zostalyby podwojnie zescapowane, gdyby robic to w jednym kroku regex.replace()).
  const names = [];
  const withPlaceholders = (tresc || "").replace(/@\[([^\]]+)\]/g, (_, name) => {
    names.push(name);
    return ` MENTION${names.length - 1} `;
  });
  let escaped = esc(withPlaceholders);
  names.forEach((name, i) => {
    escaped = escaped.replace(` MENTION${i} `, `<span class="mention-tag">@${esc(name)}</span>`);
  });
  return escaped;
}

function commentItemHtml(c) {
  return `<div class="comment-item">
    <div class="comment-meta"><b>${esc(c.Autor || "—")}</b> · ${esc(fmtDateTime(c.Data_utworzenia))}</div>
    <div class="comment-text">${renderCommentText(c.Tresc)}</div>
  </div>`;
}

async function loadTicketComments(tid) {
  const listEl = $(`[data-comments-list="${tid}"]`);
  if (!listEl) return;
  try {
    const comments = await apiGet(`/api/zadania_tickety/${tid}/komentarze`);
    listEl.innerHTML = comments.map(commentItemHtml).join("") || `<div class="kpi-sub">Brak komentarzy.</div>`;
  } catch (e) {
    listEl.innerHTML = `<div class="kpi-sub">Nie udało się wczytać komentarzy: ${esc(e.message)}</div>`;
  }
}

async function addTicketComment(tid) {
  const textarea = $(`[data-comment-input="${tid}"]`);
  const tresc = textarea.value.trim();
  if (!tresc) return;
  const btn = $(`[data-add-comment="${tid}"]`);
  btn.disabled = true;
  try {
    const comment = await apiPost(`/api/zadania_tickety/${tid}/komentarze`, { Tresc: tresc });
    const listEl = $(`[data-comments-list="${tid}"]`);
    const emptyHint = listEl.querySelector(".kpi-sub");
    if (emptyHint) emptyHint.remove();
    listEl.insertAdjacentHTML("beforeend", commentItemHtml(comment));
    textarea.value = "";
  } catch (e) {
    alert("Nie udało się dodać komentarza: " + e.message);
  } finally {
    btn.disabled = false;
  }
}

// Sekcja komentarzy jest wlasnym, niezaleznym od reszty formularza cyklem zycia (wlasny
// fetch/POST, wlasny re-render tylko tej jednej sekcji) - dodanie komentarza NIE powinno
// zapisywac/zamykac reszty niezapisanych zmian w formularzu ticketu, wiec przycisk jest
// type="button" (nie submit modala) z osobnym handlerem, nie modalSubmitHandler.
function ticketCommentsSectionHtml(t, tid) {
  if (!tid) return "";
  const editable = can("update", "zadania_tickety", t);
  return `
    <div class="form-section-title">Komentarze</div>
    <div class="comment-list" data-comments-list="${esc(tid)}">Wczytywanie…</div>
    ${editable ? `
      <div class="comment-add">
        <textarea data-comment-input="${esc(tid)}" rows="2" placeholder="Dodaj komentarz…"></textarea>
        <button type="button" data-add-comment="${esc(tid)}">Dodaj komentarz</button>
      </div>` : ""}
  `;
}

/* ---------- @wzmianki w komentarzach (autocomplete) ---------- */
const mentionState = { textarea: null, triggerStart: -1, matches: [], activeIndex: 0 };

function ensureMentionEl() {
  let el = document.getElementById("mentionSuggestions");
  if (el) return el;
  el = document.createElement("div");
  el.id = "mentionSuggestions";
  el.className = "mention-suggestions";
  document.body.appendChild(el);
  return el;
}

function closeMentionSuggestions() {
  const el = document.getElementById("mentionSuggestions");
  if (el) el.classList.remove("open");
  mentionState.textarea = null;
  mentionState.triggerStart = -1;
  mentionState.matches = [];
}

function positionMentionSuggestions(textarea) {
  const el = document.getElementById("mentionSuggestions");
  const r = textarea.getBoundingClientRect();
  const w = el.offsetWidth || 240, h = el.offsetHeight || 220;
  let left = r.left, top = r.bottom + 4;
  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
  if (top + h > window.innerHeight - 8) top = r.top - h - 4;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function renderMentionSuggestions() {
  const el = ensureMentionEl();
  if (!mentionState.matches.length) { el.classList.remove("open"); return; }
  el.innerHTML = mentionState.matches.map((t, i) =>
    `<button type="button" class="mention-suggestion ${i === mentionState.activeIndex ? "active" : ""}" data-mention-pick="${esc(t.Imie_i_nazwisko)}">${esc(t.Imie_i_nazwisko)}</button>`
  ).join("");
  el.classList.add("open");
  positionMentionSuggestions(mentionState.textarea);
}

function updateMentionSuggestions(textarea) {
  const cursor = textarea.selectionStart;
  let triggerStart = mentionState.textarea === textarea ? mentionState.triggerStart : -1;
  if (triggerStart === -1 || cursor <= triggerStart) {
    // szukaj nowego wyzwalacza "@" bezposrednio przed lub w trakcie budowania wzmianki -
    // musi byc na poczatku pola albo poprzedzony spacja/nowa linia (nie w srodku slowa/e-maila)
    const before = textarea.value.slice(0, cursor);
    const atIndex = before.lastIndexOf("@");
    if (atIndex === -1) { closeMentionSuggestions(); return; }
    const precedingChar = before[atIndex - 1];
    if (atIndex !== 0 && precedingChar !== " " && precedingChar !== "\n") { closeMentionSuggestions(); return; }
    triggerStart = atIndex;
  }
  const query = textarea.value.slice(triggerStart + 1, cursor);
  // Imiona zawieraja spacje ("Jan B") - dopoki filtrowanie po substring nadal daje jakies
  // dopasowania, wzmianka "trwa" mimo spacji w query; pusty wynik (i niepusty query) oznacza,
  // ze uzytkownik po prostu kontynuuje zwykle zdanie zaczynajace sie od "@", nie wzmianke.
  if (query.includes("\n") || query.length > 40) { closeMentionSuggestions(); return; }
  const q = query.trim().toLowerCase();
  const matches = STATE.team.filter(t => (t.Imie_i_nazwisko || "").toLowerCase().includes(q)).slice(0, 6);
  if (!matches.length && query.length > 0) { closeMentionSuggestions(); return; }
  mentionState.textarea = textarea;
  mentionState.triggerStart = triggerStart;
  mentionState.matches = matches;
  mentionState.activeIndex = 0;
  renderMentionSuggestions();
}

function pickMentionSuggestion(name) {
  const { textarea, triggerStart } = mentionState;
  if (!textarea || triggerStart < 0) return;
  const cursor = textarea.selectionStart;
  const before = textarea.value.slice(0, triggerStart);
  const after = textarea.value.slice(cursor);
  const insertion = `@[${name}] `;
  textarea.value = before + insertion + after;
  const newCursor = before.length + insertion.length;
  textarea.focus();
  textarea.setSelectionRange(newCursor, newCursor);
  closeMentionSuggestions();
}

function openTicketForm(pid, tid = null, seed = null) {
  const t = tid ? STATE.tickets.find(x => x.ID_Tickietu === tid) : (seed || {});
  if (!requireExisting(t, "ticket")) return;
  const currentPid = pid || t.ID_Projektu || "";
  // Nowy ticket: domyslnie zglasza go zalogowana osoba (decyzja z pytania: auto-wypelnij,
  // edytowalne recznie). Istniejacy ticket bez zapisanego zglaszajacego (sprzed tej funkcji)
  // zostaje pusty - edycja starego ticketu nie powinna po cichu "przypisywac" go do osoby,
  // ktora akurat teraz go otwiera.
  const zglaszajacyDefault = tid ? t.ID_Osoby_zglaszajacej : STATE.me.personId;
  const body = `
    ${tid && can("create", "zadania_tickety", { ID_Projektu: t.ID_Projektu }) ? `<div style="grid-column:1/-1;text-align:right;margin-bottom:-8px">
      <button type="button" class="icon-btn" data-duplicate-ticket="${esc(tid)}">📋 Duplikuj to zadanie</button>
    </div>` : ""}
    ${!pid ? fSelect("Projekt *", "ID_Projektu", [["", "— wybierz —"],
        ...STATE.projects.filter(p => can("create", "zadania_tickety", { ID_Projektu: p.ID_Projektu })).map(p => [p.ID_Projektu, p.Nazwa])],
        currentPid) : ""}
    ${fInput("Tytuł *", "Tytul", t.Tytul, "text", "required")}
    ${fSelect("Zgłaszający", "ID_Osoby_zglaszajacej", teamOptionsPairs(), zglaszajacyDefault)}
    ${fSelect("Przypisana osoba (zespół wewnętrzny)", "ID_Osoby_przypisanej", assignedTeamOptionsPairs(currentPid, t.ID_Osoby_przypisanej), t.ID_Osoby_przypisanej)}
    ${fSelect("Wspomagający (opcjonalnie)", "ID_Osoby_wspomagajacej", assignedTeamOptionsPairs(currentPid, t.ID_Osoby_wspomagajacej), t.ID_Osoby_wspomagajacej)}
    ${fSelect("Podwykonawca (jeśli zlecone branżyście)", "ID_Podwykonawcy", subcontractorOptionsPairs(), t.ID_Podwykonawcy)}
    ${fInput("Wycena podwykonawcy", "Wycena_podwykonawcy", t.Wycena_podwykonawcy, "number", "min=0 step=0.01")}
    ${fInput("Termin *", "Termin", t.Termin, "date", "required")}
    ${fCheckboxGroup("Powiązane etapy / sub-projekty", "Etapy", stageCheckboxPairs(currentPid), tid ? stageIdsForTicket(tid) : (seed?._seedStageIds || []))}
    ${fSelect("Priorytet", "Priorytet", pairs(PRIORYTETY), t.Priorytet || "Sredni")}
    ${fSelect("Status", "Status", pairs(STATUSY_TICKIETOW), t.Status || "Backlog")}
    ${fInput("Szacowane roboczogodziny", "Szacowane_roboczogodziny", t.Szacowane_roboczogodziny, "number", "min=0 step=0.5")}
    ${fInput("Rzeczywiste roboczogodziny", "Rzeczywiste_roboczogodziny", t.Rzeczywiste_roboczogodziny, "number", "min=0 step=0.5")}
    ${fTextarea("Opis zadania", "Opis", t.Opis)}
    ${ticketCommentsSectionHtml(t, tid)}
  `;
  openModal(tid ? "Edytuj zadanie (ticket)" : "Nowe zadanie (ticket)", body, {
    wide: true,
    submitLabel: "Zapisz zadanie",
    onSubmit: (data) => saveTicketFromForm(data, pid, tid),
  });
  if (tid) loadTicketComments(tid);
  // bez ustalonego projektu (formularz otwarty z zakladki Zadania) - po wybraniu projektu
  // zawez liste "Przypisana osoba"/"Wspomagający" do zespolu przypisanego do tego projektu
  // (obie uzywaja tego samego assignedTeamOptionsPairs co "Przypisana osoba"), i odswiez etapy.
  // "Zgłaszający" nie wymaga odswiezenia - teamOptionsPairs() to pelna lista, niezalezna od
  // wybranego projektu (zglaszac moze kazdy, nie tylko zespol projektu).
  if (!pid) {
    const projSelect = $('#modalForm [name="ID_Projektu"]');
    projSelect?.addEventListener("change", (e) => {
      const chosenPid = e.target.value;
      const osobaSelect = $('#modalForm [name="ID_Osoby_przypisanej"]');
      const wspomagajacySelect = $('#modalForm [name="ID_Osoby_wspomagajacej"]');
      const etapGroup = $('#modalForm [data-checkbox-group="Etapy"]');
      osobaSelect.innerHTML = optionsHtml(assignedTeamOptionsPairs(chosenPid, osobaSelect.value), osobaSelect.value);
      wspomagajacySelect.innerHTML = optionsHtml(assignedTeamOptionsPairs(chosenPid, wspomagajacySelect.value), wspomagajacySelect.value);
      // Zaznaczone etapy naleza do POPRZEDNIEGO projektu - reset do pustego zaznaczenia zamiast
      // proby zachowania (innego projektu ID_Zadania i tak by tu nie pasowaly).
      if (etapGroup) etapGroup.outerHTML = fCheckboxGroup("Powiązane etapy / sub-projekty", "Etapy", stageCheckboxPairs(chosenPid), []);
    });
  }
}

async function saveTicketFromForm(data, pid, tid) {
  const finalPid = pid || data.ID_Projektu;
  if (!finalPid || !data.Tytul || !data.Termin || (!data.ID_Osoby_przypisanej && !data.ID_Podwykonawcy)) {
    alert("Uzupełnij projekt, tytuł, termin oraz przypisz osobę z zespołu lub podwykonawcę.");
    return;
  }
  const isNew = !tid;
  const existing = isNew ? {} : STATE.tickets.find(x => x.ID_Tickietu === tid);
  if (!requireExisting(existing, "ticket")) return;
  const fields = {
    ID_Projektu: finalPid,
    // ID_Etapu porzucony w Faza 1 (B5) - zastapiony przez zadania_etapy (n:n), patrz "Etapy"
    // nizej. Kolumna zostaje w schemacie (deprecated), ale nowy kod jej juz nie ustawia.
    Tytul: data.Tytul, Opis: data.Opis, ID_Osoby_przypisanej: data.ID_Osoby_przypisanej || null,
    ID_Osoby_zglaszajacej: data.ID_Osoby_zglaszajacej || null,
    ID_Osoby_wspomagajacej: data.ID_Osoby_wspomagajacej || null,
    ID_Podwykonawcy: data.ID_Podwykonawcy || null,
    Wycena_podwykonawcy: data.ID_Podwykonawcy ? num(data.Wycena_podwykonawcy) : null,
    Data_utworzenia: existing.Data_utworzenia || new Date(),
    Termin: parseDateInput(data.Termin),
    Szacowane_roboczogodziny: num(data.Szacowane_roboczogodziny),
    Rzeczywiste_roboczogodziny: num(data.Rzeczywiste_roboczogodziny),
    Priorytet: data.Priorytet, Status: data.Status,
    Data_zakonczenia: deriveTicketCompletionDate(data.Status, existing.Data_zakonczenia),
    Etapy: JSON.parse(data.Etapy || "[]"),
  };
  const saved = await persistEntity({ isNew, endpoint: "/api/zadania_tickety", id: tid, fields, dateFields: DATE_FIELDS.tickets, errorLabel: "zadanie" });
  if (!saved) return;
  // Odswiez lokalny STATE.taskStages tak samo jak serwer (DELETE stare + INSERT nowe dla tego
  // ticketu) - inaczej multiselect etapow pokazywalby stan sprzed zapisu az do nastepnego
  // pelnego przeladowania (/api/bootstrap).
  STATE.taskStages = STATE.taskStages.filter(e => e.ID_Tickietu !== saved.ID_Tickietu);
  STATE.taskStages.push(...fields.Etapy.map(eid => ({ ID_Tickietu: saved.ID_Tickietu, ID_Zadania: eid })));
  if (isNew) STATE.tickets.push(saved);
  else Object.assign(existing, saved);
  closeModal();
  renderAll();
  if (pid) openProjectDetail(pid); else renderTickets();
}

async function deleteTicket(tid, pid) {
  if (!confirm("Usunąć to zadanie (ticket)?")) return;
  if (!await deleteEntity(`/api/zadania_tickety/${tid}`, "zadanie")) return;
  STATE.tickets = STATE.tickets.filter(t => t.ID_Tickietu !== tid);
  STATE.taskStages = STATE.taskStages.filter(e => e.ID_Tickietu !== tid); // mirror ON DELETE CASCADE w schema.sql
  renderAll();
  openProjectDetail(pid);
}

function duplicateTicket(tid) {
  // Otwiera formularz NOWEGO ticketu wypelniony wartosciami zrodlowego - na wprost zyczenie
  // uzytkownika ("zadania niewiele sie od siebie roznia, a trzeba wprowadzac wszystko od
  // zera"). Termin/Status/Rzeczywiste_roboczogodziny/Data_zakonczenia celowo NIE sa kopiowane -
  // to pola, ktore niemal zawsze roznia sie miedzy "podobnymi" zadaniami (a przekopiowanie
  // minionego Terminu tworzyloby duplikat od razu oznaczony jako opozniony).
  const t = STATE.tickets.find(x => x.ID_Tickietu === tid);
  if (!requireExisting(t, "ticket")) return;
  const seed = {
    ...t,
    Tytul: (t.Tytul || "") + " (kopia)",
    Termin: null, Status: "Backlog", Rzeczywiste_roboczogodziny: null, Data_zakonczenia: null,
    _seedStageIds: stageIdsForTicket(tid),
  };
  closeModal();
  openTicketForm(t.ID_Projektu, null, seed);
}

/* ---------- Formularz: Ryzyko / problem ---------- */
function openRiskForm(pid, rid = null) {
  const r = rid ? STATE.risks.find(x => x.ID === rid) : {};
  if (!requireExisting(r, "wpis ryzyka")) return;
  const body = `
    ${fSelect("Typ *", "Typ", pairs(TYP_RYZYKA), r.Typ || "Ryzyko")}
    ${fTextarea("Opis *", "Opis", r.Opis)}
    ${fSelect("Kategoria", "Kategoria", pairs(KATEGORIE_RYZYK), r.Kategoria)}
    ${fSelect("Prawdopodobienstwo", "Prawdopodobienstwo", pairs(PRIORYTETY), r.Prawdopodobienstwo)}
    ${fSelect("Wplyw", "Wplyw", pairs(PRIORYTETY), r.Wplyw)}
    ${fSelect("Priorytet", "Priorytet", pairs(PRIORYTETY), r.Priorytet)}
    ${fSelect("Właściciel", "ID_Osoby_wlasciciela", teamOptionsPairs(), r.ID_Osoby_wlasciciela)}
    ${fTextarea("Plan mitygacji", "Plan_mitygacji", r.Plan_mitygacji)}
    ${fSelect("Status", "Status", pairs(STATUS_RYZYKA), r.Status || "Otwarte")}
  `;
  openModal(rid ? "Edytuj ryzyko / problem" : "Nowe ryzyko / problem", body, {
    wide: true,
    submitLabel: "Zapisz",
    onSubmit: (data) => saveRiskFromForm(data, pid, rid),
  });
}

async function saveRiskFromForm(data, pid, rid) {
  if (!data.Opis) {
    alert("Uzupełnij opis ryzyka/problemu.");
    return;
  }
  const isNew = !rid;
  const existing = isNew ? {} : STATE.risks.find(x => x.ID === rid);
  if (!requireExisting(existing, "wpis ryzyka")) return;
  const fields = {
    ID_Projektu: pid, Typ: data.Typ, Opis: data.Opis, Kategoria: data.Kategoria,
    Prawdopodobienstwo: data.Prawdopodobienstwo, Wplyw: data.Wplyw, Priorytet: data.Priorytet,
    ID_Osoby_wlasciciela: data.ID_Osoby_wlasciciela || null, Plan_mitygacji: data.Plan_mitygacji,
    Status: data.Status,
    Data_identyfikacji: existing.Data_identyfikacji || new Date(),
    Data_zamkniecia: data.Status === "Zamkniete" ? (existing.Data_zamkniecia || new Date()) : null,
  };
  const saved = await persistEntity({ isNew, endpoint: "/api/ryzyka_i_problemy", id: rid, fields, dateFields: DATE_FIELDS.risks, errorLabel: "ryzyko/problem" });
  if (!saved) return;
  if (isNew) STATE.risks.push(saved);
  else Object.assign(existing, saved);
  closeModal();
  renderAll();
  openProjectDetail(pid);
}

async function deleteRisk(rid, pid) {
  if (!confirm("Usunąć to ryzyko/problem?")) return;
  if (!await deleteEntity(`/api/ryzyka_i_problemy/${rid}`, "ryzyko/problem")) return;
  STATE.risks = STATE.risks.filter(x => x.ID !== rid);
  renderAll();
  openProjectDetail(pid);
}

/* ---------- Formularz: Kamień milowy ---------- */
function openMilestoneForm(pid, mid = null) {
  const m = mid ? STATE.milestones.find(x => x.ID_Kamienia === mid) : {};
  if (!requireExisting(m, "kamień milowy")) return;
  const body = `
    ${fInput("Nazwa kamienia milowego *", "Nazwa_kamienia", m.Nazwa_kamienia, "text", "required")}
    ${fInput("Data planowana *", "Data_planowana", m.Data_planowana, "date", "required")}
    ${fInput("Data rzeczywista", "Data_rzeczywista", m.Data_rzeczywista, "date")}
    ${fSelect("Odpowiedzialny", "ID_Osoby_odpowiedzialnej", teamOptionsPairs(), m.ID_Osoby_odpowiedzialnej)}
    ${fSelect("Status", "Status", pairs(STATUSY_KAMIENI_MILOWYCH), m.Status || "Nie rozpoczete")}
  `;
  openModal(mid ? "Edytuj kamień milowy" : "Nowy kamień milowy", body, {
    submitLabel: "Zapisz",
    onSubmit: (data) => saveMilestoneFromForm(data, pid, mid),
  });
}

async function saveMilestoneFromForm(data, pid, mid) {
  if (!data.Nazwa_kamienia || !data.Data_planowana) {
    alert("Uzupełnij nazwę i datę planowaną kamienia milowego.");
    return;
  }
  const isNew = !mid;
  const existing = isNew ? {} : STATE.milestones.find(x => x.ID_Kamienia === mid);
  if (!requireExisting(existing, "kamień milowy")) return;
  const fields = {
    ID_Projektu: pid, Nazwa_kamienia: data.Nazwa_kamienia,
    Data_planowana: parseDateInput(data.Data_planowana),
    Data_rzeczywista: parseDateInput(data.Data_rzeczywista),
    ID_Osoby_odpowiedzialnej: data.ID_Osoby_odpowiedzialnej || null,
    Status: data.Status,
  };
  const saved = await persistEntity({ isNew, endpoint: "/api/kamienie_milowe", id: mid, fields, dateFields: DATE_FIELDS.milestones, errorLabel: "kamień milowy" });
  if (!saved) return;
  if (isNew) STATE.milestones.push(saved);
  else Object.assign(existing, saved);
  closeModal();
  renderAll();
  openProjectDetail(pid);
}

async function deleteMilestone(mid, pid) {
  if (!confirm("Usunąć ten kamień milowy?")) return;
  if (!await deleteEntity(`/api/kamienie_milowe/${mid}`, "kamień milowy")) return;
  STATE.milestones = STATE.milestones.filter(x => x.ID_Kamienia !== mid);
  renderAll();
  openProjectDetail(pid);
}

/* ---------- Formularz: Checklista projektu ---------- */
function openChecklistItemForm(pid, id = null) {
  const c = id ? STATE.checklists.find(x => x.ID_Pozycji === id) : {};
  if (!requireExisting(c, "pozycja checklisty")) return;
  const body = `${fTextarea("Treść *", "Tresc", c.Tresc)}`;
  openModal(id ? "Edytuj pozycję checklisty" : "Nowa pozycja checklisty", body, {
    submitLabel: "Zapisz",
    onSubmit: (data) => saveChecklistItemFromForm(data, pid, id),
  });
}

async function saveChecklistItemFromForm(data, pid, id) {
  if (!data.Tresc) { alert("Podaj treść pozycji."); return; }
  const isNew = !id;
  const existing = isNew ? {} : STATE.checklists.find(x => x.ID_Pozycji === id);
  if (!requireExisting(existing, "pozycja checklisty")) return;
  const fields = { ID_Projektu: pid, Tresc: data.Tresc };
  const saved = await persistEntity({ isNew, endpoint: "/api/checklisty_projektow", id, fields, errorLabel: "pozycji checklisty" });
  if (!saved) return;
  if (isNew) STATE.checklists.push(saved);
  else Object.assign(existing, saved);
  closeModal();
  renderAll();
  openProjectDetail(pid);
}

async function deleteChecklistItem(id, pid) {
  if (!confirm("Usunąć pozycję checklisty?")) return;
  if (!await deleteEntity(`/api/checklisty_projektow/${id}`, "pozycji checklisty")) return;
  STATE.checklists = STATE.checklists.filter(c => c.ID_Pozycji !== id);
  renderAll();
  openProjectDetail(pid);
}

async function toggleChecklistItem(id, pid) {
  // Optymistyczny update bez modala (mirror moveTicketToStatus) - zaznaczenie/odznaczenie
  // pozycji to jednoklikowa akcja, nie zasluguje na otwieranie formularza.
  const item = STATE.checklists.find(c => c.ID_Pozycji === id);
  if (!item) return;
  if (!can("update", "checklisty_projektow", item)) return;
  const prev = item.Wykonano;
  item.Wykonano = prev === "Tak" ? "Nie" : "Tak";
  openProjectDetail(pid);
  try {
    const saved = await apiPut(`/api/checklisty_projektow/${id}`, { Wykonano: item.Wykonano });
    Object.assign(item, saved);
  } catch (e) {
    item.Wykonano = prev;
    alert("Nie udało się zaktualizować pozycji checklisty: " + e.message);
  }
  openProjectDetail(pid);
}

/* ---------- Formularz: Działka ewidencyjna (Faza 2, A7) ---------- */
function openParcelForm(pid, id = null) {
  const d = id ? STATE.parcels.find(x => x.ID_Dzialki === id) : {};
  if (!requireExisting(d, "działka")) return;
  const body = `
    ${fInput("Numer działki *", "Numer_dzialki", d.Numer_dzialki, "text", "required")}
    ${fInput("Obręb", "Obreb", d.Obreb)}
    ${fInput("Identyfikator działki", "Identyfikator_dzialki", d.Identyfikator_dzialki)}
  `;
  openModal(id ? "Edytuj działkę" : "Nowa działka", body, {
    submitLabel: "Zapisz",
    onSubmit: (data) => saveParcelFromForm(data, pid, id),
  });
}

async function saveParcelFromForm(data, pid, id) {
  if (!data.Numer_dzialki) { alert("Podaj numer działki."); return; }
  const isNew = !id;
  const existing = isNew ? {} : STATE.parcels.find(x => x.ID_Dzialki === id);
  if (!requireExisting(existing, "działka")) return;
  const fields = { ID_Projektu: pid, Numer_dzialki: data.Numer_dzialki, Obreb: data.Obreb, Identyfikator_dzialki: data.Identyfikator_dzialki };
  const saved = await persistEntity({ isNew, endpoint: "/api/dzialki", id, fields, errorLabel: "działki" });
  if (!saved) return;
  if (isNew) STATE.parcels.push(saved);
  else Object.assign(existing, saved);
  closeModal();
  renderAll();
  openProjectDetail(pid);
}

async function deleteParcel(id, pid) {
  if (!confirm("Usunąć tę działkę?")) return;
  if (!await deleteEntity(`/api/dzialki/${id}`, "działki")) return;
  STATE.parcels = STATE.parcels.filter(d => d.ID_Dzialki !== id);
  renderAll();
  openProjectDetail(pid);
}

/* ---------- Formularz: Podwykonawca (biblioteka) ---------- */
function openSubcontractorForm(sid = null) {
  const s = sid ? STATE.subcontractorById.get(sid) : {};
  if (!requireExisting(s, "podwykonawca")) return;
  const body = `
    ${fInput("Nazwa (firma lub osoba) *", "Nazwa", s.Nazwa, "text", "required")}
    ${fSelect("Branża *", "Branza", pairs(BRANZE_PODWYKONAWCOW), s.Branza)}
    ${fSelect("Typ współpracy", "Typ_wspolpracy", pairs(TYPY_WSPOLPRACY), s.Typ_wspolpracy || "Projektant branzowy")}
    ${fInput("Osoba kontaktowa", "Osoba_kontaktowa", s.Osoba_kontaktowa)}
    ${fInput("Email", "Email", s.Email, "email")}
    ${fInput("Telefon", "Telefon", s.Telefon)}
    <label class="f-label">NIP
      <div style="display:flex;gap:6px">
        <input name="NIP" type="text" value="${esc(s.NIP || "")}" placeholder="1234567890" style="flex:1" maxlength="13">
        <button type="button" class="icon-btn" data-ceidg-fetch style="white-space:nowrap">Pobierz z CEIDG</button>
        <button type="button" class="icon-btn" data-ceidg-settings title="Ustawienia tokena API CEIDG">⚙</button>
      </div>
      <span class="ceidg-status" data-ceidg-status></span>
    </label>
    ${fInput("Miasto", "Miasto", s.Miasto)}
    ${fSelect("Ocena", "Ocena", pairs(OCENY_PODWYKONAWCOW), s.Ocena || "Brak oceny")}
    ${fSelect("Status", "Status", pairs(STATUSY_PODWYKONAWCOW), s.Status || "Aktywny")}
    ${fTextarea("Uwagi", "Uwagi", s.Uwagi)}
  `;
  openModal(sid ? "Edytuj podwykonawcę" : "Nowy podwykonawca (biblioteka)", body, {
    wide: true,
    submitLabel: "Zapisz podwykonawcę",
    onSubmit: (data) => saveSubcontractorFromForm(data, sid),
  });
}

async function saveSubcontractorFromForm(data, sid) {
  if (!data.Nazwa || !data.Branza) { alert("Podaj nazwę i branżę."); return; }
  const isNew = !sid;
  const existing = isNew ? {} : STATE.subcontractorById.get(sid);
  if (!requireExisting(existing, "podwykonawca")) return;
  const fields = {
    Nazwa: data.Nazwa, Branza: data.Branza, Typ_wspolpracy: data.Typ_wspolpracy,
    Osoba_kontaktowa: data.Osoba_kontaktowa, Email: data.Email, Telefon: data.Telefon, NIP: data.NIP,
    Miasto: data.Miasto, Ocena: data.Ocena, Status: data.Status, Uwagi: data.Uwagi,
  };
  const saved = await persistEntity({ isNew, endpoint: "/api/podwykonawcy", id: sid, fields, errorLabel: "podwykonawcy" });
  if (!saved) return;
  if (isNew) { STATE.subcontractors.push(saved); STATE.subcontractorById.set(saved.ID_Podwykonawcy, saved); }
  else { Object.assign(existing, saved); }
  closeModal();
  renderAll();
  openSubcontractorDetail(saved.ID_Podwykonawcy);
}

async function deleteSubcontractor(sid) {
  if (!confirm("Usunąć podwykonawcę z biblioteki? Powiązane przypisania do projektów zostaną również usunięte.")) return;
  if (!await deleteEntity(`/api/podwykonawcy/${sid}`, "podwykonawca")) return;
  STATE.subcontractors = STATE.subcontractors.filter(s => s.ID_Podwykonawcy !== sid);
  STATE.subcontractorAssignments = STATE.subcontractorAssignments.filter(a => a.ID_Podwykonawcy !== sid);
  STATE.tickets.forEach(t => { if (t.ID_Podwykonawcy === sid) t.ID_Podwykonawcy = null; });
  STATE.subcontractorById.delete(sid);
  closeDetail();
  renderAll();
}

/* ================================================================== VIEW: KLIENCI (Inwestorzy/Klienci) */
function clientStatusBadge(status) { return status === "Aktywny" ? "good" : "muted"; }
function contactsForClient(cid) { return STATE.clientContacts.filter(c => c.ID_Klienta === cid); }

function renderClients() {
  const cards = STATE.clients.map(c => `
    <div class="team-card" data-open-client="${esc(c.ID_Klienta)}">
      <div class="tc-name">${esc(c.Nazwa)}</div>
      <div class="tc-role">${esc(c.Typ || "—")} · ${esc(c.Miasto || "—")}</div>
      <div style="margin:6px 0">${badge(c.Status || "—", clientStatusBadge(c.Status))}</div>
      <div class="pc-row"><span>NIP</span><b>${esc(c.NIP || "—")}</b></div>
      <div class="pc-row"><span>Opiekun (zarząd)</span><b>${c.ID_Osoby_opiekuna ? esc(personName(c.ID_Osoby_opiekuna)) : "—"}</b></div>
      <div class="tc-projects">
        <div style="font-weight:600;color:var(--text-primary);margin-bottom:2px">Kontakty (${contactsForClient(c.ID_Klienta).length})</div>
        ${contactsForClient(c.ID_Klienta).map(k => `<div>• ${esc(k.Imie_i_nazwisko)}${k.Stanowisko ? " — " + esc(k.Stanowisko) : ""}</div>`).join("") || "<div>Brak kontaktów.</div>"}
      </div>
    </div>`);
  $("#view-klienci").innerHTML = `
    <div class="section-head"><h2>Klienci</h2>${can("create", "klienci") ? `<button data-add-client="1">+ Dodaj klienta</button>` : ""}</div>
    <div class="empty-hint" style="margin-bottom:12px">Karta klienta/inwestora (NIP, dane, kontakty) pod przyszłe fakturowanie — zarządzanie zarezerwowane dla zarządu (COO/Admin).</div>
    <div class="team-grid">${cards.join("") || `<div class="empty-hint">Brak klientów w rejestrze${can("create", "klienci") ? ` — kliknij „+ Dodaj klienta”.` : "."}</div>`}</div>
  `;
}

function openClientDetail(cid) {
  const c = STATE.clientById.get(cid);
  if (!c) return;
  const contacts = contactsForClient(cid);
  $("#dpContent").innerHTML = `
    <div style="display:flex;justify-content:flex-end;gap:6px">
      ${can("update", "klienci", c) ? `<button class="icon-btn" data-edit-client="${esc(cid)}">Edytuj</button>` : ""}
      ${can("delete", "klienci", c) ? `<button class="icon-btn danger" data-delete-client="${esc(cid)}">Usuń</button>` : ""}
    </div>
    <h2>${esc(c.Nazwa)}</h2>
    <div class="dp-sub">${esc(c.Typ || "—")}</div>
    <div style="margin-bottom:6px">${badge(c.Status || "—", clientStatusBadge(c.Status))}</div>
    <div class="dp-grid">
      <div><div class="k">NIP</div><div class="v">${esc(c.NIP || "—")}</div></div>
      <div><div class="k">Numer KRS</div><div class="v">${esc(c.KRS || "—")}</div></div>
      <div><div class="k">REGON</div><div class="v">${esc(c.Regon || "—")}</div></div>
      <div><div class="k">Adres siedziby</div><div class="v">${esc(c.Adres_siedziby || "—")}</div></div>
      <div><div class="k">Miasto</div><div class="v">${esc(c.Miasto || "—")}</div></div>
      <div><div class="k">Email</div><div class="v">${esc(c.Email || "—")}</div></div>
      <div><div class="k">Telefon</div><div class="v">${esc(c.Telefon || "—")}</div></div>
      <div><div class="k">Opiekun (zarząd)</div><div class="v">${c.ID_Osoby_opiekuna ? esc(personName(c.ID_Osoby_opiekuna)) : "—"}</div></div>
    </div>
    ${c.Uwagi ? `<div class="dp-section"><h4>Uwagi</h4><div style="font-size:13px">${esc(c.Uwagi)}</div></div>` : ""}
    <div class="dp-section">
      <div class="section-head" style="margin-bottom:8px"><h4 style="margin:0">Kontakty (${contacts.length})</h4>
        ${can("create", "kontakty_klienta", { ID_Klienta: cid }) ? `<button class="icon-btn" data-add-contact="${esc(cid)}">+ Dodaj kontakt</button>` : ""}</div>
      ${contacts.map(k => `
        <div class="dp-list-item" ${can("update", "kontakty_klienta", k) ? `data-edit-contact="${esc(k.ID_Kontaktu)}" data-client="${esc(cid)}" style="cursor:pointer"` : ""}>
          <div class="item-actions">
            ${can("delete", "kontakty_klienta", k) ? `<button class="icon-btn danger" data-delete-contact="${esc(k.ID_Kontaktu)}" data-client="${esc(cid)}">Usuń</button>` : ""}
          </div>
          <div class="title">${esc(k.Imie_i_nazwisko)}${k.Stanowisko ? " — " + esc(k.Stanowisko) : ""}</div>
          <div class="meta">${k.Email ? esc(k.Email) : ""}${k.Email && k.Telefon ? " · " : ""}${k.Telefon ? esc(k.Telefon) : ""}</div>
        </div>`).join("") || `<div class="kpi-sub">Brak kontaktów.</div>`}
    </div>
  `;
  $("#overlay").classList.add("open");
  $("#detailPanel").classList.add("open");
}

function openClientForm(cid = null) {
  const c = cid ? STATE.clientById.get(cid) : {};
  if (!requireExisting(c, "klient")) return;
  const body = `
    ${fInput("Nazwa *", "Nazwa", c.Nazwa, "text", "required")}
    ${fSelect("Typ", "Typ", pairs(["Inwestor", "Klient", "Deweloper", "Inne"]), c.Typ || "Klient")}
    <label class="f-label">NIP
      <div style="display:flex;gap:6px">
        <input name="NIP" type="text" value="${esc(c.NIP || "")}" placeholder="1234567890" style="flex:1" maxlength="13">
        <button type="button" class="icon-btn" data-ceidg-fetch style="white-space:nowrap">Pobierz z CEIDG</button>
        <button type="button" class="icon-btn" data-ceidg-settings title="Ustawienia tokena API CEIDG">⚙</button>
      </div>
      <span class="ceidg-status" data-ceidg-status></span>
    </label>
    <label class="f-label">Numer KRS
      <div style="display:flex;gap:6px">
        <input name="KRS" type="text" value="${esc(c.KRS || "")}" placeholder="0000123456" style="flex:1" maxlength="10">
        <button type="button" class="icon-btn" data-krs-fetch style="white-space:nowrap">Pobierz z KRS</button>
      </div>
      <span class="krs-status" data-krs-status></span>
    </label>
    ${fInput("REGON", "Regon", c.Regon)}
    ${fInput("Adres siedziby", "Adres_siedziby", c.Adres_siedziby)}
    ${fInput("Miasto", "Miasto", c.Miasto)}
    ${fInput("Email", "Email", c.Email, "email")}
    ${fInput("Telefon", "Telefon", c.Telefon)}
    ${fSelect("Opiekun (zarząd)", "ID_Osoby_opiekuna", boardMemberOptionsPairs(), c.ID_Osoby_opiekuna)}
    ${fSelect("Status", "Status", pairs(["Aktywny", "Nieaktywny"]), c.Status || "Aktywny")}
    ${fTextarea("Uwagi", "Uwagi", c.Uwagi)}
  `;
  openModal(cid ? "Edytuj klienta" : "Nowy klient", body, {
    wide: true,
    submitLabel: "Zapisz klienta",
    onSubmit: (data) => saveClientFromForm(data, cid),
  });
}

async function saveClientFromForm(data, cid) {
  if (!data.Nazwa) { alert("Podaj nazwę klienta."); return; }
  const isNew = !cid;
  const existing = isNew ? {} : STATE.clientById.get(cid);
  if (!requireExisting(existing, "klient")) return;
  const fields = {
    Nazwa: data.Nazwa, Typ: data.Typ, NIP: data.NIP, KRS: data.KRS, Regon: data.Regon,
    Adres_siedziby: data.Adres_siedziby, Miasto: data.Miasto, Email: data.Email, Telefon: data.Telefon,
    ID_Osoby_opiekuna: data.ID_Osoby_opiekuna, Status: data.Status, Uwagi: data.Uwagi,
  };
  const saved = await persistEntity({ isNew, endpoint: "/api/klienci", id: cid, fields, errorLabel: "klienta" });
  if (!saved) return;
  if (isNew) { STATE.clients.push(saved); STATE.clientById.set(saved.ID_Klienta, saved); }
  else { Object.assign(existing, saved); }
  closeModal();
  renderAll();
  openClientDetail(saved.ID_Klienta);
}

async function deleteClient(cid) {
  if (!confirm("Usunąć klienta z rejestru? Powiązane kontakty zostaną również usunięte, a projekty stracą powiązanie z tym klientem.")) return;
  if (!await deleteEntity(`/api/klienci/${cid}`, "klienta")) return;
  STATE.clients = STATE.clients.filter(c => c.ID_Klienta !== cid);
  STATE.clientContacts = STATE.clientContacts.filter(k => k.ID_Klienta !== cid);
  STATE.projects.forEach(p => { if (p.ID_Klienta === cid) p.ID_Klienta = null; });
  STATE.clientById.delete(cid);
  closeDetail();
  renderAll();
}

function openContactForm(cid, kid = null) {
  const k = kid ? STATE.clientContacts.find(x => x.ID_Kontaktu === kid) : {};
  if (!requireExisting(k, "kontakt")) return;
  const body = `
    ${fInput("Imię i nazwisko *", "Imie_i_nazwisko", k.Imie_i_nazwisko, "text", "required")}
    ${fInput("Stanowisko", "Stanowisko", k.Stanowisko)}
    ${fInput("Email", "Email", k.Email, "email")}
    ${fInput("Telefon", "Telefon", k.Telefon)}
  `;
  openModal(kid ? "Edytuj kontakt" : "Nowy kontakt", body, {
    submitLabel: "Zapisz kontakt",
    onSubmit: (data) => saveContactFromForm(data, cid, kid),
  });
}

async function saveContactFromForm(data, cid, kid) {
  if (!data.Imie_i_nazwisko) { alert("Podaj imię i nazwisko kontaktu."); return; }
  const isNew = !kid;
  const existing = isNew ? {} : STATE.clientContacts.find(x => x.ID_Kontaktu === kid);
  if (!requireExisting(existing, "kontakt")) return;
  const fields = {
    ID_Klienta: cid, Imie_i_nazwisko: data.Imie_i_nazwisko, Stanowisko: data.Stanowisko,
    Email: data.Email, Telefon: data.Telefon,
  };
  const saved = await persistEntity({ isNew, endpoint: "/api/kontakty_klienta", id: kid, fields, errorLabel: "kontaktu" });
  if (!saved) return;
  if (isNew) STATE.clientContacts.push(saved);
  else Object.assign(existing, saved);
  closeModal();
  renderAll();
  openClientDetail(cid);
}

async function deleteContact(kid, cid) {
  if (!confirm("Usunąć kontakt?")) return;
  if (!await deleteEntity(`/api/kontakty_klienta/${kid}`, "kontaktu")) return;
  STATE.clientContacts = STATE.clientContacts.filter(k => k.ID_Kontaktu !== kid);
  renderAll();
  openClientDetail(cid);
}

/* ================================================================== VIEW: IDEAPOOL */
function ideaStatusBadge(status) {
  if (status === "Zaakceptowany") return "good";
  if (status === "Odrzucony") return "critical";
  if (status === "W rozwazaniu") return "warning";
  return "muted"; // Zgloszony
}

function renderIdeapool() {
  const list = [...STATE.ideapool].sort((a, b) => (b.Data_zgloszenia?.getTime() || 0) - (a.Data_zgloszenia?.getTime() || 0));
  $("#view-ideapool").innerHTML = `
    <div class="section-head">
      <h2>Ideapool</h2>
      <button data-add-idea="1">+ Zgłoś pomysł</button>
    </div>
    <div class="empty-hint" style="margin-bottom:12px">Zgłoszenia wewnętrznych inicjatyw i projektów rozwojowych — może zgłosić każdy, ocenia zarząd (COO/Admin).</div>
    <div class="panel">
      ${list.map(i => `
        <div class="dp-list-item" ${can("update", "ideapool", i) ? `data-edit-idea="${esc(i.ID_Pomyslu)}" style="cursor:pointer"` : ""}>
          <div class="item-actions">
            ${can("delete", "ideapool", i) ? `<button class="icon-btn danger" data-delete-idea="${esc(i.ID_Pomyslu)}">Usuń</button>` : ""}
          </div>
          <div class="title">${esc(i.Tytul)} ${badge(i.Status, ideaStatusBadge(i.Status))}</div>
          <div class="meta">${i.Kategoria ? esc(i.Kategoria) + " · " : ""}zgłosił: ${esc(personName(i.ID_Osoby_zglaszajacej))} · ${fmtDate(i.Data_zgloszenia)}</div>
          ${i.Opis ? `<div class="meta" style="margin-top:4px">${esc(i.Opis)}</div>` : ""}
          ${i.Uwagi_zarzadu ? `<div class="meta" style="margin-top:4px"><i>Uwagi zarządu: ${esc(i.Uwagi_zarzadu)}</i></div>` : ""}
        </div>`).join("") || `<div class="empty-hint">Brak zgłoszeń — kliknij „+ Zgłoś pomysł”.</div>`}
    </div>
  `;
}

function openIdeaForm(id = null) {
  const i = id ? STATE.ideapool.find(x => x.ID_Pomyslu === id) : {};
  if (!requireExisting(i, "pomysł")) return;
  // Status/Uwagi zarzadu tylko dla COO/Admin przy edycji - can_write() na backendzie i tak
  // odrzuci probe zapisu tych pol od kogokolwiek innego, ale nie ma sensu ich nawet pokazywac
  // osobie, ktora zglasza wlasny, jeszcze nieoceniony pomysl.
  const showBoardFields = id && FULL_ACCESS_ROLES.includes(STATE.me.role);
  const body = `
    ${fInput("Tytuł *", "Tytul", i.Tytul, "text", "required")}
    ${fInput("Kategoria", "Kategoria", i.Kategoria)}
    ${fTextarea("Opis", "Opis", i.Opis)}
    ${showBoardFields ? fSelect("Status", "Status", pairs(["Zgloszony", "W rozwazaniu", "Zaakceptowany", "Odrzucony"]), i.Status || "Zgloszony") : ""}
    ${showBoardFields ? fTextarea("Uwagi zarządu", "Uwagi_zarzadu", i.Uwagi_zarzadu) : ""}
  `;
  openModal(id ? "Edytuj pomysł" : "Zgłoś pomysł", body, {
    submitLabel: id ? "Zapisz" : "Zgłoś pomysł",
    onSubmit: (data) => saveIdeaFromForm(data, id, showBoardFields),
  });
}

async function saveIdeaFromForm(data, id, includeBoardFields) {
  if (!data.Tytul) { alert("Podaj tytuł pomysłu."); return; }
  const isNew = !id;
  const existing = isNew ? {} : STATE.ideapool.find(x => x.ID_Pomyslu === id);
  if (!requireExisting(existing, "pomysł")) return;
  const fields = { Tytul: data.Tytul, Kategoria: data.Kategoria, Opis: data.Opis };
  if (includeBoardFields) { fields.Status = data.Status; fields.Uwagi_zarzadu = data.Uwagi_zarzadu; }
  const saved = await persistEntity({ isNew, endpoint: "/api/ideapool", id, fields, dateFields: DATE_FIELDS.ideapool, errorLabel: "pomysłu" });
  if (!saved) return;
  if (isNew) STATE.ideapool.push(saved);
  else Object.assign(existing, saved);
  closeModal();
  renderAll();
}

async function deleteIdea(id) {
  if (!confirm("Usunąć zgłoszenie pomysłu?")) return;
  if (!await deleteEntity(`/api/ideapool/${id}`, "pomysłu")) return;
  STATE.ideapool = STATE.ideapool.filter(x => x.ID_Pomyslu !== id);
  renderAll();
}

/* ---------- Integracja z CEIDG (pobieranie danych firmy po NIP) ---------- */
const CEIDG_TOKEN_KEY = "ip_ceidg_api_token";
function getCeidgToken() { try { return localStorage.getItem(CEIDG_TOKEN_KEY) || ""; } catch (e) { return ""; } }
function setCeidgToken(v) { try { v ? localStorage.setItem(CEIDG_TOKEN_KEY, v) : localStorage.removeItem(CEIDG_TOKEN_KEY); } catch (e) { /* brak dostepu do localStorage */ } }

function openCeidgTokenForm() {
  const body = `
    <div class="dp-sub" style="margin-bottom:10px;line-height:1.5">
      Token pobierzesz na <b>biznes.gov.pl</b> po zalogowaniu Profilem Zaufanym / aplikacją mObywatel,
      w usłudze „Wniosek o dostęp do raportów CEIDG” (API v2 Hurtowni Danych CEIDG i biznes.gov.pl).
      Token jest zapisywany wyłącznie lokalnie w tej przeglądarce — nigdzie nie jest wysyłany poza
      bezpośrednie zapytanie do dane.biznes.gov.pl.
    </div>
    ${fInput("Token API CEIDG (Bearer)", "CeidgToken", getCeidgToken(), "text", "placeholder=\"wklej token…\"")}
  `;
  openModal("Ustawienia CEIDG API", body, {
    submitLabel: "Zapisz token",
    onSubmit: (data) => { setCeidgToken((data.CeidgToken || "").trim()); closeModal(); },
  });
}

async function fetchCeidgByNip(nip, token) {
  const resp = await fetch(`https://dane.biznes.gov.pl/api/ceidg/v2/firmy?nip=${encodeURIComponent(nip)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (resp.status === 401 || resp.status === 403) throw new Error("AUTH");
  if (!resp.ok) return null;
  const data = await resp.json();
  const rec = Array.isArray(data?.firmy) ? data.firmy[0] : (Array.isArray(data) ? data[0] : (data?.firma || data));
  if (!rec) return null;
  const adres = rec.adresDzialalnosci || rec.adresGlownegoMiejscaWykonywaniaDzialalnosci || rec.adres || {};
  const nazwa = rec.nazwa
    || [rec.wlasciciel?.imie, rec.wlasciciel?.nazwisko].filter(Boolean).join(" ")
    || [rec.imie, rec.nazwisko].filter(Boolean).join(" ")
    || null;
  const miasto = adres.miasto || adres.miejscowosc || rec.miasto || null;
  const status = rec.status || rec.statusDzialalnosci || null;
  return { nazwa: nazwa || null, miasto: miasto || null, status: status || null, raw: rec };
}

async function handleCeidgFetchClick(btn) {
  const label = btn.closest("label");
  const nipInput = label.querySelector('input[name="NIP"]');
  const statusEl = label.querySelector("[data-ceidg-status]");
  const nip = (nipInput.value || "").replace(/\D/g, "");
  if (nip.length !== 10) {
    statusEl.textContent = "Podaj poprawny NIP (10 cyfr).";
    statusEl.style.color = "var(--status-critical)";
    return;
  }
  const token = getCeidgToken();
  if (!token) { openCeidgTokenForm(); return; }
  statusEl.textContent = "Pobieranie z CEIDG…";
  statusEl.style.color = "var(--text-muted)";
  btn.disabled = true;
  try {
    const result = await fetchCeidgByNip(nip, token);
    if (!result) {
      statusEl.textContent = "Nie znaleziono firmy o podanym NIP w CEIDG.";
      statusEl.style.color = "var(--status-warning, #a86a00)";
      return;
    }
    const form = btn.closest("form");
    if (result.nazwa && form.querySelector('[name="Nazwa"]')) form.querySelector('[name="Nazwa"]').value = result.nazwa;
    if (result.miasto && form.querySelector('[name="Miasto"]')) form.querySelector('[name="Miasto"]').value = result.miasto;
    statusEl.textContent = `Pobrano${result.nazwa ? ": " + result.nazwa : ""}${result.status ? " · status: " + result.status : ""}`;
    statusEl.style.color = "var(--status-good)";
  } catch (e) {
    if (e.message === "AUTH") {
      statusEl.textContent = "Token CEIDG jest nieprawidłowy lub wygasł — kliknij ⚙, aby go zaktualizować.";
    } else {
      statusEl.textContent = "Nie udało się połączyć z CEIDG (błąd sieci lub CORS) — uzupełnij dane ręcznie.";
    }
    statusEl.style.color = "var(--status-critical)";
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Integracja z KRS (pobieranie danych spolki po numerze KRS) ---------- */
// W odroznieniu od CEIDG powyzej: oficjalne API resortu sprawiedliwosci (api-krs.ms.gov.pl)
// wyszukuje WYLACZNIE po numerze KRS, nie po NIP - potwierdzone bezposrednim zapytaniem
// (wyszukiwanie po NIP zwraca 404, brak publicznego odpowiednika). Zero tokena/klucza API
// potrzebne (w odroznieniu od CEIDG) - endpoint jest w pelni publiczny, z CORS dopuszczajacym
// dowolny origin (potwierdzone naglowkiem Access-Control-Allow-Origin).
async function fetchKrsByNumber(krs) {
  const resp = await fetch(`https://api-krs.ms.gov.pl/api/krs/OdpisAktualny/${encodeURIComponent(krs)}?rejestr=P&format=json`, {
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const dzial1 = data?.odpis?.dane?.dzial1;
  if (!dzial1) return null;
  const podmiot = dzial1.danePodmiotu || {};
  const adres = dzial1.siedzibaIAdres?.adres || {};
  const siedziba = dzial1.siedzibaIAdres?.siedziba || {};
  const adresParts = [adres.ulica, adres.nrDomu, adres.kodPocztowy, adres.miejscowosc || siedziba.miejscowosc].filter(Boolean);
  return {
    nazwa: podmiot.nazwa || null,
    nip: podmiot.identyfikatory?.nip || null,
    regon: podmiot.identyfikatory?.regon || null,
    miasto: adres.miejscowosc || siedziba.miejscowosc || null,
    adres: adresParts.length ? adresParts.join(", ") : null,
  };
}

async function handleKrsFetchClick(btn) {
  const label = btn.closest("label");
  const krsInput = label.querySelector('input[name="KRS"]');
  const statusEl = label.querySelector("[data-krs-status]");
  const digits = (krsInput.value || "").replace(/\D/g, "");
  if (!digits) {
    statusEl.textContent = "Podaj numer KRS.";
    statusEl.style.color = "var(--status-critical)";
    return;
  }
  const krs = digits.padStart(10, "0");
  statusEl.textContent = "Pobieranie z KRS…";
  statusEl.style.color = "var(--text-muted)";
  btn.disabled = true;
  try {
    const result = await fetchKrsByNumber(krs);
    if (!result) {
      statusEl.textContent = "Nie znaleziono podmiotu o podanym numerze KRS (rejestr przedsiębiorców).";
      statusEl.style.color = "var(--status-warning, #a86a00)";
      return;
    }
    const form = btn.closest("form");
    if (result.nazwa && form.querySelector('[name="Nazwa"]')) form.querySelector('[name="Nazwa"]').value = result.nazwa;
    if (result.nip && form.querySelector('[name="NIP"]')) form.querySelector('[name="NIP"]').value = result.nip;
    if (result.regon && form.querySelector('[name="Regon"]')) form.querySelector('[name="Regon"]').value = result.regon;
    if (result.adres && form.querySelector('[name="Adres_siedziby"]')) form.querySelector('[name="Adres_siedziby"]').value = result.adres;
    if (result.miasto && form.querySelector('[name="Miasto"]')) form.querySelector('[name="Miasto"]').value = result.miasto;
    krsInput.value = krs;
    statusEl.textContent = `Pobrano${result.nazwa ? ": " + result.nazwa : ""}`;
    statusEl.style.color = "var(--status-good)";
  } catch (e) {
    statusEl.textContent = "Nie udało się połączyć z KRS (błąd sieci) — uzupełnij dane ręcznie.";
    statusEl.style.color = "var(--status-critical)";
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Formularz: Przypisanie podwykonawcy do projektu ---------- */
function subcontractorOptionsPairs() {
  const sorted = [...STATE.subcontractors].sort((a, b) =>
    (a.Branza || "").localeCompare(b.Branza || "", "pl") || (a.Nazwa || "").localeCompare(b.Nazwa || "", "pl"));
  return [["", "— wybierz z biblioteki —"], ...sorted.map(s => [s.ID_Podwykonawcy, `${s.Branza} — ${s.Nazwa}`])];
}

function openSubcontractorAssignmentForm(pid, said = null) {
  const a = said ? STATE.subcontractorAssignments.find(x => x.ID_Przypisania_Podw === said) : {};
  if (!requireExisting(a, "przypisanie podwykonawcy")) return;
  const body = `
    ${fSelect("Podwykonawca (z biblioteki) *", "ID_Podwykonawcy", subcontractorOptionsPairs(), a.ID_Podwykonawcy)}
    ${fSelect("Branża (tego przypisania)", "Branza", pairs(BRANZE_PODWYKONAWCOW), a.Branza)}
    ${fTextarea("Zakres prac *", "Zakres_prac", a.Zakres_prac, "required")}
    ${fInput("Data od", "Data_od", a.Data_od, "date")}
    ${fInput("Termin planowany (Data do)", "Data_do", a.Data_do, "date")}
    ${fInput("Wartość umowy", "Wartosc_umowy", a.Wartosc_umowy, "number", "min=0 step=100")}
    ${fSelect("Status", "Status", pairs(STATUSY_PRZYPISANIA_PODW), a.Status || "Planowany")}
    ${fTextarea("Uwagi", "Uwagi", a.Uwagi)}
    <div class="empty-hint full" style="grid-column:1/-1">Nie ma podwykonawcy na liście? Dodaj go najpierw w zakładce „Podwykonawcy”.</div>
    <div class="empty-hint full" style="grid-column:1/-1">Termin rzeczywisty ustawia się automatycznie na dziś przy zmianie statusu na „Zakończony” (do mierzenia opóźnienia względem terminu planowanego).</div>
  `;
  openModal(said ? "Edytuj przypisanie podwykonawcy" : "Przypisz podwykonawcę do projektu", body, {
    wide: true,
    submitLabel: "Zapisz",
    onSubmit: (data) => saveSubcontractorAssignmentFromForm(data, pid, said),
  });
}

async function saveSubcontractorAssignmentFromForm(data, pid, said) {
  if (!data.ID_Podwykonawcy || !data.Zakres_prac) { alert("Wybierz podwykonawcę i opisz zakres prac."); return; }
  const isNew = !said;
  const existing = isNew ? {} : STATE.subcontractorAssignments.find(x => x.ID_Przypisania_Podw === said);
  if (!requireExisting(existing, "przypisanie podwykonawcy")) return;
  const sub = STATE.subcontractorById.get(data.ID_Podwykonawcy);
  const fields = {
    ID_Projektu: pid, ID_Podwykonawcy: data.ID_Podwykonawcy,
    Branza: data.Branza || sub?.Branza || "", Zakres_prac: data.Zakres_prac,
    Data_od: parseDateInput(data.Data_od), Data_do: parseDateInput(data.Data_do),
    Data_zakonczenia_rzeczywista: deriveSubAssignmentCompletionDate(data.Status, existing.Data_zakonczenia_rzeczywista),
    Wartosc_umowy: num(data.Wartosc_umowy), Waluta: existing.Waluta || "PLN", Status: data.Status, Uwagi: data.Uwagi,
  };
  const saved = await persistEntity({
    isNew, endpoint: "/api/przypisania_podwykonawcow", id: said, fields,
    dateFields: DATE_FIELDS.subcontractorAssignments, errorLabel: "przypisanie podwykonawcy",
  });
  if (!saved) return;
  if (isNew) STATE.subcontractorAssignments.push(saved);
  else Object.assign(existing, saved);
  closeModal();
  renderAll();
  openProjectDetail(pid);
}

async function deleteSubcontractorAssignment(said, pid) {
  if (!confirm("Usunąć to przypisanie podwykonawcy z projektu?")) return;
  if (!await deleteEntity(`/api/przypisania_podwykonawcow/${said}`, "przypisanie")) return;
  STATE.subcontractorAssignments = STATE.subcontractorAssignments.filter(a => a.ID_Przypisania_Podw !== said);
  renderAll();
  openProjectDetail(pid);
}

/* ================================================================== DETAIL PANEL (Karta projektu) */
function openProjectDetail(pid) {
  const p = STATE.projectById.get(pid);
  if (!p) return;
  const assigns = assignmentsForProject(pid);
  const mstones = milestonesForProject(pid).sort((a, b) => (a.Data_planowana?.getTime() || 0) - (b.Data_planowana?.getTime() || 0));
  const checklist = checklistForProject(pid);
  const risks = risksForProject(pid);
  const reports = reportsForProject(pid).slice(0, 3);
  const tasks = tasksForProject(pid);
  const subAssigns = subcontractorAssignmentsForProject(pid);
  const tickets = ticketsForProject(pid);
  const spent = num(p.Budzet_wydany), tot = num(p.Budzet_calkowity);
  const realCost = realCostForProject(pid);
  const realHours = realHoursForProject(pid);
  const margin = projectMargin(p);
  const estHours = estimatedTicketHoursForProject(pid);
  const schedVar = projectScheduleVariance(p);
  const budgVar = projectBudgetVariance(p);
  const onTimeP = projectOnTimeStats(pid);

  $("#dpContent").innerHTML = `
    <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:10px;padding-right:36px">
      <div class="type-tag" style="margin-bottom:6px">${typeTag(projectPrimaryType(p))} &nbsp;·&nbsp; ${esc(p.Segment || "")}</div>
      <div class="item-actions" style="position:static">
        <button class="icon-btn" data-goto-tasks="${esc(pid)}" title="Przejdź do zakładki Zadania, przefiltrowanej do tego projektu">Zadania →</button>
        <button class="icon-btn" data-goto-gantt="${esc(pid)}" title="Przejdź do Harmonogramu, przefiltrowanego do tego projektu">Harmonogram →</button>
        ${can("update", "projekty", p) ? `<button class="icon-btn" data-edit-project="${esc(pid)}">Edytuj</button>` : ""}
        ${(STATE.me.role === "Architekt_PM" && p.Owner === STATE.me.name) || FULL_ACCESS_ROLES.includes(STATE.me.role)
          ? `<button class="icon-btn" data-release-project="${esc(pid)}" title="Usuwa Ciebie jako Ownera/Kierownika i zdejmuje Twoje przypisanie - projekt wraca do stanu nieprzypisanego">Zwolnij projekt</button>` : ""}
        ${FULL_ACCESS_ROLES.includes(STATE.me.role)
          ? `<button class="icon-btn" data-assign-project="${esc(pid)}" title="Ustawia wskazaną osobę jako Ownera/Kierownika i tworzy jej przypisanie do projektu - np. przy odejściu poprzedniego prowadzącego">Przypisz projekt →</button>` : ""}
        ${FULL_ACCESS_ROLES.includes(STATE.me.role)
          ? `<button class="icon-btn" data-merge-projects="${esc(pid)}" title="Przenosi wszystkie sub-projekty/zadania/przypisania innych projektów pod ten (master) i usuwa opróżnione wiersze źródłowe - nieodwracalne">Połącz projekty →</button>` : ""}
        ${can("delete", "projekty", p) ? `<button class="icon-btn danger" data-delete-project="${esc(pid)}">Usuń</button>` : ""}
      </div>
    </div>
    <h2>${esc(p.Nazwa)}</h2>
    <div class="dp-sub">${esc(p.ID_Projektu)} · ${esc(p.Lokalizacja_Adres || "")}${p.Miasto ? ", " + esc(p.Miasto) : ""}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">
      ${badge(ragLabel(p.RAG_Status), ragClass(p.RAG_Status))}
      ${badge(p.Status, projectStatusClass(p.Status))}
      ${p.Priorytet ? badge("Priorytet: " + p.Priorytet, priorityBadgeClass(p.Priorytet)) : ""}
    </div>

    <div class="dp-section">
      <h4>Analityka finansowa i wydajnościowa</h4>
      <div class="kpi-grid" style="margin-bottom:0">
        <div class="kpi-tile ${margin ? (margin.margin >= 0 ? "accent-good" : "accent-critical") : ""}">
          <div class="kpi-label">Marża</div>
          <div class="kpi-value">${margin ? Math.round(margin.marginPct) + "%" : "—"}</div>
          <div class="kpi-sub">${margin ? fmtMoney(margin.margin, p.Waluta) : "brak danych o przychodzie"}</div>
        </div>
        <div class="kpi-tile ${varianceAccent(budgVar)}">
          <div class="kpi-label">Budżet vs postęp</div>
          <div class="kpi-value">${budgVar == null ? "—" : (budgVar >= 0 ? "+" : "") + Math.round(budgVar * 100) + " pp"}</div>
          <div class="kpi-sub">postęp minus % wydanego budżetu</div>
        </div>
        <div class="kpi-tile ${varianceAccent(schedVar)}">
          <div class="kpi-label">Harmonogram</div>
          <div class="kpi-value">${schedVar == null ? "—" : (schedVar >= 0 ? "+" : "") + Math.round(schedVar * 100) + " pp"}</div>
          <div class="kpi-sub">postęp minus oczekiwany wg. terminów</div>
        </div>
        <div class="kpi-tile ${estHours ? (realHours <= estHours ? "accent-good" : realHours <= estHours * 1.2 ? "accent-warning" : "accent-critical") : ""}">
          <div class="kpi-label">Efektywność godzinowa</div>
          <div class="kpi-value">${estHours ? Math.round(realHours / estHours * 100) + "%" : "—"}</div>
          <div class="kpi-sub">${estHours ? realHours.toLocaleString("pl-PL") + " / " + estHours.toLocaleString("pl-PL") + " rbh" : "brak szacunków w ticketach"}</div>
        </div>
        <div class="kpi-tile ${onTimeP.pct == null ? "" : onTimeP.pct >= 80 ? "accent-good" : "accent-warning"}">
          <div class="kpi-label">Terminowość</div>
          <div class="kpi-value">${onTimeP.pct == null ? "—" : onTimeP.pct + "%"}</div>
          <div class="kpi-sub">${onTimeP.onTimeTotal}/${onTimeP.doneTotal} zakończonych na czas</div>
        </div>
        <div class="kpi-tile ${(onTimeP.overdueStages + onTimeP.overdueTickets) > 0 ? "accent-critical" : "accent-good"}">
          <div class="kpi-label">Przekroczone terminy</div>
          <div class="kpi-value">${onTimeP.overdueStages + onTimeP.overdueTickets}</div>
          <div class="kpi-sub">${onTimeP.overdueStages} etapów · ${onTimeP.overdueTickets} ticketów</div>
        </div>
      </div>
    </div>

    <div class="dp-section">
      <h4>Dane podstawowe</h4>
      <div class="dp-grid">
        ${p.Sygnatura ? `<div><div class="k">Sygnatura</div><div class="v">${esc(p.Sygnatura)}</div></div>` : ""}
        ${p.Symbol_projektu ? `<div><div class="k">Symbol projektu</div><div class="v">${esc(p.Symbol_projektu)}</div></div>` : ""}
        ${p.Nazwa_zamierzenia_budowlanego ? `<div style="grid-column:1/-1"><div class="k">Nazwa zamierzenia budowlanego</div><div class="v">${esc(p.Nazwa_zamierzenia_budowlanego)}</div></div>` : ""}
        <div><div class="k">Funkcja biura</div><div class="v">${p.Funkcja_biura ? esc(p.Funkcja_biura) : "—"}</div></div>
        <div><div class="k">Owner</div><div class="v">${esc(p.Owner)}</div></div>
        <div><div class="k">Kierownik projektu</div><div class="v">${esc(p.Kierownik_projektu)}</div></div>
        <div><div class="k">Sponsor</div><div class="v">${p.ID_Osoby_sponsora ? esc(personName(p.ID_Osoby_sponsora)) : "—"}</div></div>
        <div><div class="k">Data rozpoczęcia</div><div class="v">${fmtDate(p.Data_rozpoczecia)}</div></div>
        <div><div class="k">Zakończenie (plan)</div><div class="v">${fmtDate(p.Data_zakonczenia_planowana)}</div></div>
        <div><div class="k">Zakończenie (rzeczywiste)</div><div class="v">${fmtDate(p.Data_zakonczenia_rzeczywista)}</div></div>
        <div><div class="k">Data „Go Live”</div><div class="v">${fmtDate(p.Data_go_live)}</div></div>
        <div><div class="k">Klient</div><div class="v">${p.ID_Klienta && STATE.clientById.get(p.ID_Klienta) ? `<span class="clickable" data-open-client="${esc(p.ID_Klienta)}" style="cursor:pointer;text-decoration:underline">${esc(STATE.clientById.get(p.ID_Klienta).Nazwa)}</span>` : esc(p.Inwestor_Klient) || "—"}</div></div>
        <div><div class="k">Powierzchnia</div><div class="v">${p.Powierzchnia_m2 != null ? p.Powierzchnia_m2.toLocaleString("pl-PL") + " m²" : "—"}</div></div>
        <div><div class="k">Liczba jednostek</div><div class="v">${p.Liczba_jednostek ?? "—"}</div></div>
        ${formatLokalizacjaUrzedowa(p) ? `<div style="grid-column:1/-1"><div class="k">Lokalizacja urzędowa</div><div class="v">${esc(formatLokalizacjaUrzedowa(p))}</div></div>` : ""}
      </div>
    </div>

    <div class="dp-section">
      <div class="section-head" style="margin-bottom:8px"><h4 style="margin:0">Działki ewidencyjne (${parcelsForProject(pid).length})</h4>
        ${can("create", "dzialki", { ID_Projektu: pid }) ? `<button class="icon-btn" data-add-parcel="${esc(pid)}">+ Dodaj działkę</button>` : ""}</div>
      ${parcelsForProject(pid).map(d => `
        <div class="dp-list-item" ${can("update", "dzialki", d) ? `data-edit-parcel="${esc(d.ID_Dzialki)}" data-project="${esc(pid)}" style="cursor:pointer"` : ""}>
          <div class="item-actions">
            ${can("delete", "dzialki", d) ? `<button class="icon-btn danger" data-delete-parcel="${esc(d.ID_Dzialki)}" data-project="${esc(pid)}">Usuń</button>` : ""}
          </div>
          <div class="title">Działka nr ${esc(d.Numer_dzialki)}</div>
          <div class="meta">${d.Obreb ? "obręb: " + esc(d.Obreb) : ""}${d.Obreb && d.Identyfikator_dzialki ? " · " : ""}${d.Identyfikator_dzialki ? "ID: " + esc(d.Identyfikator_dzialki) : ""}</div>
        </div>`).join("") || `<div class="empty-hint">Brak zarejestrowanych działek — kliknij „+ Dodaj działkę”.</div>`}
    </div>

    ${projectTags(p).length ? `<div class="tag-chips" style="margin-bottom:4px">${projectTags(p).map(t => `<span class="tag-chip">${esc(t)}</span>`).join("")}</div>` : ""}

    <div class="dp-section">
      <h4>Postęp i budżet</h4>
      <div class="pc-row"><span>Postęp realizacji</span><b>${fmtPctFraction(p.Procent_postepu)}</b></div>
      <div class="progress-track"><div class="progress-fill" style="width:${num(p.Procent_postepu) * 100}%"></div></div>
      <div class="pc-row" style="margin-top:8px"><span>Budżet wydany / całkowity</span><b>${fmtMoney(p.Budzet_wydany, p.Waluta)} / ${fmtMoney(p.Budzet_calkowity, p.Waluta)}</b></div>
      <div class="progress-track"><div class="progress-fill ${tot && spent > tot ? "over" : ""}" style="width:${tot ? Math.min(100, spent / tot * 100) : 0}%"></div></div>
      ${p.Szacowane_roboczogodziny ? `
      <div class="dp-grid" style="margin-top:12px">
        <div><div class="k">Szacowane roboczogodziny (wycena)</div><div class="v">${num(p.Szacowane_roboczogodziny).toLocaleString("pl-PL")} rbh</div></div>
        <div><div class="k">Śr. stawka godzinowa (wycena)</div><div class="v">${p.Stawka_godzinowa_srednia != null ? esc(num(p.Stawka_godzinowa_srednia).toLocaleString("pl-PL") + " " + p.Waluta + "/h") : "—"}</div></div>
        <div><div class="k">Szacowany koszt pracy (wycena top-down)</div><div class="v">${p.Stawka_godzinowa_srednia != null ? fmtMoney(num(p.Szacowane_roboczogodziny) * num(p.Stawka_godzinowa_srednia), p.Waluta) : "—"}</div></div>
      </div>` : ""}
      ${tickets.length ? `
      <div class="dp-grid" style="margin-top:12px">
        <div><div class="k">Realne roboczogodziny (z ticketów)</div><div class="v">${realHours.toLocaleString("pl-PL")} rbh</div></div>
        <div><div class="k">Realny koszt pracy (stawki indywidualne × godziny)</div><div class="v">${fmtMoney(realCost, p.Waluta)}</div></div>
        ${margin && margin.subCost ? `<div><div class="k">Wycena zadań podwykonawców (z ticketów)</div><div class="v">${fmtMoney(margin.subCost, p.Waluta)}</div></div>` : ""}
      </div>` : ""}
      ${margin ? `
      <div class="dp-grid" style="margin-top:12px">
        <div><div class="k">Przychód (${projectRevenueIsActual(p) ? "rzeczywisty" : "planowany"})</div><div class="v">${fmtMoney(margin.revenue, p.Waluta)}</div></div>
        <div><div class="k">Marża${margin.subCost ? " (uwzględnia wycenę podwykonawców)" : ""}</div><div class="v" style="color:var(${margin.margin >= 0 ? "--status-good" : "--status-critical"})">${fmtMoney(margin.margin, p.Waluta)} (${Math.round(margin.marginPct)}%)</div></div>
        <div><div class="k">Mark-up (na koszcie)</div><div class="v">${margin.markupPct != null ? Math.round(margin.markupPct) + "%" : "—"}</div></div>
      </div>` : ""}
    </div>

    ${p.Opis ? `<div class="dp-section"><h4>Opis / zakres</h4><div style="font-size:13px">${esc(p.Opis)}</div></div>` : ""}

    <div class="dp-section">
      <div class="section-head" style="margin-bottom:8px"><h4 style="margin:0">Zespół projektowy (${assigns.length})</h4>
        ${can("create", "przypisania", { ID_Projektu: pid }) ? `<button class="icon-btn" data-add-assignment="${esc(pid)}">+ Dodaj do zespołu</button>` : ""}</div>
      ${assigns.map(a => `
        <div class="dp-list-item">
          <div class="item-actions">
            ${can("update", "przypisania", a) ? `<button class="icon-btn" data-edit-assignment="${esc(a.ID_Przypisania)}" data-project="${esc(pid)}">Edytuj</button>` : ""}
            ${can("delete", "przypisania", a) ? `<button class="icon-btn danger" data-delete-assignment="${esc(a.ID_Przypisania)}" data-project="${esc(pid)}">Usuń</button>` : ""}
          </div>
          <div class="title">${esc(personName(a.ID_Osoby))} — ${esc(a.Rola_w_projekcie)}</div>
          <div class="meta">${pctOrDash(a.Procent_zaangazowania)} zaangażowania · od ${fmtDateShort(a.Data_od)} · ${esc(a.Status)}</div>
        </div>`).join("") || `<div class="empty-hint">Brak przypisań — kliknij „+ Dodaj do zespołu”.</div>`}
    </div>

    <div class="dp-section">
      <div class="section-head" style="margin-bottom:8px"><h4 style="margin:0">Podwykonawcy / branżyści (${subAssigns.length})</h4>
        ${can("create", "przypisania_podwykonawcow", { ID_Projektu: pid }) ? `<button class="icon-btn" data-add-subcontractor-assignment="${esc(pid)}">+ Przypisz podwykonawcę</button>` : ""}</div>
      ${subAssigns.map(a => `
        <div class="dp-list-item">
          <div class="item-actions">
            ${can("update", "przypisania_podwykonawcow", a) ? `<button class="icon-btn" data-edit-subcontractor-assignment="${esc(a.ID_Przypisania_Podw)}" data-project="${esc(pid)}">Edytuj</button>` : ""}
            ${can("delete", "przypisania_podwykonawcow", a) ? `<button class="icon-btn danger" data-delete-subcontractor-assignment="${esc(a.ID_Przypisania_Podw)}" data-project="${esc(pid)}">Usuń</button>` : ""}
          </div>
          <div class="title">${esc(subcontractorName(a.ID_Podwykonawcy))} — ${esc(a.Branza)} ${badge(a.Status, subAssignmentStatusBadge(a.Status))} ${subAssignmentDelayBadgeHtml(a)}</div>
          <div class="meta">${esc(a.Zakres_prac)}</div>
          <div class="meta">${fmtDateShort(a.Data_od)} – ${fmtDateShort(a.Data_do)} ${a.Wartosc_umowy ? "· " + fmtMoney(a.Wartosc_umowy, a.Waluta) : ""}</div>
        </div>`).join("") || `<div class="empty-hint">Brak przypisanych podwykonawców — kliknij „+ Przypisz podwykonawcę” (z biblioteki).</div>`}
    </div>

    <div class="dp-section">
      <div class="section-head" style="margin-bottom:8px"><h4 style="margin:0">Zadania / tickety (${tickets.length})</h4>
        ${can("create", "zadania_tickety", { ID_Projektu: pid }) ? `<button class="icon-btn" data-add-ticket="${esc(pid)}">+ Nowy ticket</button>` : ""}</div>
      ${tickets.length ? tickets.slice().sort((a, b) => (a.Termin?.getTime() || 0) - (b.Termin?.getTime() || 0)).map(t => `
        <div class="dp-list-item" ${can("update", "zadania_tickety", t) ? `data-open-ticket="${esc(t.ID_Tickietu)}" style="cursor:pointer"` : ""}>
          <div class="item-actions">
            ${can("create", "zadania_tickety", t) ? `<button class="icon-btn" data-duplicate-ticket="${esc(t.ID_Tickietu)}">Duplikuj</button>` : ""}
            ${can("delete", "zadania_tickety", t) ? `<button class="icon-btn danger" data-delete-ticket="${esc(t.ID_Tickietu)}" data-project="${esc(pid)}">Usuń</button>` : ""}
          </div>
          <div class="title">${esc(t.ID_Tickietu)} — ${esc(t.Tytul)} ${badge(ticketEffectiveStatus(t), ticketStatusBadge(ticketEffectiveStatus(t)))}</div>
          <div class="meta">${esc(ticketAssigneeLabel(t))} · termin ${fmtDate(t.Termin)} · ${esc(t.Priorytet)}${t.Szacowane_roboczogodziny ? " · " + t.Szacowane_roboczogodziny + " rbh szac." : ""}${t.Rzeczywiste_roboczogodziny ? " / " + t.Rzeczywiste_roboczogodziny + " rbh rzecz." : ""}</div>
        </div>`).join("") : `<div class="empty-hint">Brak zadań — kliknij „+ Nowy ticket”, żeby przypisać pracę do konkretnej osoby.</div>`}
    </div>

    <div class="dp-section">
      <div class="section-head" style="margin-bottom:8px"><h4 style="margin:0">Kamienie milowe (${mstones.length})</h4>
        ${can("create", "kamienie_milowe", { ID_Projektu: pid }) ? `<button class="icon-btn" data-add-milestone="${esc(pid)}">+ Dodaj kamień milowy</button>` : ""}</div>
      ${mstones.map(m => `
        <div class="dp-list-item" ${can("update", "kamienie_milowe", m) ? `data-edit-milestone="${esc(m.ID_Kamienia)}" data-project="${esc(pid)}" style="cursor:pointer"` : ""}>
          <div class="item-actions">
            ${can("delete", "kamienie_milowe", m) ? `<button class="icon-btn danger" data-delete-milestone="${esc(m.ID_Kamienia)}" data-project="${esc(pid)}">Usuń</button>` : ""}
          </div>
          <div class="title">${esc(m.Nazwa_kamienia)} ${badge(m.Status, milestoneStatusBadge(m.Status))}</div>
          <div class="meta">Plan: ${fmtDate(m.Data_planowana)} ${m.Data_rzeczywista ? "· Rzeczywiste: " + fmtDate(m.Data_rzeczywista) : ""} · ${esc(personName(m.ID_Osoby_odpowiedzialnej))}</div>
        </div>`).join("") || `<div class="kpi-sub">Brak kamieni milowych.</div>`}
    </div>

    <div class="dp-section">
      <div class="section-head" style="margin-bottom:8px"><h4 style="margin:0">Checklista (${checklist.length})</h4>
        ${can("create", "checklisty_projektow", { ID_Projektu: pid }) ? `<button class="icon-btn" data-add-checklist="${esc(pid)}">+ Dodaj pozycję</button>` : ""}</div>
      ${checklist.map(c => `
        <div class="dp-list-item">
          <div class="item-actions">
            ${can("delete", "checklisty_projektow", c) ? `<button class="icon-btn danger" data-delete-checklist="${esc(c.ID_Pozycji)}" data-project="${esc(pid)}">Usuń</button>` : ""}
          </div>
          <div style="display:flex;align-items:flex-start;gap:8px">
            <input type="checkbox" data-toggle-checklist="${esc(c.ID_Pozycji)}" data-project="${esc(pid)}" ${c.Wykonano === "Tak" ? "checked" : ""} ${can("update", "checklisty_projektow", c) ? "" : "disabled"} style="margin-top:3px">
            <span ${can("update", "checklisty_projektow", c) ? `data-edit-checklist="${esc(c.ID_Pozycji)}" data-project="${esc(pid)}"` : ""} style="${can("update", "checklisty_projektow", c) ? "cursor:pointer;" : ""}${c.Wykonano === "Tak" ? "text-decoration:line-through;color:var(--text-muted)" : ""}">${esc(c.Tresc)}</span>
          </div>
        </div>`).join("") || `<div class="kpi-sub">Brak pozycji checklisty.</div>`}
    </div>

    <div class="dp-section">
      <div class="section-head" style="margin-bottom:8px"><h4 style="margin:0">Ryzyka i problemy (${risks.length})</h4>
        ${can("create", "ryzyka_i_problemy", { ID_Projektu: pid }) ? `<button class="icon-btn" data-add-risk="${esc(pid)}">+ Dodaj ryzyko/problem</button>` : ""}</div>
      ${risks.map(r => `
        <div class="dp-list-item" ${can("update", "ryzyka_i_problemy", r) ? `data-edit-risk="${esc(r.ID)}" data-project="${esc(pid)}" style="cursor:pointer"` : ""}>
          <div class="item-actions">
            ${can("delete", "ryzyka_i_problemy", r) ? `<button class="icon-btn danger" data-delete-risk="${esc(r.ID)}" data-project="${esc(pid)}">Usuń</button>` : ""}
          </div>
          <div class="title">${esc(r.Opis)} ${badge(r.Status, riskStatusBadge(r.Status))}</div>
          <div class="meta">${esc(r.Typ)} · ${esc(r.Kategoria)} · właściciel: ${esc(personName(r.ID_Osoby_wlasciciela))}</div>
          ${r.Plan_mitygacji ? `<div class="meta">Mitygacja: ${esc(r.Plan_mitygacji)}</div>` : ""}
        </div>`).join("") || `<div class="empty-hint">Brak zarejestrowanych ryzyk — kliknij „+ Dodaj ryzyko/problem”.</div>`}
    </div>

    <div class="dp-section">
      <div class="section-head" style="margin-bottom:8px"><h4 style="margin:0">Sub-projekty / etapy (${tasks.length})</h4>
        ${can("create", "harmonogram", { ID_Projektu: pid }) ? `<button class="icon-btn" data-add-task="${esc(pid)}">+ Dodaj etap</button>` : ""}</div>
      ${tasks.length ? buildGantt(tasks, { hideGroupHeader: true }) : `<div class="empty-hint">Brak sub-projektów/etapów — kliknij „+ Dodaj etap”, żeby zbudować harmonogram (Gantt). Status i RAG projektu wyliczają się z sub-projektów.</div>`}
    </div>

    ${reports.length ? `<div class="dp-section"><h4>Historia raportów statusowych</h4>${reports.map(r => `
      <div class="dp-list-item">
        <div class="title">${fmtDate(r.Data_raportu)} — ${badge(ragLabel(r.RAG_Status), ragClass(r.RAG_Status))} · ${fmtPctFraction(r.Procent_postepu)}</div>
        <div class="meta">Osiągnięcia: ${esc(r.Kluczowe_osiagniecia || "—")}</div>
        <div class="meta">Problemy: ${esc(r.Kluczowe_problemy || "—")}</div>
        <div class="meta">Następne kroki: ${esc(r.Nastepne_kroki || "—")} · autor: ${esc(r.Autor_raportu || "—")}</div>
      </div>`).join("")}</div>` : ""}

    ${p.Komentarz ? `<div class="dp-section"><h4>Komentarz PMO</h4><div style="font-size:13px">${esc(p.Komentarz)}</div></div>` : ""}

    <div class="dp-section">
      <button data-print-view="1">Drukuj kartę projektu</button>
    </div>
  `;
  $("#overlay").classList.add("open");
  $("#detailPanel").classList.add("open");
}

function openPersonDetail(oid) {
  const person = STATE.teamById.get(oid);
  if (!person) return;
  const assigns = assignmentsForPerson(oid);
  const hrs = workloadHoursInfo(person);
  const myTickets = ticketsForPerson(oid).sort((a, b) => (a.Termin?.getTime() || 0) - (b.Termin?.getTime() || 0));
  $("#dpContent").innerHTML = `
    <div style="display:flex;justify-content:flex-end;gap:6px">
      ${can("update", "zespol") ? `<button class="icon-btn" data-edit-team="${esc(oid)}">Edytuj</button>` : ""}
      ${can("delete", "zespol") ? `<button class="icon-btn danger" data-delete-team="${esc(oid)}">Usuń</button>` : ""}
    </div>
    <h2>${esc(person.Imie_i_nazwisko)}</h2>
    <div class="dp-sub">${esc(person.Stanowisko_Rola)} · ${esc(person.Dzial)}</div>
    <div class="dp-grid">
      <div><div class="k">Email</div><div class="v">${esc(person.Email)}</div></div>
      <div><div class="k">Telefon</div><div class="v">${esc(person.Telefon)}</div></div>
      <div><div class="k">Dostępność (FTE)</div><div class="v">${person.Dostepnosc_FTE_procent}%</div></div>
      <div><div class="k">Stawka godzinowa</div><div class="v">${person.Stawka_godzinowa ? num(person.Stawka_godzinowa).toLocaleString("pl-PL") + " PLN/h" : "—"}</div></div>
      <div><div class="k">Obecne obciążenie</div><div class="v">${hrs.percent}%</div></div>
      <div><div class="k">Godziny w tym miesiącu</div><div class="v">${hrs.assignedHours.toFixed(0)}h / ${hrs.capacityHours.toFixed(0)}h</div></div>
      <div><div class="k">Dni robocze / dzienna pojemność</div><div class="v">${hrs.workDays} dni × ${hrs.dailyCapacityHours.toFixed(2)}h</div></div>
      <div><div class="k">Przerwy wg KP (Art. 134/141)</div><div class="v">${HOURS_PER_DAY}h nominalnie − ${BREAK_MINUTES_PER_DAY + LUNCH_MINUTES_PER_DAY} min/dzień</div></div>
    </div>
    <div class="dp-section">
      <h4>Przypisania do projektów (${assigns.length})</h4>
      ${assigns.map(a => `
        <div class="dp-list-item clickable" data-open-project="${esc(a.ID_Projektu)}" style="cursor:pointer">
          <div class="title">${esc(projectName(a.ID_Projektu))} — ${esc(a.Rola_w_projekcie)}</div>
          <div class="meta">${pctOrDash(a.Procent_zaangazowania)} · ${esc(a.Status)} · od ${fmtDateShort(a.Data_od)}</div>
        </div>`).join("") || `<div class="kpi-sub">Brak przypisań.</div>`}
    </div>
    <div class="dp-section">
      <h4>Przypisane zadania / tickety (${myTickets.length})</h4>
      ${myTickets.map(t => { const editable = can("update", "zadania_tickety", t); return `
        <div class="dp-list-item ${editable ? "clickable" : ""}" ${editable ? `data-open-ticket="${esc(t.ID_Tickietu)}" style="cursor:pointer"` : ""}>
          <div class="title">${esc(t.Tytul)} ${badge(ticketEffectiveStatus(t), ticketStatusBadge(ticketEffectiveStatus(t)))}</div>
          <div class="meta">${esc(projectName(t.ID_Projektu))} · termin ${fmtDate(t.Termin)} · ${esc(t.Priorytet)}</div>
        </div>`; }).join("") || `<div class="kpi-sub">Brak przypisanych zadań.</div>`}
    </div>
  `;
  $("#overlay").classList.add("open");
  $("#detailPanel").classList.add("open");
}

function openSubcontractorDetail(sid) {
  const sub = STATE.subcontractorById.get(sid);
  if (!sub) return;
  const assigns = subcontractorAssignmentsForSubcontractor(sid);
  const tickets = ticketsForSubcontractor(sid).sort((a, b) => (a.Termin?.getTime() || 0) - (b.Termin?.getTime() || 0));
  const ot = subcontractorOnTimeStats(sid);
  $("#dpContent").innerHTML = `
    <div style="display:flex;justify-content:flex-end;gap:6px">
      ${can("update", "podwykonawcy", sub) ? `<button class="icon-btn" data-edit-subcontractor="${esc(sid)}">Edytuj</button>` : ""}
      ${can("delete", "podwykonawcy", sub) ? `<button class="icon-btn danger" data-delete-subcontractor="${esc(sid)}">Usuń</button>` : ""}
    </div>
    <h2>${esc(sub.Nazwa)}</h2>
    <div class="dp-sub">${esc(sub.Branza)} · ${esc(sub.Typ_wspolpracy)}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">
      ${badge(sub.Status, subStatusBadge(sub.Status))}
      ${badge("Ocena: " + (sub.Ocena || "—"), "muted")}
    </div>
    <div class="dp-grid">
      <div><div class="k">Osoba kontaktowa</div><div class="v">${esc(sub.Osoba_kontaktowa || "—")}</div></div>
      <div><div class="k">Email</div><div class="v">${esc(sub.Email || "—")}</div></div>
      <div><div class="k">Telefon</div><div class="v">${esc(sub.Telefon || "—")}</div></div>
      <div><div class="k">NIP</div><div class="v">${esc(sub.NIP || "—")}</div></div>
      <div><div class="k">Miasto</div><div class="v">${esc(sub.Miasto || "—")}</div></div>
    </div>
    ${sub.Uwagi ? `<div class="dp-section"><h4>Uwagi</h4><div style="font-size:13px">${esc(sub.Uwagi)}</div></div>` : ""}
    <div class="dp-section">
      <h4>Przypisania do projektów (${assigns.length})</h4>
      ${assigns.map(a => `
        <div class="dp-list-item clickable" data-open-project="${esc(a.ID_Projektu)}" style="cursor:pointer">
          <div class="title">${esc(projectName(a.ID_Projektu))} — ${esc(a.Branza)} ${badge(a.Status, subAssignmentStatusBadge(a.Status))} ${subAssignmentDelayBadgeHtml(a)}</div>
          <div class="meta">${esc(a.Zakres_prac)}</div>
          <div class="meta">${fmtDateShort(a.Data_od)} – ${fmtDateShort(a.Data_do)} ${a.Wartosc_umowy ? "· " + fmtMoney(a.Wartosc_umowy, a.Waluta) : ""}</div>
        </div>`).join("") || `<div class="kpi-sub">Brak przypisań do projektów.</div>`}
    </div>
    <div class="dp-section">
      <h4>Terminowość zadań (${tickets.length})</h4>
      <div class="kpi-grid" style="margin-bottom:0">
        <div class="kpi-tile ${ot.pct == null ? "" : ot.pct >= 80 ? "accent-good" : "accent-warning"}">
          <div class="kpi-label">Terminowość</div>
          <div class="kpi-value">${ot.pct == null ? "—" : ot.pct + "%"}</div>
          <div class="kpi-sub">${ot.onTimeTotal}/${ot.doneTotal} zakończonych na czas</div>
        </div>
        <div class="kpi-tile ${ot.overdue ? "accent-critical" : "accent-good"}">
          <div class="kpi-label">Opóźnione</div>
          <div class="kpi-value">${ot.overdue}</div>
          <div class="kpi-sub">z ${ot.total} zadań łącznie</div>
        </div>
      </div>
      ${tickets.map(t => { const editable = can("update", "zadania_tickety", t); return `
        <div class="dp-list-item ${editable ? "clickable" : ""}" ${editable ? `data-open-ticket="${esc(t.ID_Tickietu)}"` : ""} style="cursor:${editable ? "pointer" : "default"};margin-top:10px">
          <div class="title">${esc(t.ID_Tickietu)} — ${esc(t.Tytul)} ${badge(ticketEffectiveStatus(t), ticketStatusBadge(ticketEffectiveStatus(t)))}</div>
          <div class="meta">${esc(projectName(t.ID_Projektu))} · termin ${fmtDate(t.Termin)}${t.Wycena_podwykonawcy ? " · wycena " + fmtMoney(t.Wycena_podwykonawcy) : ""}</div>
        </div>`; }).join("") || `<div class="empty-hint" style="margin-top:10px">Brak zadań przypisanych do tego podwykonawcy.</div>`}
    </div>
  `;
  $("#overlay").classList.add("open");
  $("#detailPanel").classList.add("open");
}

function closeDetail() {
  $("#overlay").classList.remove("open");
  $("#detailPanel").classList.remove("open");
}

function switchToView(viewName) {
  // Programowy odpowiednik klikniecia zakladki (patrz delegowany handler .tab-btn nizej) -
  // potrzebny dla "szybkich sciezek" z panelu szczegolow projektu, ktore maja przelaczyc
  // zakladke BEZ symulowania klikniecia w konkretny przycisk DOM.
  $all(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.view === viewName));
  $all(".view").forEach(v => v.classList.toggle("active", v.id === `view-${viewName}`));
}
function gotoProjectTasks(pid) {
  closeDetail();
  ticketFilters.projekt = pid;
  ticketFilters.statuses = [];
  ticketFilters.osoba = "";
  ticketFilters.onlyOverdue = false;
  switchToView("zadania");
  renderTickets();
}
function gotoProjectGantt(pid) {
  closeDetail();
  ganttFilters.projekt = pid;
  switchToView("gantt");
  renderGanttView();
}

/* ================================================================== RENDER ALL + WIRING */
function renderAll() {
  renderOverview();
  renderProjects();
  renderTeam();
  renderSubcontractors();
  renderClients();
  renderTickets();
  renderGanttView();
  renderRyzyka();
  renderIdeapool();
  if (FULL_ACCESS_ROLES.includes(STATE.me.role)) renderUsers();
  // Kazdy render*() odbudowuje swoj kawalek DOM od zera (innerHTML), wiec [data-roles] trzeba
  // ponownie wymietc na koniec kazdego pelnego przebiegu, nie tylko raz po boot().
  applyRoleGating();
}

/* ---------- Nowoczesny kalendarz (date picker) ---------- */
const MIESIACE_PL = ["Styczeń", "Luty", "Marzec", "Kwiecień", "Maj", "Czerwiec", "Lipiec", "Sierpień", "Wrzesień", "Październik", "Listopad", "Grudzień"];
const DNI_TYG_PL = ["Pn", "Wt", "Śr", "Cz", "Pt", "So", "Nd"];
const datePickerState = { input: null, viewYear: null, viewMonth: null };

function ensureDatePickerEl() {
  let el = document.getElementById("datePickerPopup");
  if (el) return el;
  el = document.createElement("div");
  el.id = "datePickerPopup";
  el.className = "date-picker-popup";
  el.innerHTML = `
    <div class="dp-header">
      <button type="button" class="dp-nav" data-dp-prev aria-label="Poprzedni miesiąc">‹</button>
      <div class="dp-month-label"></div>
      <button type="button" class="dp-nav" data-dp-next aria-label="Następny miesiąc">›</button>
    </div>
    <div class="dp-weekdays">${DNI_TYG_PL.map(d => `<span>${d}</span>`).join("")}</div>
    <div class="dp-days"></div>
    <div class="dp-footer">
      <button type="button" class="dp-btn" data-dp-today>Dziś</button>
      <button type="button" class="dp-btn dp-btn-ghost" data-dp-clear>Wyczyść</button>
    </div>`;
  document.body.appendChild(el);
  return el;
}

function openDatePicker(inputEl) {
  const el = ensureDatePickerEl();
  const current = parseDateInput(inputEl.value);
  const base = current || today0();
  datePickerState.input = inputEl;
  datePickerState.viewYear = base.getFullYear();
  datePickerState.viewMonth = base.getMonth();
  renderDatePicker();
  el.classList.add("open");
  positionDatePicker(inputEl);
}

function closeDatePicker() {
  const el = document.getElementById("datePickerPopup");
  if (el) el.classList.remove("open");
  datePickerState.input = null;
}

function positionDatePicker(inputEl) {
  const el = document.getElementById("datePickerPopup");
  const r = inputEl.getBoundingClientRect();
  const w = el.offsetWidth || 280, h = el.offsetHeight || 320;
  let left = r.left, top = r.bottom + 6;
  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
  if (left < 8) left = 8;
  if (top + h > window.innerHeight - 8) top = r.top - h - 6;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function renderDatePicker() {
  const el = document.getElementById("datePickerPopup");
  if (!el) return;
  const { viewYear, viewMonth, input } = datePickerState;
  el.querySelector(".dp-month-label").textContent = `${MIESIACE_PL[viewMonth]} ${viewYear}`;
  const selected = input ? parseDateInput(input.value) : null;
  const todayD = today0();
  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  const startOffset = (firstOfMonth.getDay() + 6) % 7; // poniedziałek = 0
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const dayHtml = cells.map(d => {
    if (!d) return `<span class="dp-day dp-day-empty"></span>`;
    const cellDate = new Date(viewYear, viewMonth, d);
    const isToday = cellDate.getTime() === todayD.getTime();
    const isSelected = selected && cellDate.getTime() === selected.getTime();
    const cls = ["dp-day"];
    if (isToday) cls.push("dp-day-today");
    if (isSelected) cls.push("dp-day-selected");
    return `<button type="button" class="${cls.join(" ")}" data-dp-day="${d}">${d}</button>`;
  }).join("");
  el.querySelector(".dp-days").innerHTML = dayHtml;
}

function dpNav(delta) {
  let m = datePickerState.viewMonth + delta, y = datePickerState.viewYear;
  if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
  datePickerState.viewMonth = m;
  datePickerState.viewYear = y;
  renderDatePicker();
}

function dpSelectDay(d) {
  const { viewYear, viewMonth, input } = datePickerState;
  if (!input) return;
  const date = new Date(viewYear, viewMonth, d);
  input.value = dateDisplayVal(date);
  input.dispatchEvent(new Event("change", { bubbles: true }));
  closeDatePicker();
}

function dpSelectToday() {
  const { input } = datePickerState;
  if (!input) return;
  input.value = dateDisplayVal(today0());
  input.dispatchEvent(new Event("change", { bubbles: true }));
  closeDatePicker();
}

function dpClearValue() {
  const { input } = datePickerState;
  if (!input) return;
  input.value = "";
  input.dispatchEvent(new Event("change", { bubbles: true }));
  closeDatePicker();
}

function syncTagsHiddenInput(field) {
  const tags = $all(".tag-chip", field).map(el => el.getAttribute("data-tag"));
  field.parentElement.querySelector('input[type="hidden"]').value = tags.join(",");
}
function addTagFromInput(input) {
  const value = input.value.trim().replace(/,+$/, "").trim();
  input.value = "";
  if (!value) return;
  const field = input.closest(".tag-chips-editable");
  if ($all(".tag-chip", field).some(el => el.getAttribute("data-tag") === value)) return;
  input.insertAdjacentHTML("beforebegin", tagChipHtml(value));
  syncTagsHiddenInput(field);
}

document.addEventListener("keydown", (e) => {
  // Pole daty jest teraz zwyklym polem tekstowym (mozna wpisac date recznie) - zadna klawisza
  // nie powinna byc przechwytywana do otwierania pickera, zeby nie kolidowac z pisaniem
  // (probne "Spacja otwiera picker" psulo pisanie dowolnego tekstu zawierajacego spacje -
  // zweryfikowane bezposrednio). Klik nadal otwiera picker (myszka), Escape nadal zamyka.
  if (e.key === "Escape") { closeDatePicker(); closeMentionSuggestions(); }
  const tagInput = e.target.closest && e.target.closest(".tag-chip-input");
  if (tagInput && (e.key === "Enter" || e.key === ",")) { e.preventDefault(); addTagFromInput(tagInput); return; }
  if (mentionState.textarea && e.target === mentionState.textarea && mentionState.matches.length) {
    if (e.key === "ArrowDown") { e.preventDefault(); mentionState.activeIndex = (mentionState.activeIndex + 1) % mentionState.matches.length; renderMentionSuggestions(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); mentionState.activeIndex = (mentionState.activeIndex - 1 + mentionState.matches.length) % mentionState.matches.length; renderMentionSuggestions(); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMentionSuggestion(mentionState.matches[mentionState.activeIndex].Imie_i_nazwisko); return; }
  }
});
document.addEventListener("input", (e) => {
  const commentInput = e.target.closest && e.target.closest("[data-comment-input]");
  if (commentInput) updateMentionSuggestions(commentInput);
});
document.addEventListener("scroll", () => {
  // Popup pickera to position:fixed singleton doczepiony do document.body, wiec nie
  // przesuwa sie automatycznie ze scrollem wewnatrz .modal-box (max-height:86vh;
  // overflow-y:auto) - bez tego przy przewinieciu formularza kalendarz "rozjezdzal sie"
  // od pola, do ktorego nalezy (zostawal w starym miejscu na ekranie). capture:true, bo
  // scroll nie bubble'uje - to jedyny sposob zlapania go z zagniezdzonego kontenera.
  if (datePickerState.input) positionDatePicker(datePickerState.input);
  if (mentionState.textarea) positionMentionSuggestions(mentionState.textarea);
}, true);
document.addEventListener("focusout", (e) => {
  // blur() nie bubble'uje - focusout tak, wiec to jedyny sposob na delegacje zamiast pod
  // wpiecia osobnego listenera do kazdego pola daty osobno przy kazdym renderze formularza.
  const dateInput = e.target.closest && e.target.closest(".date-input");
  if (!dateInput) return;
  const parsed = parseDateInput(dateInput.value);
  if (parsed) dateInput.value = dateDisplayVal(parsed);
});
document.addEventListener("change", (e) => {
  // Delegowane, nie podpiete per-element - checklista jest przebudowywana od zera (innerHTML)
  // przy kazdym openProjectDetail(), wiec bezposredni listener trzeba by wiazac na nowo za
  // kazdym razem (ten sam powod co dla focusout/date-input powyzej).
  const checklistCheckbox = e.target.closest && e.target.closest("[data-toggle-checklist]");
  if (checklistCheckbox) { toggleChecklistItem(checklistCheckbox.getAttribute("data-toggle-checklist"), checklistCheckbox.getAttribute("data-project")); return; }
  const avatarFile = e.target.closest && e.target.closest("[data-avatar-file]");
  if (avatarFile) {
    const file = avatarFile.files[0];
    if (file) uploadAvatar(avatarFile.getAttribute("data-avatar-file"), file);
    avatarFile.value = "";
    return;
  }
});

document.addEventListener("click", (e) => {
  const printView = e.target.closest("[data-print-view]");
  if (printView) { window.print(); return; }
  const avatarRemove = e.target.closest("[data-avatar-remove]");
  if (avatarRemove) { removeAvatar(avatarRemove.getAttribute("data-avatar-remove")); return; }
  const dateTrigger = e.target.closest(".date-input");
  if (dateTrigger) { openDatePicker(dateTrigger); return; }
  const tagRemoveBtn = e.target.closest(".tag-chip-remove");
  if (tagRemoveBtn) {
    const chip = tagRemoveBtn.closest(".tag-chip");
    const field = chip.closest(".tag-chips-editable");
    chip.remove();
    syncTagsHiddenInput(field);
    return;
  }
  const dpPrev = e.target.closest("[data-dp-prev]");
  if (dpPrev) { dpNav(-1); return; }
  const dpNext = e.target.closest("[data-dp-next]");
  if (dpNext) { dpNav(1); return; }
  const dpToday = e.target.closest("[data-dp-today]");
  if (dpToday) { dpSelectToday(); return; }
  const dpClear = e.target.closest("[data-dp-clear]");
  if (dpClear) { dpClearValue(); return; }
  const dpDay = e.target.closest("[data-dp-day]");
  if (dpDay) { dpSelectDay(Number(dpDay.getAttribute("data-dp-day"))); return; }
  if (datePickerState.input && !e.target.closest("#datePickerPopup")) closeDatePicker();

  const mentionPick = e.target.closest("[data-mention-pick]");
  if (mentionPick) { pickMentionSuggestion(mentionPick.getAttribute("data-mention-pick")); return; }
  if (mentionState.textarea && !e.target.closest("#mentionSuggestions") && e.target !== mentionState.textarea) closeMentionSuggestions();

  const notifBellBtn = e.target.closest("#notifBellBtn");
  if (notifBellBtn) { toggleNotificationPanel(); return; }
  const notifMarkAll = e.target.closest("[data-notif-mark-all]");
  if (notifMarkAll) { markAllNotificationsRead(); return; }
  const notifItem = e.target.closest("[data-notif-open]");
  if (notifItem) { openNotification(notifItem.getAttribute("data-notif-open")); return; }
  if (!e.target.closest("#notifBellWrap")) closeNotificationPanel();

  const addProject = e.target.closest("[data-add-project]");
  if (addProject) { openProjectForm(); return; }
  const projViewBtn = e.target.closest("[data-proj-view]");
  if (projViewBtn) { projectFilters.view = projViewBtn.getAttribute("data-proj-view"); renderProjects(); return; }
  const ganttViewBtn = e.target.closest("[data-gantt-view]");
  if (ganttViewBtn) { ganttFilters.view = ganttViewBtn.getAttribute("data-gantt-view"); renderGanttView(); return; }
  const teamViewBtn = e.target.closest("[data-team-view]");
  if (teamViewBtn) { teamFilters.view = teamViewBtn.getAttribute("data-team-view"); renderTeam(); return; }
  const editProject = e.target.closest("[data-edit-project]");
  if (editProject) { openProjectForm(editProject.getAttribute("data-edit-project")); return; }
  const releaseProjectBtn = e.target.closest("[data-release-project]");
  if (releaseProjectBtn) { releaseProject(releaseProjectBtn.getAttribute("data-release-project")); return; }
  const assignProjectBtn = e.target.closest("[data-assign-project]");
  if (assignProjectBtn) { openAssignProjectForm(assignProjectBtn.getAttribute("data-assign-project")); return; }
  const mergeProjectsBtn = e.target.closest("[data-merge-projects]");
  if (mergeProjectsBtn) { openMergeProjectsForm(mergeProjectsBtn.getAttribute("data-merge-projects")); return; }
  const deleteProjectBtn = e.target.closest("[data-delete-project]");
  if (deleteProjectBtn) { deleteProject(deleteProjectBtn.getAttribute("data-delete-project")); return; }

  const addTeam = e.target.closest("[data-add-team]");
  if (addTeam) { openTeamForm(); return; }
  const editTeam = e.target.closest("[data-edit-team]");
  if (editTeam) { openTeamForm(editTeam.getAttribute("data-edit-team")); return; }
  const deleteTeamBtn = e.target.closest("[data-delete-team]");
  if (deleteTeamBtn) { deleteTeamMember(deleteTeamBtn.getAttribute("data-delete-team")); return; }

  const addAssignment = e.target.closest("[data-add-assignment]");
  if (addAssignment) { openAssignmentForm(addAssignment.getAttribute("data-add-assignment")); return; }
  const editAssignment = e.target.closest("[data-edit-assignment]");
  if (editAssignment) { openAssignmentForm(editAssignment.getAttribute("data-project"), editAssignment.getAttribute("data-edit-assignment")); return; }
  const deleteAssignmentBtn = e.target.closest("[data-delete-assignment]");
  if (deleteAssignmentBtn) { deleteAssignment(deleteAssignmentBtn.getAttribute("data-delete-assignment"), deleteAssignmentBtn.getAttribute("data-project")); return; }

  const addTask = e.target.closest("[data-add-task]");
  if (addTask) { openTaskForm(addTask.getAttribute("data-add-task")); return; }
  const deleteTaskBtn = e.target.closest("[data-delete-task]");
  if (deleteTaskBtn) { deleteTask(deleteTaskBtn.getAttribute("data-delete-task"), deleteTaskBtn.getAttribute("data-project")); return; }

  const addTicket = e.target.closest("[data-add-ticket]");
  if (addTicket) { openTicketForm(addTicket.getAttribute("data-add-ticket")); return; }
  const deleteTicketBtn = e.target.closest("[data-delete-ticket]");
  if (deleteTicketBtn) { deleteTicket(deleteTicketBtn.getAttribute("data-delete-ticket"), deleteTicketBtn.getAttribute("data-project")); return; }
  const duplicateTicketBtn = e.target.closest("[data-duplicate-ticket]");
  if (duplicateTicketBtn) { duplicateTicket(duplicateTicketBtn.getAttribute("data-duplicate-ticket")); return; }
  const addCommentBtn = e.target.closest("[data-add-comment]");
  if (addCommentBtn) { addTicketComment(addCommentBtn.getAttribute("data-add-comment")); return; }
  const tkViewBtn = e.target.closest("[data-tk-view]");
  if (tkViewBtn) { ticketFilters.view = tkViewBtn.getAttribute("data-tk-view"); renderTickets(); return; }
  const tkStatusChip = e.target.closest("[data-tk-status-filter]");
  if (tkStatusChip) {
    const val = tkStatusChip.getAttribute("data-tk-status-filter");
    if (!val) { ticketFilters.statuses = []; }
    else {
      const idx = ticketFilters.statuses.indexOf(val);
      if (idx === -1) ticketFilters.statuses.push(val); else ticketFilters.statuses.splice(idx, 1);
    }
    renderTickets();
    return;
  }
  const openTicketRow = e.target.closest("[data-open-ticket]");
  if (openTicketRow) { const tkid = openTicketRow.getAttribute("data-open-ticket"); const tk = STATE.tickets.find(x => x.ID_Tickietu === tkid); if (tk) { openTicketForm(tk.ID_Projektu, tkid); return; } }

  const addRisk = e.target.closest("[data-add-risk]");
  if (addRisk) { openRiskForm(addRisk.getAttribute("data-add-risk")); return; }
  const deleteRiskBtn = e.target.closest("[data-delete-risk]");
  if (deleteRiskBtn) { deleteRisk(deleteRiskBtn.getAttribute("data-delete-risk"), deleteRiskBtn.getAttribute("data-project")); return; }
  const editRisk = e.target.closest("[data-edit-risk]");
  if (editRisk) { openRiskForm(editRisk.getAttribute("data-project"), editRisk.getAttribute("data-edit-risk")); return; }

  const addMilestone = e.target.closest("[data-add-milestone]");
  if (addMilestone) { openMilestoneForm(addMilestone.getAttribute("data-add-milestone")); return; }
  const deleteMilestoneBtn = e.target.closest("[data-delete-milestone]");
  if (deleteMilestoneBtn) { deleteMilestone(deleteMilestoneBtn.getAttribute("data-delete-milestone"), deleteMilestoneBtn.getAttribute("data-project")); return; }
  const editMilestone = e.target.closest("[data-edit-milestone]");
  if (editMilestone) { openMilestoneForm(editMilestone.getAttribute("data-project"), editMilestone.getAttribute("data-edit-milestone")); return; }

  const addChecklist = e.target.closest("[data-add-checklist]");
  if (addChecklist) { openChecklistItemForm(addChecklist.getAttribute("data-add-checklist")); return; }
  const deleteChecklistBtn = e.target.closest("[data-delete-checklist]");
  if (deleteChecklistBtn) { deleteChecklistItem(deleteChecklistBtn.getAttribute("data-delete-checklist"), deleteChecklistBtn.getAttribute("data-project")); return; }
  const editChecklist = e.target.closest("[data-edit-checklist]");
  if (editChecklist) { openChecklistItemForm(editChecklist.getAttribute("data-project"), editChecklist.getAttribute("data-edit-checklist")); return; }
  const addParcel = e.target.closest("[data-add-parcel]");
  if (addParcel) { openParcelForm(addParcel.getAttribute("data-add-parcel")); return; }
  const editParcel = e.target.closest("[data-edit-parcel]");
  if (editParcel) { openParcelForm(editParcel.getAttribute("data-project"), editParcel.getAttribute("data-edit-parcel")); return; }
  const deleteParcelBtn = e.target.closest("[data-delete-parcel]");
  if (deleteParcelBtn) { deleteParcel(deleteParcelBtn.getAttribute("data-delete-parcel"), deleteParcelBtn.getAttribute("data-project")); return; }

  const addSub = e.target.closest("[data-add-subcontractor]");
  if (addSub) { openSubcontractorForm(); return; }
  const editSub = e.target.closest("[data-edit-subcontractor]");
  if (editSub) { openSubcontractorForm(editSub.getAttribute("data-edit-subcontractor")); return; }
  const deleteSubBtn = e.target.closest("[data-delete-subcontractor]");
  if (deleteSubBtn) { deleteSubcontractor(deleteSubBtn.getAttribute("data-delete-subcontractor")); return; }
  const ceidgFetchBtn = e.target.closest("[data-ceidg-fetch]");
  if (ceidgFetchBtn) { handleCeidgFetchClick(ceidgFetchBtn); return; }
  const ceidgSettingsBtn = e.target.closest("[data-ceidg-settings]");
  if (ceidgSettingsBtn) { openCeidgTokenForm(); return; }
  const krsFetchBtn = e.target.closest("[data-krs-fetch]");
  if (krsFetchBtn) { handleKrsFetchClick(krsFetchBtn); return; }

  const addClient = e.target.closest("[data-add-client]");
  if (addClient) { openClientForm(); return; }
  const deleteClientBtn = e.target.closest("[data-delete-client]");
  if (deleteClientBtn) { deleteClient(deleteClientBtn.getAttribute("data-delete-client")); return; }
  const editClient = e.target.closest("[data-edit-client]");
  if (editClient) { openClientForm(editClient.getAttribute("data-edit-client")); return; }
  const addContact = e.target.closest("[data-add-contact]");
  if (addContact) { openContactForm(addContact.getAttribute("data-add-contact")); return; }
  const deleteContactBtn = e.target.closest("[data-delete-contact]");
  if (deleteContactBtn) { deleteContact(deleteContactBtn.getAttribute("data-delete-contact"), deleteContactBtn.getAttribute("data-client")); return; }
  const editContact = e.target.closest("[data-edit-contact]");
  if (editContact) { openContactForm(editContact.getAttribute("data-client"), editContact.getAttribute("data-edit-contact")); return; }

  const addSubAssign = e.target.closest("[data-add-subcontractor-assignment]");
  if (addSubAssign) { openSubcontractorAssignmentForm(addSubAssign.getAttribute("data-add-subcontractor-assignment")); return; }
  const editSubAssign = e.target.closest("[data-edit-subcontractor-assignment]");
  if (editSubAssign) { openSubcontractorAssignmentForm(editSubAssign.getAttribute("data-project"), editSubAssign.getAttribute("data-edit-subcontractor-assignment")); return; }
  const deleteSubAssignBtn = e.target.closest("[data-delete-subcontractor-assignment]");
  if (deleteSubAssignBtn) { deleteSubcontractorAssignment(deleteSubAssignBtn.getAttribute("data-delete-subcontractor-assignment"), deleteSubAssignBtn.getAttribute("data-project")); return; }

  const addIdea = e.target.closest("[data-add-idea]");
  if (addIdea) { openIdeaForm(); return; }
  const deleteIdeaBtn = e.target.closest("[data-delete-idea]");
  if (deleteIdeaBtn) { deleteIdea(deleteIdeaBtn.getAttribute("data-delete-idea")); return; }
  const editIdea = e.target.closest("[data-edit-idea]");
  if (editIdea) { openIdeaForm(editIdea.getAttribute("data-edit-idea")); return; }

  const addUser = e.target.closest("[data-add-user]");
  if (addUser) { openUserForm(); return; }
  const editUser = e.target.closest("[data-edit-user]");
  if (editUser) { openUserForm(editUser.getAttribute("data-edit-user")); return; }
  const resetPwUser = e.target.closest("[data-reset-password-user]");
  if (resetPwUser) { resetUserPassword(resetPwUser.getAttribute("data-reset-password-user")); return; }
  const toggleActiveUser = e.target.closest("[data-toggle-active-user]");
  if (toggleActiveUser) { toggleUserActive(toggleActiveUser.getAttribute("data-toggle-active-user")); return; }
  const backupNowBtn = e.target.closest("[data-backup-now]");
  if (backupNowBtn) { triggerBackupNow(); return; }

  const addLabelBtn = e.target.closest("[data-add-label]");
  if (addLabelBtn) { openLabelForm(addLabelBtn.getAttribute("data-add-label")); return; }
  const editLabelBtn = e.target.closest("[data-edit-label]");
  if (editLabelBtn) {
    const eid = editLabelBtn.getAttribute("data-edit-label");
    const lbl = STATE.labelConfig.find(x => x.ID_Etykiety === eid);
    if (lbl) openLabelForm(lbl.Kategoria, eid);
    return;
  }
  const deleteLabelBtn = e.target.closest("[data-delete-label]");
  if (deleteLabelBtn) { deleteLabel(deleteLabelBtn.getAttribute("data-delete-label")); return; }
  const toggleLabelBtn = e.target.closest("[data-toggle-label-active]");
  if (toggleLabelBtn) { toggleLabelActive(toggleLabelBtn.getAttribute("data-toggle-label-active")); return; }
  const moveLabelBtn = e.target.closest("[data-move-label]");
  if (moveLabelBtn) { moveLabel(moveLabelBtn.getAttribute("data-move-label"), moveLabelBtn.getAttribute("data-dir")); return; }

  // klik w pasek/wiersz Gantta = edycja etapu (sprawdzane po przyciskach add/delete, żeby nie kolidowało)
  const taskRow = e.target.closest("[data-task-id]");
  if (taskRow) { const tid = taskRow.getAttribute("data-task-id"); const t = STATE.tasks.find(x => x.ID_Zadania === tid); if (t) { openTaskForm(t.ID_Projektu, tid); return; } }

  const openProj = e.target.closest("[data-open-project]");
  if (openProj) { openProjectDetail(openProj.getAttribute("data-open-project")); return; }
  const openPerson = e.target.closest("[data-open-person]");
  if (openPerson) { openPersonDetail(openPerson.getAttribute("data-open-person")); return; }
  const openSub = e.target.closest("[data-open-subcontractor]");
  if (openSub) { openSubcontractorDetail(openSub.getAttribute("data-open-subcontractor")); return; }
  const openClient = e.target.closest("[data-open-client]");
  if (openClient) { openClientDetail(openClient.getAttribute("data-open-client")); return; }
  const gotoTasks = e.target.closest("[data-goto-tasks]");
  if (gotoTasks) { gotoProjectTasks(gotoTasks.getAttribute("data-goto-tasks")); return; }
  const gotoGantt = e.target.closest("[data-goto-gantt]");
  if (gotoGantt) { gotoProjectGantt(gotoGantt.getAttribute("data-goto-gantt")); return; }
  const tabBtn = e.target.closest(".tab-btn");
  if (tabBtn) {
    $all(".tab-btn").forEach(b => b.classList.remove("active"));
    tabBtn.classList.add("active");
    $all(".view").forEach(v => v.classList.remove("active"));
    $(`#view-${tabBtn.dataset.view}`).classList.add("active");
    return;
  }
  if (e.target.id === "overlay" || e.target.id === "dpClose") { closeDetail(); return; }
});

/* ---------------------------------------------------------------- raport dla zarzadu (PDF przez druk przegladarki) */
function execPill(text, cls) { return `<span class="exec-pill ${cls}">${esc(text)}</span>`; }

function buildExecutiveReportHtml() {
  const P = STATE.projects;
  const total = P.length;
  const byStatus = (s) => P.filter(p => p.Status === s).length;
  const byRag = (r) => P.filter(p => p.RAG_Status === r).length;
  const budTotal = P.reduce((s, p) => s + num(p.Budzet_calkowity), 0);
  const budSpent = P.reduce((s, p) => s + num(p.Budzet_wydany), 0);
  const portfolioRevenue = P.reduce((s, p) => s + projectRevenue(p), 0);
  const portfolioMargin = portfolioRevenue - budSpent;
  const ot = onTimeStats();
  const openRisks = STATE.risks.filter(r => r.Status !== "Zamkniete");
  const notifications = getNotifications();
  const today = new Date();
  const in90 = new Date(); in90.setDate(today.getDate() + 90);
  const upcomingMilestones = STATE.milestones
    .filter(m => m.Data_planowana instanceof Date && m.Data_planowana >= today && m.Data_planowana <= in90 && m.Status !== "Zakonczone")
    .sort((a, b) => a.Data_planowana - b.Data_planowana);
  const ticketCounts = {};
  KANBAN_KOLUMNY.forEach(s => ticketCounts[s] = 0);
  STATE.tickets.forEach(t => { ticketCounts[t.Status] = (ticketCounts[t.Status] || 0) + 1; });

  const sortedProjects = P.slice().sort((a, b) => (PRIORITY_RANK[a.Priorytet] ?? 3) - (PRIORITY_RANK[b.Priorytet] ?? 3));
  const subCostMap = subcontractorCostByProjectMap();

  return `
    <div class="exec-header">
      <div>
        <h1>Raport dla zarządu — portfel projektów</h1>
        <div style="color:#6b6a63;font-size:12px;margin-top:2px">inicjatywa projektowa</div>
      </div>
      <div class="exec-meta">Wygenerowano: ${new Date().toLocaleString("pl-PL")}<br>${total} projektów w portfelu</div>
    </div>

    <div class="exec-section">
      <h2>Podsumowanie portfela</h2>
      <div class="exec-kpi-grid">
        <div class="exec-kpi"><div class="l">Projekty ogółem</div><div class="v">${total}</div></div>
        <div class="exec-kpi"><div class="l">W realizacji</div><div class="v">${byStatus("W realizacji")}</div></div>
        <div class="exec-kpi ${byStatus("Wstrzymany") ? "bad" : ""}"><div class="l">Wstrzymane</div><div class="v">${byStatus("Wstrzymany")}</div></div>
        <div class="exec-kpi good"><div class="l">Zakończone</div><div class="v">${byStatus("Zakonczony")}</div></div>
        <div class="exec-kpi ${ot.pct == null ? "" : ot.pct >= 80 ? "good" : "warn"}"><div class="l">Terminowość</div><div class="v">${ot.pct == null ? "—" : ot.pct + "%"}</div><div class="s">${ot.onTimeTotal}/${ot.doneTotal} zakończonych na czas</div></div>
        <div class="exec-kpi ${(ot.overdueStages + ot.overdueTickets) ? "bad" : "good"}"><div class="l">Opóźnione etapy/tickety</div><div class="v">${ot.overdueStages + ot.overdueTickets}</div></div>
        <div class="exec-kpi ${byRag("Czerwony") ? "bad" : "good"}"><div class="l">RAG czerwony</div><div class="v">${byRag("Czerwony")}</div></div>
        <div class="exec-kpi ${openRisks.length ? "warn" : "good"}"><div class="l">Otwarte ryzyka/problemy</div><div class="v">${openRisks.length}</div></div>
      </div>
    </div>

    <div class="exec-section">
      <h2>Parametry finansowe</h2>
      <div class="exec-kpi-grid">
        <div class="exec-kpi"><div class="l">Budżet całkowity</div><div class="v">${fmtMoney(budTotal)}</div></div>
        <div class="exec-kpi ${budTotal && budSpent > budTotal ? "bad" : ""}"><div class="l">Budżet wydany</div><div class="v">${fmtMoney(budSpent)}</div><div class="s">${budTotal ? Math.round(budSpent / budTotal * 100) : 0}% wykorzystania</div></div>
        <div class="exec-kpi"><div class="l">Przychód portfela</div><div class="v">${fmtMoney(portfolioRevenue)}</div></div>
        <div class="exec-kpi ${portfolioMargin >= 0 ? "good" : "bad"}"><div class="l">Marża portfela</div><div class="v">${portfolioRevenue ? Math.round(portfolioMargin / portfolioRevenue * 100) + "%" : "—"}</div><div class="s">${fmtMoney(portfolioMargin)}</div></div>
      </div>
      <table>
        <thead><tr><th>Projekt</th><th>Status</th><th>RAG</th><th>Priorytet</th><th>Postęp</th><th>Budżet wyd. / całk.</th><th>Marża</th></tr></thead>
        <tbody>
          ${sortedProjects.map(p => {
            const m = projectMargin(p, subCostMap.get(p.ID_Projektu) || 0);
            return `<tr>
              <td>${esc(p.Nazwa)}</td>
              <td>${esc(p.Status || "—")}</td>
              <td>${execPill(ragLabel(p.RAG_Status), p.RAG_Status === "Czerwony" ? "bad" : p.RAG_Status === "Zolty" ? "warn" : "good")}</td>
              <td>${esc(p.Priorytet || "—")}</td>
              <td>${fmtPctFraction(p.Procent_postepu)}</td>
              <td>${fmtMoney(p.Budzet_wydany, p.Waluta)} / ${fmtMoney(p.Budzet_calkowity, p.Waluta)}</td>
              <td>${m ? Math.round(m.marginPct) + "%" : "—"}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>

    <div class="exec-section">
      <h2>Zadania i terminowość</h2>
      <div class="exec-kpi-grid">
        ${KANBAN_KOLUMNY.map(s => `<div class="exec-kpi"><div class="l">${esc(s)}</div><div class="v">${ticketCounts[s] || 0}</div></div>`).join("")}
      </div>
      ${notifications.filter(n => n.sev === "critical").length ? `
      <table>
        <thead><tr><th>Projekt</th><th>Opóźnienie</th></tr></thead>
        <tbody>
          ${notifications.filter(n => n.sev === "critical").map(n => `<tr><td>${esc(projectName(n.pid))}</td><td>${esc(n.text)}</td></tr>`).join("")}
        </tbody>
      </table>` : `<div class="exec-empty">Brak opóźnień — wszystkie zadania i etapy na czas.</div>`}
    </div>

    <div class="exec-section">
      <h2>Harmonogram — najbliższe kamienie milowe (90 dni)</h2>
      ${upcomingMilestones.length ? `
      <table>
        <thead><tr><th>Projekt</th><th>Kamień milowy</th><th>Termin</th><th>Odpowiedzialny</th></tr></thead>
        <tbody>
          ${upcomingMilestones.map(m => `<tr>
            <td>${esc(projectName(m.ID_Projektu))}</td>
            <td>${esc(m.Nazwa_kamienia)}</td>
            <td>${fmtDate(m.Data_planowana)}</td>
            <td>${esc(personName(m.ID_Osoby_odpowiedzialnej))}</td>
          </tr>`).join("")}
        </tbody>
      </table>` : `<div class="exec-empty">Brak kamieni milowych w najbliższych 90 dniach.</div>`}
    </div>

    <div class="exec-section">
      <h2>Ryzyka i problemy (otwarte)</h2>
      ${openRisks.length ? `
      <table>
        <thead><tr><th>Projekt</th><th>Typ</th><th>Opis</th><th>Priorytet</th><th>Właściciel</th><th>Status</th></tr></thead>
        <tbody>
          ${openRisks.map(r => `<tr>
            <td>${esc(projectName(r.ID_Projektu))}</td>
            <td>${esc(r.Typ)}</td>
            <td>${esc(r.Opis)}</td>
            <td>${esc(r.Priorytet || "—")}</td>
            <td>${esc(personName(r.ID_Osoby_wlasciciela))}</td>
            <td>${esc(r.Status)}</td>
          </tr>`).join("")}
        </tbody>
      </table>` : `<div class="exec-empty">Brak otwartych ryzyk i problemów.</div>`}
    </div>

    <div class="exec-footer">Raport wygenerowany automatycznie z lokalnego dashboardu Inicjatywa Projektowa — dane wg stanu na ${new Date().toLocaleDateString("pl-PL")}.</div>
  `;
}

function generateExecutiveReport() {
  $("#execReport").innerHTML = buildExecutiveReportHtml();
  document.body.classList.add("report-mode");
  window.print();
}
window.addEventListener("afterprint", () => document.body.classList.remove("report-mode"));

$("#btnPrint").addEventListener("click", () => window.print());
$("#btnExport").addEventListener("click", exportToExcel);
$("#btnExecReport").addEventListener("click", generateExecutiveReport);
$("#btnLogout").addEventListener("click", async () => {
  await apiPost("/api/auth/logout").catch(() => {});
  window.location.reload();
});

/* ---------------------------------------------------------------- boot */
async function boot() {
  try {
    // Dwa niezalezne zapytania odpalone rownolegle (nie czekaj na config, zeby zaczac me) -
    // config potrzebny tylko w galezi 401 nizej, wiec w normalnej sciezce logowania jego
    // wynik i tak nigdy nie jest odczytywany.
    const configPromise = apiGet("/api/auth/config").catch(() => ({ googleEnabled: false }));
    const mePromise = apiGet("/api/auth/me");
    let me;
    try {
      me = await mePromise;
    } catch (e) {
      if (e.status === 401) { showLoginScreen((await configPromise).googleEnabled); return; }
      throw e;
    }
    if (me.pending) { showPendingScreen(me); return; }
    await loadFromApi();
    // Brak websocketow - odpytywanie co 45s to jedyny sposob na wykrycie nowej wzmianki od
    // innej osoby bez recznego odswiezenia calej strony (ten sam kompromis "eventually
    // consistent", co reszta tej aplikacji - inni uzytkownicy i tak nie widza NA ZYWO Twoich
    // zmian bez wlasnego odswiezenia).
    setInterval(() => refreshNotifications().catch(() => {}), 45000);
  } catch (e) {
    showConnectionError(e);
  }
}
boot();
