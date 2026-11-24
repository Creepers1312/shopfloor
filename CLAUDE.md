# Hinweise für Arbeiten an diesem Repository

## Changelog pflegen (Pflicht)
- Jede Änderung, die Anwender oder Betrieb betrifft (neue Funktion, geändertes Verhalten, Fehlerbehebung,
  neue Einstellung, Sicherheitsrelevantes), kommt im selben Commit/PR in `CHANGELOG.md` unter
  **„[Unveröffentlicht]“** — in die passende Rubrik „Neu“, „Geändert“, „Behoben“ oder „Entfernt“.
- Kurz und aus Anwendersicht auf Deutsch formulieren; technische Details gehören in Commit und PR.
- Rein interne Änderungen (Tests, Kommentare, Formatierung) brauchen keinen Eintrag.
- Beim Zusammenführen nach `main` wird „[Unveröffentlicht]“ zu einer Version mit Datum
  (`## [x.y.z] – JJJJ-MM-TT`), darüber ein neuer, leerer Abschnitt „[Unveröffentlicht]“; die Vergleichslinks am
  Ende ergänzen. Dabei die Version an beiden Stellen anheben: `backend/package.json` (+ `package-lock.json`,
  `npm version x.y.z --no-git-tag-version` in `backend/`) und `SCRIPT_VERSION` in `deploy.sh`.
- Versionen: Nebenversion für neue Funktionen, Patch für reine Fehlerbehebungen, Hauptversion nur, wenn ein
  Update manuelles Eingreifen verlangt.

## Projekt
- Oberfläche: `frontend/index.html` (eine Datei, Vanilla-JS, läuft auch ohne Server im lokalen Modus).
  Die CSP-Hashes der Inline-Skripte berechnet der Docker-Build (`frontend/csp-hashes.js`).
- Server: `backend/src/` (Express, PostgreSQL), Endpunkte in `backend/src/routes/`.
- Betrieb: `deploy.sh` und `docker-compose.yml`; Doku für Betrieb in `README.md`,
  für Anwender in der Anwenderdoku in `frontend/index.html` (`DOCS`).
- Sprache in Oberfläche, Doku, Commits und Changelog: Deutsch.
