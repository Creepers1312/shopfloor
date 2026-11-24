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
- **Dashboards:** Liste mehrerer Dashboards (`dashList`, `currentDash()`, Auswahl `#dashSelect`), Widgets im
  12-Spalten-Raster. Sichtbarkeit `standard` (eingebaut: `standard`, `detail` = „Detaillierte Auswertung“; ändern nur
  manager/admin, `widgets: null` = ausgeliefertes Layout aus `DASH_BUILTIN`), `public` (alle sehen, ändern/löschen
  nur Ersteller + admin), `private` (nur Besitzer). Server: Tabelle `dashboards`, `dashboards.js` (Regeln, Migration
  alter `users.dashboard`-Layouts → private Dashboards), `routes/dashboards.js`; `/api/user/dashboard` speichert nur
  das zuletzt gewählte (`{v:2,current}`). Lokal: `sfm-dashboards-v1`. `sanitizeWidgets` prüft gespeicherte Layouts,
  `DW_MIN` Mindestgrößen. Inhalte passen sich der Fläche an
  (`dwRenderChart` + ResizeObserver, Container-Abfragen). Multigraph: max. 5 Werte, max. 2 Einheiten (Achsen).
- **Berechtigungen** `can()`: viewer (Nur Lesen), editor (Bearbeiten), manager (Teamleitung: + Löschen,
  Stammdaten, Benutzer ohne Admin-Konten), admin (alles). Der Server prüft dasselbe (`http.js`, `users.js`).
- **Anwenderdoku** im Array `DOCS` — bei neuen Funktionen mitpflegen.
- Kopfzeile: Speicherstatus nur bei Problemen; Datum → heutiger Huddle.

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
