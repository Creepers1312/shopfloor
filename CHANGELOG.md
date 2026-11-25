# Changelog

Alle nennenswerten Änderungen am Shopfloor Board. Aufbau nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Hauptversion bei Änderungen, die ein Eingreifen
beim Update verlangen, Nebenversion für neue Funktionen, Patch für reine Fehlerbehebungen.

Die Versionsnummer steht in `backend/package.json` (erscheint unter `/api/health` und in der Checkmk-Ausgabe) und
als `SCRIPT_VERSION` in `deploy.sh`.

## [Unveröffentlicht]

### Neu
- **Monatsbericht per E-Mail (automatisch):** Unter Einstellungen → E-Mail-Versand lässt sich ein Monatsbericht
  einrichten. Der Server schickt am eingestellten Tag (1–28, mit Uhrzeit) eine Übersicht des Vormonats an einen
  eigenen Verteiler: OEE, First Pass Yield, Termintreue mit Vormonatsvergleich, SQIDP-Grünquote, Produktion,
  Ausfälle je Art, Arbeitssicherheit und Maßnahmen — mit Ampelfarben. Mit Vorschau, „Probe an mich“, „Jetzt an
  Verteiler senden“ und Anzeige des letzten Versands; bei Fehlern stündlicher neuer Versuch.
- **Profilbild:** Unter „Mein Konto“ lässt sich ein Foto hochladen (JPEG, PNG oder WebP). Es wird im Browser
  quadratisch zugeschnitten und verkleinert und erscheint oben rechts und in der Benutzerverwaltung. Teamleitung
  und Administration können unpassende Bilder entfernen („Bild entfernen“). Profilbilder sind in den Sicherungen
  enthalten und werden beim Löschen eines Kontos mit entfernt.
- **Grenzwerte (Ampel) in den Stammdaten:** Ausschuss-Toleranz in % der produzierten Menge (Standard 2 %) und
  ungeplante Ausfälle in Stunden je Tag (Standard 1,5 h). Bis zum Grenzwert werden die Werte gelb, darüber rot
  markiert — im Dashboard, im Tagesbericht, im Kennzahlen-Fenster des Huddles und im TV-Modus.
- **SQIDP-Board: Abweichungen im Tagesfenster:** Ein Klick auf eine Zelle zeigt jetzt alle Abweichungen des Tages
  in dieser Kategorie mit Begründung (fehlende Begründungen hervorgehoben) sowie geplante Stillstände — nicht mehr
  nur die Maßnahmen.

### Geändert
- **„Mein Konto“ aufgeräumt:** Die Passwortfelder erscheinen erst nach einem Klick auf „Passwort ändern …“.
  Nach dem bisherigen Passwort wird nur gefragt, wenn E-Mail oder Passwort geändert werden; wer nur die
  Darstellung umstellt, schließt das Fenster einfach.

### Entfernt
- Tagesbericht: Knopf „Per E-Mail senden“ (Bericht als Text im eigenen E-Mail-Programm) — für den Versand gibt es
  den automatischen Monatsbericht; der Tagesbericht bleibt als Ansicht und PDF.

## [1.5.0] – 2026-11-25

### Neu
- **Messbereich selbst angeben:** Beim Bearbeiten eines Diagramms (und der Karten First Pass Yield und
  Termintreue) gibt es neben „Automatisch“ und „0–100 %“ die Option „Selbst angeben“ mit „von“ und „bis“ je
  Achse. Leere Grenzen werden automatisch bestimmt.
- **Helle oder dunkle Darstellung wählbar:** Unter „Mein Konto“ (Klick auf den eigenen Namen oben rechts) gibt es
  „Automatisch“ (wie das Gerät), „Hell“ und „Dunkel“. Die Wahl gilt sofort und wird je Konto auf dem Gerät
  gespeichert; „Mein Konto“ ist dafür jetzt auch im lokalen Testmodus erreichbar.

### Geändert
- Bei Bestandswerten (Inventory, Inventory-Grenzwert) zeigen die Diagramme keinen Durchschnitt mehr, nur den
  aktuellen Stand.

## [1.4.0] – 2026-11-24

### Neu
- **TV-Modus neu für den Hallenmonitor:** vier automatisch wechselnde Seiten in großer Schrift und
  Alltagssprache — „Auf einen Blick“ (Tage ohne Unfall, SQIDP-Status, produziert gegenüber Plan, Ausschuss,
  Stillstand, pünktliche Lieferungen), „Monat“ (SQIDP-Board), „Kennzahlen“ (mit Verlauf und Erklärung) und
  „Abweichungen & Maßnahmen“ (Begründungen, wer macht was bis wann). Hinweis auf den nächsten Huddle (blinkt
  während des Huddles), dunkle oder helle Darstellung, Vollbild-Knopf, Pause; die Bedienleiste erscheint nur bei
  Mausbewegung oder Berührung. Der Bildschirm bleibt an, und um Mitternacht aktualisiert sich die Anzeige von selbst.
- **Höhe der Diagrammachse wählbar:** Diagramme sowie die Karten First Pass Yield und Termintreue lassen sich auf
  „Automatisch“ (Achse passt sich den Werten an) oder „Fest: 0–100 %“ stellen — beim Hinzufügen oder über ✎ im
  Anpassen-Modus. Bei fester Achse beginnen andere Einheiten (t, h) bei 0.

### Geändert
- **Anwenderdoku komplett überarbeitet:** 25 Themen in fünf Gruppen (Grundlagen, Täglicher Ablauf, Auswertung,
  Regeln & Kennzahlen, Verwaltung) mit Bildschirmfotos, Prozessabläufen (z. B. Daily Huddle, Abweichung begründen,
  PDCA) und Schritt-für-Schritt-Anleitungen. Neu sind Themenliste mit Suche, Blättern zum nächsten Thema und
  Vergrößern der Bilder per Klick.
- **Dashboards übersichtlicher:** Die Dashboard-Knöpfe sind in die Kopfzeile neben „Datensicherung“,
  „CSV-Export“ und „Huddle starten“ gewandert. Ein Knopf mit dem Namen des aktuellen Dashboards öffnet ein Menü:
  oben alle Dashboards zum Wechseln (Standard, Öffentlich, Privat), darunter „Dashboard anpassen“, „Kopie
  erstellen“, „Einstellungen“ und „Neues Dashboard“. Beim Anpassen erscheint eine eigene, hervorgehobene Leiste
  mit „+ Widget hinzufügen“, „Ursprüngliches Layout“ und „Fertig“.

### Behoben
- In den Einstellungen überlagerte die Seitenleiste auf schmalen Bildschirmen beim Scrollen den Inhalt.
- Die Zeitraum-Auswahl im Dashboard ragte auf schmalen Bildschirmen (Handy) über den Rand hinaus.

## [1.3.0] – 2026-11-24

### Neu
- **Dashboard-Liste:** Auswahl mehrerer Dashboards im Dashboard. Jede Person kann eigene Dashboards anlegen —
  **privat** (nur für sich) oder **öffentlich** (für alle sichtbar) —, leer oder als Kopie eines bestehenden
  („Kopie erstellen“). Öffentliche Dashboards ändern und löschen nur Ersteller:in und Administration. Das zuletzt
  gewählte Dashboard bleibt je Konto gespeichert.
- **Versionsanzeige:** Die installierte Version steht auf der Anmeldeseite, in den Einstellungen unter „Hilfe“
  und bei „Datenbank & Sicherung“.

### Geändert
- **Standard-Dashboards:** Das bisherige Dashboard heißt „Standard“ und ist für alle gleich; anpassen dürfen es
  Teamleitung und Administration („Ursprüngliches Layout“ setzt es zurück).
- **Detaillierte Auswertung** ist jetzt ein auswählbares Standard-Dashboard statt eines eigenen Vollbilds; der
  bisherige Knopf entfällt.
- Bisherige persönliche Layouts werden beim Update automatisch als private Dashboards „Mein Dashboard“ bzw.
  „Meine Auswertung“ übernommen und vorausgewählt.
- Sicherungen enthalten zusätzlich die Dashboards.

## [1.2.0] – 2026-11-24

### Neu
- **Revisionstag im Huddle:** Knopf „Revision“ (im Huddle und im Kennzahlen-Fenster) öffnet ein vereinfachtes
  Fenster nur mit Sicherheit, Inventory und Lieferung. Geplante Produktionsausfälle werden auf 24 h gesetzt (Art
  wählbar, Begründung „Revision“ vorbelegt), alle übrigen Produktions- und Ausfallwerte auf 0. Abweichungen bei
  Sicherheit, Inventory oder Lieferung verlangen die Begründung direkt im Fenster; danach sind alle Punkte
  besprochen. Revisionstage tragen im Huddle-Kalender ein „R“.
- **Alle Huddle-Werte als Widgets:** zusätzlich Technische Anlagenverfügbarkeit, Laufzeit, Gutmenge 1. Durchlauf
  und die acht Ausfallarten (ungeplant/geplant × Personen, Technisch, Organisatorisch, Rüsten) — als Kachel und
  im Diagramm, Auswahl nach Einheiten gruppiert.
- **Multigraph mit zwei Einheiten:** bis zu fünf Werte mit linker und rechter Achse (eigene Skala und Einheit);
  Legende und Tooltip nennen die Einheit je Wert.
- `CHANGELOG.md` eingeführt; Projektnotizen für künftige Arbeiten in `CLAUDE.md`.

### Geändert
- **Dashboard-Widgets passen ihren Inhalt der Größe an:** Die Verlaufslinie der Kennzahl-Karten wird in der
  echten Fläche gezeichnet, der OEE-Ring wächst mit, Diagramme blenden bei wenig Platz erst Ø/Min/Max und dann die
  Legende aus, die Monatsbilanz bleibt eine Reihe. Kein Scrollen und kein Abschneiden mehr.
- „Besprochen“ gilt im Huddle nur noch, solange alle Abweichungen und geplanten Stillstände begründet sind.
  Punkte mit fehlender Begründung zeigen gelb „Begründung fehlt“ statt grün.
- Diagrammachsen zeigen keine negativen Werte mehr, wenn es keine negativen Werte gibt.

### Behoben
- Wurde im Huddle eine Begründung gelöscht, blieb der Punkt „✓ Besprochen“ (grün). Jetzt wird der Haken
  entfernt; nach dem Nachtragen muss der Punkt erneut abgehakt werden.
- Bei Ausfällen, die nach Art erfasst wurden, fehlten die Summen „Ungeplante/Geplante Produktionsausfälle“ in
  Diagrammen, Kacheln, TV-Modus und Tagesbericht.
- Kennzahl-Karten liefen bei breiten Widgets nach unten über (z. B. auf 1920-px-Bildschirmen); schmale
  Diagramm-Widgets wurden unten abgeschnitten; die Monatsbilanz lief in kleinen Größen über.

## [1.1.0] – 2026-11-12

### Neu
- **Konten mit Anmeldename und E-Mail;** Anmeldung mit Anmeldename oder E-Mail. Bestehende Konten erhalten beim
  Update automatisch einen Anmeldenamen aus dem Namen. (#7)
- **„Passwort vergessen“:** einmaliger Link per E-Mail (gültig `RESET_LINK_MINUTES`), ohne Mailserver eine Anfrage
  an die Administration; „Mein Konto“ für eigene E-Mail und Passwort. (#7)
- **Sicherungen:** Download in der Oberfläche, Kopie auf eine SMB-Freigabe (in der Oberfläche einstellbar,
  Passwort verschlüsselt), Dateien im Sicherungsordner erscheinen in der Liste und lassen sich wiederherstellen. (#8)
- **Checkmk-Überwachung:** Local Check mit den Diensten „Shopfloor Board“, „Shopfloor Backup“ und
  „Shopfloor Backup SMB“ (`./deploy.sh checkmk`). (#8)
- **E-Mail-Versand in der Oberfläche einstellbar** (Mailserver, Absender, verschlüsseltes Passwort, „Verbindung
  testen“, „Test-E-Mail senden“); `SMTP_*` aus der `.env` sind nur noch Startwerte. (#9)
- **Berechtigung „Teamleitung“:** Stammdaten und Benutzerverwaltung ohne Administrator-Konten; E-Mail-Versand,
  Sicherungen und Sicherheitsprotokoll bleiben der Administration vorbehalten. (#10)
- **E-Mails als HTML** mit Logo, Linienname und Textfassung. (#11)

### Geändert
- Backend aufgeteilt (`routes/`, `http.js`), gemeinsame Verschlüsselung für gespeicherte Zugangsdaten
  (`APP_SECRET`, erzeugt `deploy.sh`). (#9)
- Kopfzeile ohne „Datenbank verbunden“ — erscheint nur noch bei Speicherproblemen. (#8)

### Behoben
- Die Liste der Sicherungen blieb in der Oberfläche immer leer, daher war auch „Herunterladen“ nicht sichtbar. (#8)

## [1.0.0] – 2026-11-11

### Neu
- **Abweichungs-Tracking** mit Zeitraumfilter (Tag, Arbeitswoche, Monat, Jahr, Zeitraum), Kategorie-/Arten-Filter,
  Summen und Stichwortsuche. (#1)
- **Kennzahlen:** First Pass Yield getrennt von Nacharbeit und Ausschuss, Fakturierte Menge, Inventory-Grenzwert
  als Vorgabe in den Stammdaten. (#1)
- **Huddle:** Pause, „Huddle ENDE“ (springt ins Dashboard), geplante Stillstände begründungspflichtig,
  Sicherheitsauswahl (Kein Unfall – Beinahe-Unfall – Nicht meldepflichtiger – Meldepflichtiger Unfall),
  „Besprochen“ wird bei geänderten Werten zurückgesetzt. (#1)
- „Aktuelle Arbeitswoche“ in allen Zeitraum-Auswahlen; anpassbare Widgets auch in der Detaillierten Auswertung;
  Stichwortsuche bei den Maßnahmen. (#1)
- **Sicherheit:** Content-Security-Policy, sichere Sitzungen, Login-Bremse, Sicherheitsprotokoll, gehärtete
  Container. (#1)
- **deploy.sh** installiert Docker bei Bedarf, Betriebsarten `port` und `proxy` (Nginx Proxy Manager), `.env`
  als einzige Quelle der Einstellungen. (#1)
- Favicon aus dem Firmenlogo. (#6)

### Geändert
- Am Server startet das Board leer (Testdaten nur ohne Server). Kopfzeile anklickbar (Datum → Huddle),
  Menü mit fester Breite. (#6)

## [0.1.0] – 2026-11-06

### Neu
- Erste Version des Shopfloor Boards (SQIDP-Board, Dashboard, Maßnahmen, Huddle, Tagesbericht) und
  Docker-Compose-Stack mit API, PostgreSQL und Deploy-Skript.

[Unveröffentlicht]: https://github.com/Creepers1312/shopfloor/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/Creepers1312/shopfloor/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/Creepers1312/shopfloor/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/Creepers1312/shopfloor/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Creepers1312/shopfloor/compare/5b2d566...v1.2.0
[1.1.0]: https://github.com/Creepers1312/shopfloor/compare/856e513...5b2d566
[1.0.0]: https://github.com/Creepers1312/shopfloor/compare/fd36899...856e513
[0.1.0]: https://github.com/Creepers1312/shopfloor/commit/fd36899
