# Projektnotizen für Claude Code

Diese Datei hält fest, was für künftige Arbeiten am Shopfloor Board wichtig ist. Bei neuen Erkenntnissen,
Entscheidungen oder Konventionen hier ergänzen (im selben PR wie die Änderung).

> **Das Repository ist öffentlich.** Keine internen Hostnamen, IP-Adressen, Domains, Zugangsdaten oder
> Personendaten in Code, Doku, Commits oder PRs. Beispiele mit Platzhaltern (`nas.firma.local`, `shopfloor.firma.de`).

## Arbeitsweise mit dem Auftraggeber
- Kommunikation, Oberfläche, Doku, Commits, PRs und Changelog auf **Deutsch**; Antworten an den Auftraggeber
  ohne Fachjargon, mit konkreten Schritten für den Server (`./deploy.sh` …).
- Arbeiten auf dem vorgegebenen Branch `claude/…`, als **Draft-PR** gegen `main`. **Nach `main` nur auf
  ausdrücklichen Wunsch** („auf main pushen“) — dann PR auf „bereit“ setzen und per **Squash** zusammenführen.
- Nach einem Merge startet der Branch neu von `origin/main`. Weil Force-Push gesperrt ist: den alten
  Remote-Stand mit `git merge -X ours origin/<branch>` einbinden (inhaltlich identisch mit `main`), dann pushen.
- Mehrere Wünsche hintereinander dürfen in denselben offenen PR; PR-Beschreibung jeweils aktualisieren.
- Vor dem Abschluss immer testen (siehe „Testen“) und im PR die Tests nennen — auch was nicht getestet werden
  konnte.

## Changelog pflegen (Pflicht)
- Jede Änderung, die Anwender oder Betrieb betrifft (neue Funktion, geändertes Verhalten, Fehlerbehebung,
  neue Einstellung, Sicherheitsrelevantes), kommt im selben Commit/PR in `CHANGELOG.md` unter
  **„[Unveröffentlicht]“** — Rubrik „Neu“, „Geändert“, „Behoben“ oder „Entfernt“, kurz und aus Anwendersicht.
- Rein interne Änderungen (Tests, Kommentare, Formatierung) brauchen keinen Eintrag.
- Beim Zusammenführen nach `main`: „[Unveröffentlicht]“ wird zu `## [x.y.z] – JJJJ-MM-TT`, darüber ein neuer
  leerer Abschnitt, Vergleichslinks am Ende ergänzen. Version an beiden Stellen anheben:
  `backend/package.json` (+ Lock-Datei: `npm version x.y.z --no-git-tag-version` in `backend/`) und
  `SCRIPT_VERSION` in `deploy.sh`.
- Versionen: Nebenversion für neue Funktionen, Patch für reine Fehlerbehebungen, Hauptversion nur, wenn ein
  Update manuelles Eingreifen verlangt.

## Aufbau
```
frontend/index.html     gesamte Oberfläche (eine Datei, Vanilla-JS in einer IIFE, CSS inline)
frontend/nginx.conf     nginx-unprivileged (Port 8080), Proxy /api → api:3000, Drosselung Anmelde-Endpunkte
frontend/csp-hashes.js  berechnet beim Docker-Build die CSP-Hashes der Inline-Skripte (kein 'unsafe-inline')
frontend/fonts/         Inter lokal (keine externen Quellen)
frontend/docs/          Bilder der Anwenderdoku (WebP, erzeugt von tools/doku-screenshots.js)
backend/src/            Node/Express + PostgreSQL (pg)
  server.js             Start, Migration, Zeitpläne (Sicherung, Aufräumen)
  app.js                Middleware (Größenlimits, Sitzung, Herkunfts-/CSRF-Prüfung), /api/health, Fehler
  http.js               HttpError, wrap, requireUser/Edit/Manager/Admin, guardAdminAccount, passwordMatches
  routes/documents.js   Gesamtdokumente state/settings/users mit Revisionsnummer und Konfliktprüfung (409)
  routes/auth.js        Anmeldung, Registrierung, Demo, „Passwort vergessen“ (Einmal-Links, Bremse)
  routes/account.js     Konten verwalten, eigenes Konto, zuletzt gewähltes Dashboard
  routes/dashboards.js  Dashboard-Liste (standard/public/private), Regeln in dashboards.js
  routes/admin.js       E-Mail-Server, Sicherheitsprotokoll, Sicherungen, SMB
  db.js                 Schema + idempotente Migration (bei jedem Start; Beispiel: CHECK-Regel erweitern)
  users.js sessions.js passwords.js audit.js
  backups.js            pg_dump/pg_restore, Zeitplan, Aufräumen, Übernahme von Dateien im Ordner
  smb.js                Kopie auf SMB-Freigabe über smbclient (Passwort per Temp-Datei, nie Befehlszeile)
  mailer.js mailtemplates.js   nodemailer, Einstellungen aus der Oberfläche (meta) vor .env, HTML-Mails
  secrets.js            AES-256-GCM für gespeicherte Passwörter, Schlüssel APP_SECRET (.env)
  monitor.js            Checkmk-Ausgabe (Local Check)
  avatars.js            Profilbilder prüfen und speichern (Tabelle user_avatars)
  monthlyreport.js      Monatsbericht: Berechnung (Formeln wie Oberfläche), HTML-Mail, Zeitplan, meta „monthly_report“
  cli.js                create-admin, reset-password, list-users, mail-test, audit, backup, smb-sync, checkmk
deploy.sh               Installer/Updater (Docker-Installation, .env, Bauen, Sicherung vor Update, Checkmk)
docker-compose.yml      db (postgres:17), api, web; gehärtet (read_only, cap_drop, no-new-privileges)
deploy/compose.proxy.yml  Betriebsart „proxy“ (Netz eines Reverse Proxys)
```

## Oberfläche: wichtige Konzepte (`frontend/index.html`)
- **Lokaler Modus vs. Server-Modus:** Ohne erreichbare API läuft alles im Browser (Testdaten, `localStorage`).
  `SFM` ist das Sync-Modul (`SFM.isServer()`, `SFM.api()`, `SFM.health()`); am Server startet das Board leer.
- **Dokumente:** `state` (Board, Tageswerte `state.dailyData[iso]`, Abweichungen, `reasons`, `huddleLog`,
  `safetyLog`), `settings` (Stammdaten, Verteiler …), `users`. Gespeichert als Ganzes mit Revisionsnummer.
- **Kategorien** `CATS`: S Sicherheit, Q Qualität, **C = Inventory (Buchstabe „I“)**, D Lieferung, P Produktivität.
- **Tageswerte** `DAILY_FIELDS`; Ausfälle je Gruppe U/G und Art (`outageKey(g,k)`, `OUTAGE_KINDS`:
  pers, tech, orga, ruest); Summen immer über `outageTotal()` — nie das Rohfeld `ausfall`/`ausfallGeplant` lesen.
- **Wertekatalog** `VALUE_CATALOG` + `valueOf(key, rec)`: einzige Quelle für Diagramme, Kacheln und Auswahl
  (erfasste und berechnete Werte, `agg`: avg/sum/last). Neue Kennzahlen hier eintragen.
- **Kennzahlen:** OEE = Verfügbarkeit × Leistung × Qualität; Verfügbarkeit: geplante Stillstände verkürzen die
  Planzeit, ungeplante mindern sie; FPY = (produziert − Ausschuss − Nacharbeit) ÷ produziert; Termintreue =
  pünktlich ÷ fällig. Zeiträume: Quoten aus Summen (`RATIO_PARTS`), nicht Mittel der Tagesquoten.
- **Huddle/Agenda:** `FINDING_RULES` (zwingende Abweichungen aus Tageswerten), `NOTE_RULES` (geplante
  Stillstände: keine Abweichung, aber begründungspflichtig), Begründungen `state.reasons["iso|Kat|Schlüssel"]`.
  „Besprochen“ = `agendaChecked()` = Haken **und** keine fehlende Begründung; gelöschte Begründung entfernt den
  Haken; geänderte Werte setzen „besprochen“ zurück (`reopenAgenda`).
- **Revisionstag:** Fenster „Revision“ — nur Sicherheit, Inventory, Lieferung; geplant 24 h (Standard
  Organisatorisch, Begründung „Revision“), Rest 0, `rec.revision = true`, alle Punkte besprochen.
- **Dashboards:** Liste mehrerer Dashboards (`dashList`, `currentDash()`; Wechseln, Anpassen, Kopie, Einstellungen,
  Neu im Menü `#dashMenuBtn`/`#dashMenu` in der Kopfzeile des Dashboards; Anpassen-Leiste `#dashEditTools`), Widgets im
  12-Spalten-Raster. Sichtbarkeit `standard` (eingebaut: `standard`, `detail` = „Detaillierte Auswertung“; ändern nur
  manager/admin, `widgets: null` = ausgeliefertes Layout aus `DASH_BUILTIN`), `public` (alle sehen, ändern/löschen
  nur Ersteller + admin), `private` (nur Besitzer). Server: Tabelle `dashboards`, `dashboards.js` (Regeln, Migration
  alter `users.dashboard`-Layouts → private Dashboards), `routes/dashboards.js`; `/api/user/dashboard` speichert nur
  das zuletzt gewählte (`{v:2,current}`). Lokal: `sfm-dashboards-v1`. `sanitizeWidgets` prüft gespeicherte Layouts,
  `DW_MIN` Mindestgrößen. Inhalte passen sich der Fläche an
  (`dwRenderChart` + ResizeObserver, Container-Abfragen). Multigraph: max. 5 Werte, max. 2 Einheiten (Achsen). Achse je Widget `scale` (`auto` | `fixed` = 0–100 % bzw. ab 0 | `custom` mit
  `ranges` = `[[min|null, max|null], …]` je Achse, `dwCleanScale`)
  für Diagramme und KPI-Karten fpy/otd (`sparkline(…, fixed)`, `multiFieldChartSvg` mit `group.scale`).
- **Ampel-Grenzwerte** `settings.limits` (`scrapPct` = Ausschuss % der produzierten Menge, `outageHours` = ungeplante
  Ausfälle je Tag): `scrapState`/`outageState` → ok/warn/crit, `tileLimit`/`applyTileLimit` für Kacheln (Zeitraum:
  Anteil an Summen bzw. Ø je erfasstem Tag). Unabhängig von den Abweichungsregeln (jeder Wert > 0 bleibt Abweichung).
- **Berechtigungen** `can()`: viewer (Nur Lesen), editor (Bearbeiten), manager (Teamleitung: + Löschen,
  Stammdaten, Benutzer ohne Admin-Konten), admin (alles). Der Server prüft dasselbe (`http.js`, `users.js`).
- **Anwenderdoku** im Array `DOCS` (Gruppen `DOC_GROUPS`; je Thema `intro`, optional `flow`, `sections` mit
  `h`/`p`/`list`/`steps`/`note`/`img`, `tip`) — bei neuen Funktionen mitpflegen. Bilder liegen als WebP in
  `frontend/docs/` (im Image über Dockerfile + `.dockerignore`), neu erzeugen mit `node tools/doku-screenshots.js`.
- Kopfzeile: Speicherstatus nur bei Problemen; Datum → heutiger Huddle.
- **Profilbilder:** im Browser auf 256 × 256 zugeschnitten (`shrinkAvatar`), Server `avatars.js` (Data-URL, JPEG/PNG/WebP,
  max. 200 KB, Dateikennung geprüft) in Tabelle `user_avatars` (ohne Fremdschlüssel, damit alte Sicherungen sich
  wiederherstellen lassen); Version `avatarV` in der Benutzerliste, Bild unter `/api/avatar/<Anmeldename>?v=…`.
  Eigene Änderung nie über die Benutzerliste speichern (nur Teamleitung/Admin dürfen sie schreiben) — dafür
  `avatarOverride`. Lokal: `sfm-avatars-v1`. `fillAvatar()` zeigt Bild oder Initialen.
- **Darstellung** hell/dunkel/automatisch in „Mein Konto“ (`#pwDialog`, `themeSet`/`applyTheme`): `data-theme` auf
  `<html>`, gespeichert je Konto und Gerät in `sfm-theme-v1` (`_last` für die Anmeldeseite); der TV-Modus
  überschreibt das nur, solange er läuft.
- **TV-Modus** (`enterTv`/`renderTv`, Seiten `TV_PAGES`, 20 s je Seite): Stand = `latestDailyIso()`, Einstellungen je
  Gerät in `sfm-tv-v1` (Theme, Pause), setzt `data-theme` nur während des TV-Modus; Tageswechsel → Neuladen mit
  `sessionStorage` `sfm-tv-resume`; Wake Lock; muss auf 1920×1080 und 1366×768 ohne Scrollen passen.

- **Monatsbericht:** Server-seitig (`monthlyreport.js`, Routen `/api/reports/monthly…` in `routes/admin.js`, nur Admin);
  rechnet aus den Dokumenten `state`/`settings` mit denselben Formeln wie die Oberfläche (`oeeAvailability`,
  `periodRatio`, `outageTotal` …) — Formeländerungen dort hier mitziehen. Zeitplan alle 5 min, Versand am Tag/Uhrzeit
  für den Vormonat, merkt sich `last` (Probe an eigene Adresse zählt nicht). UI-Karte `#mrCard` im Bereich E-Mail.

- **Teil-Wiederherstellung:** siehe Standard „Wiederherstellung & Datenkonsistenz“ unten. Code: `backups.inspect`,
  `backups.restoreParts` (Plan → Prüfung → Transaktion), API `GET /api/backups/:file/contents`,
  `POST /api/backups/:file/restore` mit `parts`, `select` {days, deviations, users, dashboards, keepPasswords}, `from`/`to`,
  `dryRun`; UI `#restoreDialog` (Einzelauswahl `rsPick-*`, Vorschau `#rsPreview`, erst danach `#rsOk`).

## Standard: Wiederherstellung & Datenkonsistenz
Verbindlich für jede Funktion, die Daten aus Sicherungen, Dateien oder anderen Quellen teilweise übernimmt (heute:
Teil-Wiederherstellung in `backups.js`). Neue Datenfelder oder Tabellen müssen hier einem Teil zugeordnet werden.
1. **Einheiten statt Einzelfelder.** Zusammengehöriges wird nur gemeinsam übernommen:
   - **Tag** = `dailyData[iso]` + SQIDP-Zellen `boards["J-M"][Kat][Tag]` + Begründungen `reasons["iso|…"]` +
     `huddleLog[iso]` + `safetyLog[iso]` (`dayUnit`/`applyDays`).
   - **Abweichung** = ganzes Objekt aus `state.deviations` (inkl. 5-Why, Phase, `src`).
   - **Konto** = Zeile `users` + Profilbild `user_avatars` (Passwort-Hash nur auf ausdrücklichen Wunsch).
   - **Dashboard** = ganze Zeile `dashboards`; **Stammdaten** = ganzes Dokument `settings`.
   - Berechnete Werte (OEE, FPY, Ampeln, Grünquoten) werden **nie** gespeichert oder übernommen — sie entstehen neu.
2. **Zuordnung über eindeutige Kennungen:** Abweichung über `id`, Konto über Anmeldenamen (`username`, ohne
   Groß-/Kleinschreibung), Dashboard über `id`, Tag über das Datum. Vorhanden → auf den Stand der Quelle setzen,
   fehlt → neu anlegen. Nicht gewählte Datensätze bleiben unverändert. Zähler werden nur erhöht, nie zurückgesetzt
   (`state.seq` > höchste Abweichungsnummer, Sequenz von `users.id`).
3. **Verknüpfungen melden:** Abweichung ↔ Tag über `created` (ersatzweise `due`); privates Dashboard ↔ Besitzer
   (Name). Geänderte, nicht mit gewählte Gegenstücke → Hinweis in der Vorschau; fehlender Besitzer → Abbruch.
4. **Konflikte brechen ab, statt zu überschreiben:** Name oder E-Mail eines Kontos wird heute von einem anderen
   Konto benutzt; kein aktiver Administrator mit Passwort mehr; privates Dashboard ohne Besitzer → HTTP 409 mit
   verständlicher Meldung, **nichts** wird geändert.
5. **Erst Vorschau, dann Ausführung:** `dryRun` liefert ersetzt/neu/entfernt/unverändert je Teil und Hinweise, ohne
   zu schreiben und ohne Sicherung. Die Oberfläche erlaubt das Ausführen erst nach einer Vorschau zur **gleichen**
   Auswahl.
6. **Alles oder nichts:** Alle Änderungen in **einer** Transaktion mit `lockRevision`; vor dem Speichern prüft
   `validateResult` das Ergebnis (eindeutige Abweichungsnummern, Zähler, gültige Begründungsschlüssel, Administrator,
   eindeutige Kontonamen, Dashboard-Besitzer) — ein Verstoß bricht ab (Rollback). Danach `bumpRevision`, damit alle
   Geräte neu laden; offene Bearbeitungen anderer scheitern an der Revisionsprüfung (409) statt alte Daten zu schreiben.
7. **Rückweg und Nachweis:** Vor jeder echten Übernahme automatische Sicherung („vor Teil-Wiederherstellung …“);
   Sicherheitsprotokoll mit Teilen, Zeitraum und den betroffenen Datensätzen (`records`, gekürzt).
8. **Testpflicht:** Am Test-Server Daten gezielt ändern/löschen, einzelne Datensätze zurückholen und prüfen, dass genau
   diese stimmen und alles andere unverändert ist; dazu die Abbruchfälle (Namenskonflikt, fehlender Besitzer, leere
   Auswahl) und „Vorschau ändert nichts“ (Vorlage: Skripte wie apitest10/11 aus der Entwicklung).

## Betrieb
- `./deploy.sh` installiert/aktualisiert (Sicherung → `git pull` → bauen → starten); `./deploy.sh config`
  ändert die `.env` (einzige Quelle der Einstellungen; Umgebungsvariablen nur als Eingabe beim ersten Lauf).
  Weitere Befehle: status, logs, backup, admin, users, reset-password, mail-test, smb, checkmk, audit, stop.
- Betriebsarten: `port` (eigener Port, z. B. hinter einem Reverse Proxy auf einem anderen Rechner) oder `proxy`
  (im Docker-Netz eines Proxys wie Nginx Proxy Manager). Das Produktivsystem läuft in `port` hinter einem
  Nginx Proxy Manager auf einem anderen Rechner; auf dem Server läuft ein Checkmk-Agent.
- Einstellungen in der **Oberfläche** (nicht `.env`): Zeitplan/Aufbewahrung der Sicherungen, SMB-Freigabe,
  E-Mail-Versand (`SMTP_*` in der `.env` sind nur Startwerte).
- `APP_SECRET` (von `deploy.sh` erzeugt, nie abgefragt) verschlüsselt SMB-/SMTP-Passwörter; nicht ändern.
- Checkmk: Local Check unter `/usr/lib/check_mk_agent/local/300/shopfloor_<projekt>` (fragt per `docker exec`).
- Erstes Konto wird Administrator; Passwort zurücksetzen: `./deploy.sh reset-password <Name>`.

## Testen
Es gibt keine Testsuite im Repo; geprüft wird mit Playwright (Chromium ist vorinstalliert) und Node-Skripten.
- **Oberfläche im lokalen Modus:** `file:///…/frontend/index.html` öffnen, registrieren über `#modeToggle`,
  `#lFull` (Name), `#lName` (Anmeldename), `#lPass`/`#lPass2`, `#loginSubmit` — Testdaten sind dann vorhanden.
- **Server:** `docker compose` mit Test-`.env` (Projekt z. B. `sftest`, Web-Port 18080). In der Sandbox: Docker-Hub-
  Limit und gesperrte Alpine-Paketquellen — Basis-Images ggf. lokal umtaggen bzw. die API direkt mit Node auf dem
  Host starten (DB-Port freigeben); `smbclient`/Samba per apt auf dem Host für SMB-Tests, einfacher SMTP-Empfänger
  für Mail-Tests. nginx drosselt Anmelde-Endpunkte (10/min) — in API-Tests Pausen einplanen.
- Vor jedem Commit: JS-Syntax der Inline-Skripte prüfen
  (`node -e` mit `new Function(...)` über alle `<script>`-Blöcke), `node --check` für Backend-Dateien,
  `bash -n deploy.sh` (ggf. shellcheck), bei UI-Änderungen auf Seitenfehler und CSP-Verstöße achten.
