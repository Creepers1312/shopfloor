# Shopfloor Board — Digitales Shopfloor Management

Deutsche Web-App für das digitale Shopfloor Management mit SQIDP-Board, Kennzahlen und Huddle.
Läuft als Docker-Compose-Stack mit PostgreSQL. Alle Geräte einer Linie sehen denselben Stand.

## Funktionen

| Bereich | Inhalt |
|---------|--------|
| Dashboard | OEE, First Pass Yield, Termintreue und Tageswerte je Zeitraum (Tag, Arbeitswoche, Monat, Jahr, frei wählbar), eigene Widget-Anordnung je Benutzer, Detaillierte Auswertung mit eigenen, anpassbaren Diagrammen |
| SQIDP-Board | Monatsboard Sicherheit, Qualität, Inventory, Lieferung, Produktivität |
| Maßnahmen | Abweichungen mit Art, PDCA-Phase, Verantwortlichem und 5-Why-Analyse; Schlagwortsuche auch in abgeschlossenen Maßnahmen |
| Abweichungs-Tracking | Alle Abweichungen eines Zeitraums mit Schlagwortsuche, Filtern nach Kategorie, Art und Quelle, Summen je Art und CSV-Export |
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

Voraussetzung: Linux-Server mit Git und `sudo` (oder als root). Docker muss nicht vorinstalliert sein —
fehlt es, richtet das Skript es auf Wunsch mit dem offiziellen Installationsskript (`get.docker.com`) ein.

```bash
git clone https://github.com/Creepers1312/shopfloor.git
cd shopfloor
./deploy.sh
```

Das Skript

1. prüft Docker und Docker Compose (mind. 2.20) und installiert Docker bei Bedarf nach Rückfrage
   (ist der Benutzer nicht in der Gruppe `docker`, läuft dieser Lauf über `sudo`; die Gruppe wird für
   die nächste Anmeldung eingetragen),
2. fragt die Betriebsart ab (siehe unten) und alle Einstellungen (Enter übernimmt den Vorschlag),
   prüft, dass Projektname und Port auf dem Server frei sind, und schreibt alles nach `.env` (Rechte 600),
3. erzeugt ein zufälliges Datenbank-Passwort,
4. legt den Sicherungsordner an,
5. prüft die Compose-Konfiguration, baut die Images und startet die Container,
6. wartet, bis Board und Datenbank antworten,
7. legt beim ersten Mal das Administrator-Konto an,
8. räumt alte Images und Build-Cache (älter als 7 Tage) auf — nie Container, Volumes oder andere Projekte.

Ein Protokoll jedes Laufs landet in `logs/deploy.log`. Alle Optionen: `./deploy.sh --help`.

### Betriebsarten

| Betriebsart | Wann | Ziel im Reverse Proxy |
|-------------|------|------------------------|
| `proxy` | Nginx Proxy Manager, Traefik o. Ä. laufen **als Docker-Container auf demselben Server** (empfohlen) | `http://<projekt>-web:8080`, z. B. `http://shopfloor-web:8080` |
| `port` | Kein Proxy oder ein Proxy auf einem anderen Rechner | `http://<server-ip>:<WEB_PORT>` |

Läuft beim ersten Start bereits ein Reverse-Proxy-Container, schlägt das Skript `proxy` und dessen Docker-Netz
von selbst vor. Der Web-Container hängt sich dann zusätzlich in dieses Netz (`deploy/compose.proxy.yml`),
der Port wird nur noch lokal gebunden, und `TRUSTED_PROXIES` wird auf das Subnetz des Proxy-Netzes gesetzt —
die echte Client-IP für Login-Bremse und Sicherheitsprotokoll stimmt damit ohne Nacharbeit.

### Update

Im selben Ordner einfach erneut:

```bash
./deploy.sh
```

Das Skript erkennt die bestehende Installation, sichert die Datenbank, holt mit `git pull` den neuen Stand
(übersprungen bei lokalen Änderungen oder mit `--no-pull`), startet sich mit dem neuen Code neu, baut und
startet die Container. Die Einstellungen bleiben; neu hinzugekommene bekommen ihren Standard und werden genannt.
`./deploy.sh update` macht dasselbe.

### Ohne Rückfragen

Jede Einstellung lässt sich vorab als Umgebungsvariable setzen. Es gilt: Umgebung → vorhandene `.env` → Standard.
Danach ist allein die `.env` maßgeblich (Umgebungsvariablen überschreiben sie beim Start nicht mehr).

```bash
DEPLOY_MODE=proxy PROXY_NETWORK=npm_default PUBLIC_URL=https://shopfloor.trobox.de \
ADMIN_NAME="Max Mustermann" ADMIN_USERNAME=max.mustermann ADMIN_PASSWORD='…' ./deploy.sh -y
```

## Einstellungen (`.env`)

| Variable | Standard | Bedeutung |
|----------|----------|-----------|
| `COMPOSE_PROJECT_NAME` | `shopfloor` | Präfix für Container, Netze, Volumes |
| `DEPLOY_MODE` | `proxy`, wenn ein Proxy-Container läuft, sonst `port` | Betriebsart (siehe oben) |
| `PROXY_NETWORK` | Netz des erkannten Proxys | Docker-Netz des Reverse Proxys (nur Betriebsart `proxy`) |
| `WEB_BIND` | `0.0.0.0` bzw. `127.0.0.1` bei `proxy` | IP für den Web-Port (`127.0.0.1` = nur lokal) |
| `WEB_PORT` | `8080` | Port des Boards |
| `PUBLIC_URL` | `http://<server-ip>:<port>` | Adresse für Benutzer, bestimmt den Standard für `COOKIE_SECURE` |
| `TZ` | `Europe/Berlin` | Zeitzone |
| `DB_NAME` / `DB_USER` | `shopfloor` | Datenbank und Benutzer |
| `DB_PASSWORD` | zufällig | Datenbank-Passwort |
| `APP_SECRET` | zufällig | Schlüssel für gespeicherte Zugangsdaten (SMB-Passwort); wird erzeugt und nicht abgefragt |
| `ALLOW_REGISTER` | `false` | Selbstregistrierung (das allererste Konto ist immer möglich und wird Administrator) |
| `ALLOW_DEMO` | `false` | Demo-Zugang mit Leserechten auf der Anmeldeseite |
| `SESSION_DAYS` | `14` | Höchstdauer einer Anmeldung |
| `SESSION_IDLE_HOURS` | `12` | Abmeldung nach so vielen Stunden ohne Bedienung (`0` = aus; der TV-Modus zählt als aktiv) |
| `PASSWORD_MIN_LENGTH` | `10` | Mindestlänge für Passwörter (8–128) |
| `SMTP_HOST` | leer | Mailserver für „Passwort vergessen“-Links (leer = keine Mails, Anfragen gehen an die Administration) |
| `SMTP_PORT` / `SMTP_SECURITY` | `587` / `starttls` | Port und Verschlüsselung (`starttls`, `tls` für Port 465, `none`) |
| `SMTP_USER` / `SMTP_PASSWORD` | leer | Anmeldung am Mailserver (leer = ohne Anmeldung) |
| `SMTP_FROM` | leer | Absender, z. B. `Shopfloor Board <shopfloor@firma.de>` |
| `RESET_LINK_MINUTES` | `60` | Gültigkeit eines Links zum Zurücksetzen (10–1440 Minuten) |
| `COOKIE_SECURE` | `true` bei `https://` | Sitzungs-Cookie nur über HTTPS (Name dann `__Host-sfm_session`) |
| `TRUSTED_PROXIES` | leer | IP(s) des Reverse Proxys, dessen `X-Forwarded-For` als Client-IP gilt |
| `AUDIT_DAYS` | `365` | Aufbewahrung des Sicherheitsprotokolls in Tagen (nur in `docker-compose.yml`/Umgebung) |
| `BACKUP_PATH` | `./backups` | Sicherungsordner auf dem Host |
| `BACKUP_ENABLED` / `BACKUP_TIME` / `BACKUP_KEEP` | `true` / `02:00` / `14` | Standard für die tägliche Sicherung (danach in der Oberfläche änderbar) |

Ändern: `./deploy.sh config`, danach `./deploy.sh`. `COMPOSE_FILE` ergibt sich aus der Betriebsart und wird nicht von Hand gepflegt.

> **Achtung:** `DB_PASSWORD` nachträglich in der `.env` zu ändern, ändert es nicht in der bestehenden Datenbank. Das Skript warnt in diesem Fall.

## Hinter Nginx Proxy Manager

**NPM als Docker-Container auf demselben Server (Betriebsart `proxy`, empfohlen):**

1. `./deploy.sh` ausführen; Betriebsart `proxy` und das NPM-Netz werden vorgeschlagen.
   `PUBLIC_URL=https://shopfloor.trobox.de`, damit wird `COOKIE_SECURE=true`.
2. In NPM einen Proxy Host `shopfloor.trobox.de` anlegen: Schema `http`, Host `shopfloor-web`, Port `8080`
   (bei anderem Projektnamen `<projekt>-web`). SSL-Zertifikat zuweisen, „Force SSL“, „HTTP/2“ und „HSTS“ an.
3. Fertig — `TRUSTED_PROXIES` ist bereits auf das Proxy-Netz gesetzt.

**NPM auf einem anderen Rechner (Betriebsart `port`):**

1. `PUBLIC_URL=https://shopfloor.trobox.de`, damit wird `COOKIE_SECURE=true`.
2. In NPM einen Proxy Host `shopfloor.trobox.de` → `http://<server-ip>:<WEB_PORT>` anlegen, SSL-Zertifikat zuweisen, „Force SSL“ und „HSTS“ an.
3. `TRUSTED_PROXIES` auf die IP des NPM-Rechners setzen (`./deploy.sh config`, danach `./deploy.sh`) — sonst sehen
   Login-Bremse und Sicherheitsprotokoll alle Zugriffe als „von NPM“. Die IP steht nach dem ersten Aufruf im
   Protokoll (*Einstellungen → Sicherheitsprotokoll*, Spalte IP-Adresse).

In beiden Fällen: wenn möglich in NPM eine Access List anlegen, die nur das Firmennetz bzw. VPN zulässt.

Ohne HTTPS funktioniert das Board im LAN ebenfalls. Passwörter gehen dann aber ungeschützt über das Netz.

## Betrieb

```bash
./deploy.sh status               # Container und Health-Check
./deploy.sh logs [web|api|db]    # Logs verfolgen
./deploy.sh                      # Update: Sicherung → git pull → neu bauen → starten
./deploy.sh backup "Notiz"       # Sicherung sofort
./deploy.sh users                # Konten auflisten
./deploy.sh admin                # weiteres Admin-Konto anlegen
./deploy.sh reset-password Name  # Passwort neu setzen (entsperrt das Konto, meldet es überall ab)
./deploy.sh mail-test adresse    # Testmail über die SMTP-Einstellungen senden
./deploy.sh smb                  # Verbindung zur SMB-Freigabe prüfen, fehlende Sicherungen kopieren
./deploy.sh audit [50]           # letzte Einträge des Sicherheitsprotokolls
./deploy.sh stop                 # Container stoppen, Daten bleiben
```

### Konten und „Passwort vergessen“

- Jedes Konto hat einen **Anzeigenamen** (in Listen und Protokollen), einen **Anmeldenamen** (Kleinbuchstaben, Ziffern,
  `.`, `_`, `-`) und optional eine **E-Mail-Adresse**. Angemeldet wird mit Anmeldename oder E-Mail.
- Bestehende Konten erhalten beim Update automatisch einen Anmeldenamen aus dem Namen (z. B. „Jörg Müller“ →
  `joerg.mueller`); `./deploy.sh users` zeigt ihn an. Ändern unter *Einstellungen → Benutzerverwaltung → Bearbeiten*.
- *Passwort vergessen?* auf der Anmeldeseite: Ist `SMTP_HOST` gesetzt und hat das Konto eine E-Mail, kommt ein Link
  (gültig `RESET_LINK_MINUTES`, nur einmal nutzbar, beendet alle Sitzungen). Sonst landet eine Anfrage in der
  Benutzerverwaltung, Administratoren werden nach der Anmeldung darauf hingewiesen.
- Die Antwort ist immer gleich — ob ein Konto existiert, verrät die Seite nicht. Höchstens 3 Anfragen je Konto und Stunde.
- Für korrekte Links `PUBLIC_URL` auf die Adresse setzen, unter der Benutzer das Board öffnen.
- Einrichten: `./deploy.sh config` (SMTP-Fragen), `./deploy.sh`, dann `./deploy.sh mail-test adresse@firma.de`.

### Testdaten

Am Server startet das Board leer — Testdaten gibt es nur, wenn `frontend/index.html` ohne Server geöffnet wird.
Sind trotzdem Daten zu entfernen (z. B. nach einem Probebetrieb): *Einstellungen → Datenbank & Sicherung →
Alle Board-Daten löschen*. Das löscht Board, Kennzahlen, Maßnahmen und Huddle-Protokoll nach einer automatischen
Sicherung; Konten und Einstellungen bleiben.

### Ressourcen und Logs

In `docker-compose.yml` sind Obergrenzen je Container hinterlegt: `db` 1 GB / 2 CPUs, `api` 512 MB / 1 CPU, `web` 128 MB / 0,5 CPU.
Bei Bedarf dort anpassen und `./deploy.sh` ausführen. Container-Logs sind auf 3 Dateien à 10 MB je Container begrenzt.

Der `web`-Container läuft ohne Root-Rechte (`nginx-unprivileged`) und lauscht intern auf Port 8080.
Nach außen gilt weiterhin `WEB_PORT`. `web` und `api` laufen mit schreibgeschütztem Dateisystem, ohne
Linux-Sonderrechte (`cap_drop: ALL`) und mit `no-new-privileges`; das gilt auch für `db`.

## Sicherungen

- Täglich automatisch zur eingestellten Uhrzeit, alte automatische Sicherungen werden nach `BACKUP_KEEP` entfernt.
- Von Hand in der Oberfläche unter *Einstellungen → Datenbank & Sicherung* oder per `./deploy.sh backup`.
- Vor jedem `./deploy.sh` und vor jeder Wiederherstellung wird der aktuelle Stand automatisch gesichert.
- Dateien: `backups/shopfloor_<datum>_<auto|manual>.dump` (PostgreSQL-Custom-Format, Tabellen `documents` und `users`).
  Für den Ernstfall zusätzlich auf ein NAS kopieren (siehe unten) und die Wiederherstellung einmal ausprobieren.
- Die Sicherungen enthalten die Passwort-Hashes. Ordner und Dateien sind deshalb nur für den Besitzer lesbar (`700`/`600`).
- **Herunterladen:** In der Liste *Vorhandene Sicherungen* lädt „Herunterladen“ die `.dump`-Datei direkt im Browser
  (nur Administratoren, wird protokolliert).
- **Zurückspielen aus einer Datei:** Eine `.dump`-Datei in den Sicherungsordner kopieren — sie erscheint in der Liste
  („im Sicherungsordner gefunden“) und lässt sich wiederherstellen.

### Kopie auf eine SMB-Freigabe (NAS)

Zusätzlich zum lokalen Ordner kann jede Sicherung auf eine Windows-/NAS-Freigabe kopiert werden. Eingestellt wird alles
in der Oberfläche unter *Einstellungen → Datenbank & Sicherung → Kopie auf SMB-Freigabe*:

1. Freigabe eintragen, z. B. `//nas.firma.local/backup/shopfloor` (`\\nas\backup\shopfloor` geht auch; fehlende
   Ordner unterhalb der Freigabe werden beim Test angelegt), dazu Benutzer, Passwort und ggf. Domäne.
2. „Verbindung testen“ — meldet verständlich, ob Server, Anmeldung, Ordner oder Rechte nicht passen.
3. „Kopie aktiv“ einschalten und speichern — der Server gleicht sofort ab.

Verhalten:
- Der API-Container überträgt mit `smbclient` (SMB 2/3); auf dem Host muss nichts eingehängt oder installiert werden.
  Der Server braucht Zugriff auf Port 445 des NAS.
- Lokale Sicherungen laufen immer, auch wenn das NAS nicht erreichbar ist; fehlende Kopien werden nach jeder Sicherung
  und stündlich nachgeholt. Der Status steht oben auf der Seite, Fehler zusätzlich im Sicherheitsprotokoll.
- Auf der Freigabe bleiben die neuesten *n* automatischen (einstellbar) und alle manuellen Sicherungen. Löschen in der
  Oberfläche entfernt nur die Datei auf dem Server.
- Das Passwort wird AES-256-GCM-verschlüsselt in der Datenbank gespeichert (Schlüssel `APP_SECRET` aus der `.env`,
  erzeugt von `deploy.sh`) und nie wieder ausgeliefert. Es steckt nicht in den Sicherungsdateien. Wird `APP_SECRET`
  geändert, muss das Passwort neu eingegeben werden.
- Der Benutzer an der Freigabe braucht Schreib- und Löschrechte im Zielordner.
- `./deploy.sh smb` prüft die Verbindung von der Kommandozeile aus und kopiert fehlende Sicherungen.

## Sicherheit

**Anmeldung und Konten**
- Passwörter gehen über die (HTTPS-)Verbindung zum Server, der Mindestlänge und Regeln prüft, und werden nur als
  scrypt-Hash mit Salt gespeichert — nie im Klartext und nie im Protokoll.
- Passwörter werden nur über eigene Endpunkte gesetzt (Konto anlegen, Passwort zurücksetzen, eigenes Passwort ändern),
  nie über die gemeinsame Benutzerliste. Ein neues Passwort beendet alle anderen Sitzungen des Kontos; gesperrte und
  gelöschte Konten verlieren ihre Sitzungen sofort.
- Anmeldung mit Anmeldename oder E-Mail; der Anzeigename allein reicht nicht.
- Login-Bremse: 10 Fehlversuche je IP und Name, 30 je IP, 50 je Name in 15 Minuten; dazu drosselt Nginx Anmeldungen auf
  10 pro Minute und IP. Die Client-IP ermittelt Nginx — ein vom Browser mitgeschickter `X-Forwarded-For` zählt nicht.

**Sitzungen**
- HttpOnly-Cookie mit `SameSite=Strict`, über HTTPS mit `Secure` und `__Host-`-Präfix; in der Datenbank liegt nur ein Hash des Tokens.
- Abmeldung nach `SESSION_IDLE_HOURS` ohne Bedienung (Server und Oberfläche), höchstens nach `SESSION_DAYS`.
- Schreibende Anfragen müssen von genau dieser Adresse kommen (Origin- und `Sec-Fetch-Site`-Prüfung) —
  auch andere Subdomains derselben Domain sind ausgeschlossen.

**Rechte und Daten**
- Rechte prüft der Server: *Nur Lesen* kann nichts speichern; Konten, Sicherungen und das Protokoll sind Administratoren
  vorbehalten. In den Einstellungen dürfen Bearbeiter nur die Unfallchronik (Huddle) und das Versandprotokoll ändern.
- Das SMTP-Passwort des Versandprotokolls (Oberfläche) wird am Server nicht gespeichert und nicht ausgeliefert;
  das Server-Postfach für Passwort-Links (`SMTP_PASSWORD`) steht nur in der `.env` (Rechte `600`).
- E-Mail-Adressen anderer Konten sehen nur Administratoren. Links zum Zurücksetzen sind zufällig (256 Bit), in der
  Datenbank liegt nur ihr Hash.
- Ohne Anmeldung liefert die API keine Daten aus. Größenlimit 25 MB nur für Dokumente, sonst 32 KB.
- Sicherheitsprotokoll für Anmeldungen, Fehlversuche, Konten, Sicherungen und Speichervorgänge
  (*Einstellungen → Sicherheitsprotokoll* oder `./deploy.sh audit`).

**Auslieferung**
- Content-Security-Policy: Es laufen nur die mitgelieferten Skripte (Hashes werden beim Bauen aus `index.html` berechnet,
  `frontend/csp-hashes.js`); keine externen Quellen. Die Schrift Inter liegt in `frontend/fonts/` (kein Google-Abruf).
- Weitere Header: HSTS, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`.
- Die Datenbank hängt in einem internen Docker-Netz ohne veröffentlichten Port; Container gehärtet (siehe oben).
- Dependabot meldet wöchentlich Updates für npm-Pakete und Basis-Images (`.github/dependabot.yml`);
  `./deploy.sh` baut bei jedem Update mit aktuellen Basis-Images neu.

**Bewusst noch offen**
- Bearbeiter speichern das Board als Ganzes. Feinere Rechte (z. B. nur eigene Maßnahmen ändern) bräuchten einzelne
  API-Endpunkte statt eines Gesamtdokuments; bis dahin fangen Sicherungen und das Protokoll Fehlbedienungen ab.
- Keine Zwei-Faktor-Anmeldung. Für Zugriff aus dem Internet besser VPN oder eine NPM-Access-List vorschalten.

## Ohne Server

`frontend/index.html` lässt sich auch einfach im Browser öffnen. Ohne erreichbare API läuft das Board im lokalen Modus und speichert alles im Browser.
Das ist nur zum Ausprobieren gedacht: Konten und Rechte liegen dann im Browser und schützen nichts.
