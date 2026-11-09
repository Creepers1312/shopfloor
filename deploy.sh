#!/usr/bin/env bash
# =============================================================================
#  Shopfloor Board — Deploy-Skript
#
#  ./deploy.sh                    Installieren bzw. aktualisieren (fragt Einstellungen ab)
#  ./deploy.sh -y                 Ohne Rückfragen (Werte aus Umgebung → .env → Standard)
#  ./deploy.sh config             Nur die Einstellungen (.env) abfragen und schreiben
#  ./deploy.sh update             git pull, Sicherung, neu bauen und starten
#  ./deploy.sh status             Container-Status und Health-Check
#  ./deploy.sh logs [dienst]      Logs verfolgen (web | api | db)
#  ./deploy.sh backup [notiz]     Sofort eine Datenbanksicherung anlegen
#  ./deploy.sh admin              Weiteres Administrator-Konto anlegen
#  ./deploy.sh audit [anzahl]     Letzte Einträge des Sicherheitsprotokolls
#  ./deploy.sh reset-password N   Passwort für Konto N neu setzen
#  ./deploy.sh users              Konten auflisten
#  ./deploy.sh stop               Container stoppen (Daten bleiben erhalten)
#
#  Jede Einstellung lässt sich auch vorab per Umgebung setzen, z. B.:
#    WEB_PORT=8090 ALLOW_DEMO=true ./deploy.sh -y
#  Erstes Admin-Konto ohne Rückfrage:
#    ADMIN_NAME="Luca" ADMIN_PASSWORD="…" ./deploy.sh -y
# =============================================================================
set -Eeuo pipefail

SCRIPT_VERSION="1.0.0"
cd "$(dirname "$(readlink -f "$0")")"

ENV_FILE=".env"
LOG_DIR="logs"
LOG_FILE="$LOG_DIR/deploy.log"
ASSUME_YES=false
COMMAND="deploy"

mkdir -p "$LOG_DIR"

# ---------- Ausgabe ----------------------------------------------------------
if [[ -t 1 ]]; then
  C_RESET=$'\e[0m'; C_BOLD=$'\e[1m'; C_DIM=$'\e[2m'
  C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_RED=$'\e[31m'; C_BLUE=$'\e[34m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BLUE=""
fi
_log()  { printf '%s [%s] %s\n' "$(date '+%F %T')" "$1" "$2" >> "$LOG_FILE"; }
info()  { printf '%s→%s %s\n' "$C_BLUE" "$C_RESET" "$*"; _log INFO "$*"; }
ok()    { printf '%s✔%s %s\n' "$C_GREEN" "$C_RESET" "$*"; _log OK "$*"; }
warn()  { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; _log WARN "$*"; }
die()   { printf '%s✘ %s%s\n' "$C_RED" "$*" "$C_RESET" >&2; _log ERROR "$*"; exit 1; }
title() { printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_RESET"; }
trap 'die "Abbruch in Zeile $LINENO (Befehl: $BASH_COMMAND) — Details in $LOG_FILE"' ERR

# ---------- Argumente --------------------------------------------------------
ARGS=()
for a in "$@"; do
  case "$a" in
    -y|--yes) ASSUME_YES=true ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^#  \{0,1\}//'; exit 0 ;;
    *) ARGS+=("$a") ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"
[[ $# -gt 0 ]] && { COMMAND="$1"; shift; }
[[ -t 0 ]] || ASSUME_YES=true   # ohne Terminal keine Rückfragen

# ---------- Docker -----------------------------------------------------------
DC=()
detect_compose() {
  command -v docker >/dev/null 2>&1 || die "Docker ist nicht installiert (https://docs.docker.com/engine/install/)."
  if ! docker info >/dev/null 2>&1; then
    die "Kein Zugriff auf Docker. Skript mit sudo starten oder Benutzer zur Gruppe 'docker' hinzufügen."
  fi
  if docker compose version >/dev/null 2>&1; then DC=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then DC=(docker-compose)
  else die "Docker Compose (v2) fehlt — Paket docker-compose-plugin installieren."; fi
}
dc() { "${DC[@]}" --env-file "$ENV_FILE" "$@"; }
api_running() { [[ -n "$(dc ps --status running -q api 2>/dev/null)" ]]; }
cli() { dc exec -T api node src/cli.js "$@"; }

# ---------- Einstellungen ----------------------------------------------------
# Name | Standard | Typ | Beschreibung
SETTINGS=(
  "COMPOSE_PROJECT_NAME|shopfloor|name|Projektname (Präfix für Container, Netze, Volumes)"
  "WEB_BIND|0.0.0.0|ip|IP-Adresse, an die der Web-Port gebunden wird (127.0.0.1 = nur lokal)"
  "WEB_PORT|8080|port|Port für das Board auf diesem Server"
  "PUBLIC_URL|__auto__|url|Adresse, unter der das Board erreichbar ist (z. B. https://shopfloor.trobox.de)"
  "TZ|Europe/Berlin|text|Zeitzone (für Sicherungszeiten und Dateinamen)"
  "DB_NAME|shopfloor|name|Name der Datenbank"
  "DB_USER|shopfloor|name|Datenbank-Benutzer"
  "DB_PASSWORD|__random__|secret|Datenbank-Passwort"
  "ALLOW_REGISTER|false|bool|Dürfen sich neue Benutzer selbst registrieren?"
  "ALLOW_DEMO|false|bool|Demo-Zugang (nur Lesen) auf der Anmeldeseite anbieten?"
  "SESSION_DAYS|14|int|Wie viele Tage bleibt eine Anmeldung höchstens gültig?"
  "SESSION_IDLE_HOURS|12|hours|Nach wie vielen Stunden ohne Aktivität abmelden? (0 = nie)"
  "PASSWORD_MIN_LENGTH|10|pwlen|Mindestlänge für Passwörter"
  "COOKIE_SECURE|__auto__|bool|Sitzungs-Cookie nur über HTTPS senden?"
  "TRUSTED_PROXIES||iplist|IP-Adresse(n) des Reverse Proxys, z. B. Nginx Proxy Manager (leer = keiner)"
  "BACKUP_PATH|./backups|path|Ordner für Datenbanksicherungen auf dem Host"
  "BACKUP_ENABLED|true|bool|Standard für tägliche automatische Sicherung"
  "BACKUP_TIME|02:00|time|Uhrzeit der täglichen Sicherung (HH:MM)"
  "BACKUP_KEEP|14|int|Wie viele automatische Sicherungen aufbewahren?"
)

declare -A CUR=()      # Werte aus vorhandener .env
declare -A VAL=()      # endgültige Werte

read_env_file() {
  [[ -f "$ENV_FILE" ]] || return 0
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# || ! "$line" =~ = ]] && continue
    key="${line%%=*}"; key="${key//[[:space:]]/}"
    value="${line#*=}"
    if [[ "$value" =~ ^\'(.*)\'$ || "$value" =~ ^\"(.*)\"$ ]]; then value="${BASH_REMATCH[1]}"; fi
    if [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then CUR["$key"]="$value"; fi
  done < "$ENV_FILE"
  return 0
}

primary_ip() {
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
  echo "${ip:-localhost}"
}
random_secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 24
  else head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}
to_bool() {
  case "${1,,}" in
    1|true|yes|ja|j|y|on) echo true ;;
    0|false|no|nein|n|off) echo false ;;
    *) return 1 ;;
  esac
}

validate() {   # typ wert → normalisierter Wert auf stdout, Fehler → return 1
  local type="$1" v="$2"
  [[ "$v" == *"'"* ]] && return 1
  case "$type" in
    name)   [[ "$v" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || return 1 ;;
    ip)     [[ "$v" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ || "$v" == "::" ]] || return 1 ;;
    port)   [[ "$v" =~ ^[0-9]+$ ]] && (( v >= 1 && v <= 65535 )) || return 1 ;;
    int)    [[ "$v" =~ ^[0-9]+$ ]] && (( v >= 1 && v <= 365 )) || return 1 ;;
    hours)  [[ "$v" =~ ^[0-9]+$ ]] && (( v >= 0 && v <= 720 )) || return 1 ;;
    pwlen)  [[ "$v" =~ ^[0-9]+$ ]] && (( v >= 8 && v <= 128 )) || return 1 ;;
    iplist) v="${v//[[:space:]]/}"; [[ "$v" == "-" ]] && v=""
            [[ -z "$v" || "$v" =~ ^[0-9A-Fa-f.:/]+(,[0-9A-Fa-f.:/]+)*$ ]] || return 1 ;;
    time)   [[ "$v" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || return 1 ;;
    bool)   v="$(to_bool "$v")" || return 1 ;;
    url)    [[ "$v" =~ ^https?://[^[:space:]]+$ ]] || return 1; v="${v%/}" ;;
    secret) (( ${#v} >= 12 )) || return 1
            case "$v" in *[[:space:]]*|*\"*|*\$*|*\`*|*\\*) return 1 ;; esac ;;
    path)   [[ -n "$v" && ! "$v" =~ [[:space:]] ]] || return 1 ;;
    text)   [[ -n "$v" ]] || return 1 ;;
  esac
  printf '%s' "$v"
}

hint_for() {
  case "$1" in
    name) echo "Kleinbuchstaben, Ziffern, - und _" ;;
    ip) echo "IPv4-Adresse, z. B. 0.0.0.0 oder 127.0.0.1" ;;
    port) echo "Zahl von 1 bis 65535" ;;
    int) echo "Zahl von 1 bis 365" ;;
    hours) echo "Zahl von 0 bis 720" ;;
    pwlen) echo "Zahl von 8 bis 128" ;;
    iplist) echo "IP-Adressen oder Netze, mit Komma getrennt; - für keinen" ;;
    time) echo "Format HH:MM, z. B. 02:00" ;;
    bool) echo "ja oder nein" ;;
    url) echo "mit http:// oder https://" ;;
    secret) echo "mind. 12 Zeichen, keine Leerzeichen, \" \$ \` \\ oder '" ;;
    *) echo "darf nicht leer sein" ;;
  esac
}

default_for() {
  local key="$1" dflt="$2"
  case "$dflt" in
    __random__) random_secret ;;
    __auto__)
      case "$key" in
        PUBLIC_URL) echo "http://$(primary_ip):${VAL[WEB_PORT]:-8080}" ;;
        COOKIE_SECURE) [[ "${VAL[PUBLIC_URL]:-}" == https://* ]] && echo true || echo false ;;
      esac ;;
    *) echo "$dflt" ;;
  esac
}

configure() {
  local interactive="$1" entry key dflt type desc start shown answer norm envval
  read_env_file
  title "Einstellungen"
  [[ -f "$ENV_FILE" ]] && info "Vorhandene $ENV_FILE gefunden — Enter übernimmt den angezeigten Wert." \
                       || info "Neue Installation — Enter übernimmt den Vorschlag."
  for entry in "${SETTINGS[@]}"; do
    IFS='|' read -r key dflt type desc <<< "$entry"
    envval="${!key-}"
    # Reihenfolge: Umgebung beim Aufruf → vorhandene .env → Standard
    if [[ -n "$envval" ]]; then start="$envval"
    elif [[ -n "${CUR[$key]:-}" ]]; then start="${CUR[$key]}"
    else start="$(default_for "$key" "$dflt")"; fi
    # COOKIE_SECURE folgt der URL, solange es niemand ausdrücklich gesetzt hat
    if [[ "$key" == "COOKIE_SECURE" && -z "$envval" && -z "${CUR[$key]:-}" ]]; then start="$(default_for "$key" "$dflt")"; fi
    [[ "$type" == "bool" ]] && start="$(to_bool "$start" || echo false)"

    if [[ "$interactive" == true ]]; then
      while true; do
        if [[ "$type" == "secret" ]]; then
          shown="${C_DIM}[vorhanden – Enter behält ihn, 'neu' erzeugt einen neuen]${C_RESET}"
          [[ -z "${CUR[$key]:-}" ]] && shown="${C_DIM}[Enter = zufällig erzeugen]${C_RESET}"
          printf '%s\n  %s%s%s %s: ' "$desc" "$C_BOLD" "$key" "$C_RESET" "$shown"
          IFS= read -rs answer; echo
          [[ "${answer,,}" == "neu" ]] && answer="$(random_secret)"
        else
          [[ "$type" == "bool" ]] && shown="$([[ "$start" == true ]] && echo ja || echo nein)" || shown="$start"
          printf '%s\n  %s%s%s [%s]: ' "$desc" "$C_BOLD" "$key" "$C_RESET" "$shown"
          IFS= read -r answer
        fi
        [[ -z "$answer" ]] && answer="$start"
        if norm="$(validate "$type" "$answer")"; then break; fi
        warn "Ungültig — $(hint_for "$type")."
      done
    else
      norm="$(validate "$type" "$start")" || die "Ungültiger Wert für $key: '$start' ($(hint_for "$type"))."
    fi
    VAL["$key"]="$norm"
  done

  # Datenbank-Passwort nachträglich ändern ändert es NICHT in einer bestehenden Datenbank
  if [[ -n "${CUR[DB_PASSWORD]:-}" && "${CUR[DB_PASSWORD]}" != "${VAL[DB_PASSWORD]}" ]] && db_volume_exists; then
    warn "Die Datenbank existiert bereits. Ein neues DB_PASSWORD gilt erst, wenn es auch in PostgreSQL geändert wird:"
    warn "  docker compose exec db psql -U ${VAL[DB_USER]} -c \"ALTER USER ${VAL[DB_USER]} PASSWORD '<neu>'\""
    confirm "Trotzdem das neue Passwort in die .env schreiben?" || VAL[DB_PASSWORD]="${CUR[DB_PASSWORD]}"
  fi

  if [[ "$interactive" == true ]]; then
    title "Zusammenfassung"
    for entry in "${SETTINGS[@]}"; do
      IFS='|' read -r key _ type _ <<< "$entry"
      [[ "$type" == "secret" ]] && printf '  %-22s %s\n' "$key" "••••••••" || printf '  %-22s %s\n' "$key" "${VAL[$key]}"
    done
    confirm "So übernehmen?" || die "Abgebrochen — nichts geändert."
  fi
  write_env
}

write_env() {
  local entry key desc
  if [[ -f "$ENV_FILE" ]]; then cp -p "$ENV_FILE" "$ENV_FILE.bak"; fi
  (
  umask 077
  {
    echo "# Shopfloor Board — erzeugt von deploy.sh $SCRIPT_VERSION am $(date '+%F %T')"
    echo "# Änderungen am besten über ./deploy.sh config vornehmen."
    for entry in "${SETTINGS[@]}"; do
      IFS='|' read -r key _ _ desc <<< "$entry"
      echo ""
      echo "# $desc"
      echo "$key='${VAL[$key]}'"
    done
  } > "$ENV_FILE.tmp"
  )
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "$ENV_FILE geschrieben (Rechte 600)${CUR[DB_PASSWORD]:+, vorherige Version in $ENV_FILE.bak}."
}

load_env_for_run() {
  [[ -f "$ENV_FILE" ]] || die "Keine $ENV_FILE vorhanden — zuerst ./deploy.sh ausführen."
  read_env_file
  for k in "${!CUR[@]}"; do VAL["$k"]="${CUR[$k]}"; done
}

confirm() {
  [[ "$ASSUME_YES" == true ]] && return 0
  local a; printf '%s [J/n]: ' "$1"; IFS= read -r a
  [[ -z "$a" || "${a,,}" =~ ^(j|ja|y|yes)$ ]]
}

db_volume_exists() {
  local project="${VAL[COMPOSE_PROJECT_NAME]:-${CUR[COMPOSE_PROJECT_NAME]:-shopfloor}}"
  docker volume inspect "${project}_db-data" >/dev/null 2>&1
}

# ---------- Schritte ---------------------------------------------------------
prepare_backup_dir() {
  local p="${VAL[BACKUP_PATH]}"
  # Nur Pfade anlegen — ein Name ohne / wäre ein Docker-Volume
  [[ "$p" == /* || "$p" == ./* || "$p" == ../* ]] || return 0
  mkdir -p "$p" 2>/dev/null || sudo mkdir -p "$p"
  # Der API-Container läuft als Benutzer node (UID 1000)
  if [[ "$(stat -c %u "$p")" != "1000" ]]; then
    info "Setze Besitzer von $p auf UID 1000 (Benutzer im API-Container) …"
    chown 1000:1000 "$p" 2>/dev/null || sudo chown 1000:1000 "$p" || warn "Konnte Besitzer von $p nicht ändern — Sicherungen könnten fehlschlagen."
  fi
  # Sicherungen enthalten Passwort-Hashes — nur für den Besitzer lesbar
  chmod 700 "$p" 2>/dev/null || sudo chmod 700 "$p" || warn "Konnte Rechte von $p nicht auf 700 setzen."
}

pre_backup() {
  api_running || return 0
  info "Sichere die Datenbank vor dem Update …"
  local f
  if f="$(cli backup "vor Deploy $(date '+%F %H:%M')" 2>&1)"; then
    ok "Sicherung erstellt: $f"
  else
    warn "Sicherung fehlgeschlagen: $f"
    confirm "Ohne Sicherung fortfahren?" || die "Abgebrochen."
  fi
}

wait_healthy() {
  info "Warte auf den Start der Container …"

  for _ in $(seq 1 60); do
    if dc exec -T web wget -qO- http://127.0.0.1:8080/api/health 2>/dev/null | grep -q '"mode":"server"'; then
      ok "Board antwortet, Datenbank verbunden."
      return 0
    fi
    sleep 2
  done
  dc ps
  die "Das Board ist nach 120 s nicht erreichbar — Logs: ./deploy.sh logs"
}

ensure_admin() {
  local n
  n="$(cli count-users 2>/dev/null | tail -n1 | tr -dc '0-9' || true)"
  [[ "${n:-0}" -gt 0 ]] && return 0
  title "Erstes Administrator-Konto"
  if [[ -n "${ADMIN_NAME:-}" && -n "${ADMIN_PASSWORD:-}" ]]; then
    printf '%s' "$ADMIN_PASSWORD" | cli create-admin "$ADMIN_NAME" "${ADMIN_ROLE:-Administration}" >/dev/null
    ok "Administrator „$ADMIN_NAME“ angelegt."
    return 0
  fi
  if [[ "$ASSUME_YES" == true ]]; then
    warn "Noch kein Konto vorhanden. Anlegen mit: ./deploy.sh admin"
    warn "(oder im Browser registrieren — das erste Konto wird automatisch Administrator)"
    return 0
  fi
  create_admin_interactive
}

create_admin_interactive() {
  local name role pw pw2 min="${VAL[PASSWORD_MIN_LENGTH]:-10}"
  while true; do printf 'Name: '; IFS= read -r name; [[ -n "$name" ]] && break; done
  printf 'Rolle [Administration]: '; IFS= read -r role; role="${role:-Administration}"
  while true; do
    printf 'Passwort (mind. %s Zeichen): ' "$min"; IFS= read -rs pw; echo
    printf 'Passwort wiederholen: '; IFS= read -rs pw2; echo
    [[ ${#pw} -ge $min && "$pw" == "$pw2" ]] && break
    warn "Passwörter zu kurz oder nicht gleich — bitte erneut."
  done
  printf '%s' "$pw" | cli create-admin "$name" "$role"
}

summary() {
  local url="${VAL[PUBLIC_URL]}"
  title "Fertig"
  echo "  Board:            $url"
  if [[ "${VAL[WEB_BIND]}" != "127.0.0.1" ]]; then
    echo "  Direkt im LAN:    http://$(primary_ip):${VAL[WEB_PORT]}"
    [[ "${VAL[COOKIE_SECURE]}" == true ]] && echo "                    (Anmeldung dort nicht möglich, da COOKIE_SECURE=true — nur über HTTPS)"
  fi
  echo "  Sicherungen:      ${VAL[BACKUP_PATH]}"
  echo "  Log:              $LOG_FILE"
  echo
  if [[ "$url" == https://* ]]; then
    echo "  Reverse Proxy (z. B. Nginx Proxy Manager): Proxy Host für ${url#https://} →"
    echo "  http://$(primary_ip):${VAL[WEB_PORT]} anlegen, SSL-Zertifikat zuweisen."
  else
    echo "  Hinweis: Über reines HTTP im LAN funktioniert alles, die Anmeldung ist aber"
    echo "  nur per HTTPS (z. B. hinter Nginx Proxy Manager) wirklich abgesichert."
  fi
  echo
  echo "  Status: ./deploy.sh status · Logs: ./deploy.sh logs · Update: ./deploy.sh update"
}

do_deploy() {
  title "Shopfloor Board — Deploy $SCRIPT_VERSION"
  _log INFO "===== deploy ($COMMAND) gestartet ====="
  detect_compose
  if [[ "$ASSUME_YES" == true ]]; then configure false; else configure true; fi
  prepare_backup_dir
  pre_backup
  title "Bauen und starten"
  dc build --pull 2>&1 | tee -a "$LOG_FILE" || die "Build fehlgeschlagen — Details in $LOG_FILE"
  dc up -d --remove-orphans 2>&1 | tee -a "$LOG_FILE" || die "Start fehlgeschlagen — Details in $LOG_FILE"
  wait_healthy
  ensure_admin
  # Nur verwaiste (dangling) Images der alten Builds entfernen
  docker image prune -f >/dev/null 2>&1 && ok "Alte Image-Schichten aufgeräumt." || true
  summary
  _log INFO "===== deploy beendet ====="
}

do_update() {
  if [[ -d .git ]]; then
    info "Hole neuen Stand aus Git …"
    git pull --ff-only 2>&1 | tee -a "$LOG_FILE"
  else
    warn "Kein Git-Repository — überspringe git pull."
  fi
  # Nach git pull ggf. neue Version dieses Skripts verwenden
  exec "$0" -y deploy
}

# ---------- Ablauf -----------------------------------------------------------
case "$COMMAND" in
  deploy|install) do_deploy ;;
  update)         detect_compose; [[ -f "$ENV_FILE" ]] || die "Keine $ENV_FILE — zuerst ./deploy.sh ausführen."; do_update ;;
  config)         detect_compose; configure true; info "Übernehmen mit: ./deploy.sh -y" ;;
  status)         detect_compose; load_env_for_run; dc ps
                  if api_running; then dc exec -T web wget -qO- http://127.0.0.1:8080/api/health 2>/dev/null | sed 's/,"/,\n  "/g'; echo; fi ;;
  logs)           detect_compose; load_env_for_run; dc logs -f --tail=200 "$@" ;;
  backup)         detect_compose; load_env_for_run; api_running || die "Der API-Container läuft nicht."
                  cli backup "${1:-per deploy.sh}" ;;
  admin)          detect_compose; load_env_for_run; api_running || die "Der API-Container läuft nicht."
                  ASSUME_YES=false; create_admin_interactive ;;
  reset-password) detect_compose; load_env_for_run; [[ -n "${1:-}" ]] || die "Aufruf: ./deploy.sh reset-password <Name>"
                  dc exec api node src/cli.js reset-password "$1" ;;
  users)          detect_compose; load_env_for_run; cli list-users ;;
  audit)          detect_compose; load_env_for_run; api_running || die "Der API-Container läuft nicht."
                  cli audit "${1:-50}" ;;
  stop|down)      detect_compose; load_env_for_run; dc down; ok "Gestoppt — Daten und Sicherungen bleiben erhalten." ;;
  *)              die "Unbekannter Befehl '$COMMAND' — Hilfe: ./deploy.sh --help" ;;
esac
