# Shopfloor Board — Digitales Shopfloor Management

Deutsche Web-App für das digitale Shopfloor Management mit SQIDP-Board, Kennzahlen und Huddle.
Läuft als Docker-Compose-Stack mit PostgreSQL. Alle Geräte einer Linie sehen denselben Stand.

## Funktionen

| Bereich | Inhalt |
|---------|--------|
| Dashboard | OEE, First Pass Yield, Termintreue und Tageswerte je Zeitraum (Tag, Arbeitswoche, Monat, Jahr, frei wählbar), eigene Widget-Anordnung je Benutzer, Detaillierte Auswertung mit Diagrammen |
| SQIDP-Board | Monatsboard Sicherheit, Qualität, Inventory, Lieferung, Produktivität |
| Maßnahmen | Abweichungen mit Art, PDCA-Phase, Verantwortlichem und 5-Why-Analyse |
| Abweichungs-Tracking | Alle Abweichungen eines Zeitraums mit Filtern nach Kategorie, Art und Quelle, Summen je Art und CSV-Export |
| Daily Huddle | Kalender, Timer mit Start, Pause und Zurücksetzen, geführte Agenda, Erfassung der Tageskennzahlen, „Huddle ENDE“ |
| Tagesbericht | Bericht je Tag, Versand per E-Mail |

Die Produktionsmenge wird in drei Teile erfasst: Gutmenge im ersten Durchlauf (First Pass Yield), mit Nacharbeit verwendbar und Ausschuss (Absandung / Kreislaufmaterial).

## Aufbau

```
                 ┌──────────────── Netz "frontend" ───────────────┐
Browser ──► :8080│  web  (Nginx)  ──/api──►  api  (Node.js)        │
                 └──────────────────────────────┬─────────────────┘
                                                │ Netz "backend" (intern, ohne Internet)
                                                ▼
                                          db  (PostgreSQL 17)
```

| Container | Aufgabe | Erreichbar |
|-----------|---------|------------|
| `web` | liefert die Oberfläche aus, leitet `/api` weiter | einziger veröffentlichter Port (`WEB_PORT`) |
| `api` | Anmeldung, Daten, Abgleich zwischen Geräten, Sicherungen (`pg_dump`) | nur intern |
| `db`  | PostgreSQL, Daten im Volume `<projekt>_db-data` | nur für `api` |

```
frontend/   index.html (die App), nginx.conf, Dockerfile
backend/    API-Server (Express + pg), Dockerfile
docker-compose.yml
deploy.sh   Installation, Update, Verwaltung
.env.example
```

## Installation

Voraussetzung: Linux-Server mit Docker und dem Compose-Plugin.

```bash
git clone https://github.com/Creepers1312/shopfloor.git
cd shopfloor
./deploy.sh
```

Das Skript

1. fragt alle Einstellungen ab (Enter übernimmt den Vorschlag) und schreibt sie nach `.env` (Rechte 600),
2. erzeugt ein zufälliges Datenbank-Passwort,
3. legt den Sicherungsordner an,
4. baut die Images und startet die Container,
5. wartet, bis Board und Datenbank antworten,
6. legt beim ersten Mal das Administrator-Konto an.

Ein Protokoll jedes Laufs landet in `logs/deploy.log`.

### Ohne Rückfragen

Jede Einstellung lässt sich vorab als Umgebungsvariable setzen. Es gilt: Umgebung → vorhandene `.env` → Standard.

```bash
WEB_PORT=8090 PUBLIC_URL=https://shopfloor.trobox.de \
ADMIN_NAME="Luca" ADMIN_PASSWORD='…' ./deploy.sh -y
```

## Einstellungen (`.env`)

| Variable | Standard | Bedeutung |
|----------|----------|-----------|
| `COMPOSE_PROJECT_NAME` | `shopfloor` | Präfix für Container, Netze, Volumes |
| `WEB_BIND` | `0.0.0.0` | IP für den Web-Port (`127.0.0.1` = nur lokal, z. B. wenn der Reverse Proxy auf demselben Host läuft) |
| `WEB_PORT` | `8080` | Port des Boards |
| `PUBLIC_URL` | `http://<server-ip>:<port>` | Adresse für Benutzer, bestimmt den Standard für `COOKIE_SECURE` |
| `TZ` | `Europe/Berlin` | Zeitzone |
| `DB_NAME` / `DB_USER` | `shopfloor` | Datenbank und Benutzer |
| `DB_PASSWORD` | zufällig | Datenbank-Passwort |
| `ALLOW_REGISTER` | `false` | Selbstregistrierung (das allererste Konto ist immer möglich und wird Administrator) |
| `ALLOW_DEMO` | `false` | Demo-Zugang mit Leserechten auf der Anmeldeseite |
| `SESSION_DAYS` | `14` | Gültigkeit einer Anmeldung |
| `COOKIE_SECURE` | `true` bei `https://` | Sitzungs-Cookie nur über HTTPS |
| `TRUST_PROXY` | private Netze | Proxys, deren `X-Forwarded-For` übernommen wird |
| `BACKUP_PATH` | `./backups` | Sicherungsordner auf dem Host |
| `BACKUP_ENABLED` / `BACKUP_TIME` / `BACKUP_KEEP` | `true` / `02:00` / `14` | Standard für die tägliche Sicherung (danach in der Oberfläche änderbar) |

Ändern: `./deploy.sh config`, danach `./deploy.sh -y`.

> **Achtung:** `DB_PASSWORD` nachträglich in der `.env` zu ändern, ändert es nicht in der bestehenden Datenbank. Das Skript warnt in diesem Fall.

## Hinter Nginx Proxy Manager

1. `PUBLIC_URL=https://shopfloor.trobox.de`, damit wird `COOKIE_SECURE=true`.
2. In NPM einen Proxy Host `shopfloor.trobox.de` → `http://<server-ip>:<WEB_PORT>` anlegen, SSL-Zertifikat zuweisen, „Force SSL“ an.
3. Läuft NPM auf demselben Host, `WEB_BIND=127.0.0.1` setzen. Dann ist das Board nur noch über den Proxy erreichbar.

Ohne HTTPS funktioniert das Board im LAN ebenfalls. Passwörter gehen dann aber ungeschützt über das Netz.

## Betrieb

```bash
./deploy.sh status               # Container und Health-Check
./deploy.sh logs [web|api|db]    # Logs verfolgen
./deploy.sh update               # git pull → Sicherung → neu bauen → starten
./deploy.sh backup "Notiz"       # Sicherung sofort
./deploy.sh users                # Konten auflisten
./deploy.sh admin                # weiteres Admin-Konto anlegen
./deploy.sh reset-password Name  # Passwort neu setzen (entsperrt das Konto)
./deploy.sh stop                 # Container stoppen, Daten bleiben
```

## Sicherungen

- Täglich automatisch zur eingestellten Uhrzeit, alte automatische Sicherungen werden nach `BACKUP_KEEP` entfernt.
- Von Hand in der Oberfläche unter *Einstellungen → Datenbank & Sicherung* oder per `./deploy.sh backup`.
- Vor jedem `./deploy.sh` und vor jeder Wiederherstellung wird der aktuelle Stand automatisch gesichert.
- Dateien: `backups/shopfloor_<datum>_<auto|manual>.dump` (PostgreSQL-Custom-Format, Tabellen `documents` und `users`).
  Für den Ernstfall regelmäßig auf ein NAS kopieren.

## Sicherheit

- Passwörter verlassen den Browser nur als SHA-256 und werden in der Datenbank zusätzlich mit scrypt und Salt gespeichert.
- Sitzung per HttpOnly-Cookie (`SameSite=Lax`). Nach 10 Fehlversuchen sperrt die Anmeldung für 15 Minuten.
- Rechte werden auf dem Server geprüft: *Nur Lesen* kann nichts speichern, Konten und Sicherungen sind Administratoren vorbehalten.
- Ohne Anmeldung liefert die API keine Daten aus.
- Die Datenbank hängt in einem internen Docker-Netz ohne veröffentlichten Port.

## Ohne Server

`frontend/index.html` lässt sich auch einfach im Browser öffnen. Ohne erreichbare API läuft das Board im lokalen Modus und speichert alles im Browser.
