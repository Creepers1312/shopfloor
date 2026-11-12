#!/usr/bin/env bash
# =============================================================================
#  Shopfloor Board — Deploy-Skript
#
#  Erstinstallation (frisches System, Docker wird bei Bedarf eingerichtet):
#     git clone https://github.com/Creepers1312/shopfloor.git && cd shopfloor && ./deploy.sh
#  Update (später, im selben Ordner):
#     ./deploy.sh                 Sicherung → git pull → neu bauen → starten (Einstellungen bleiben)
#
#  ./deploy.sh config             Einstellungen (.env) ändern, danach ./deploy.sh
#  ./deploy.sh update             wie ./deploy.sh (Alias)
#  ./deploy.sh status             Container-Status und Health-Check
#  ./deploy.sh logs [dienst]      Logs verfolgen (web | api | db)
#  ./deploy.sh backup [notiz]     Sofort eine Datenbanksicherung anlegen
#  ./deploy.sh admin              Weiteres Administrator-Konto anlegen
#  ./deploy.sh audit [anzahl]     Letzte Einträge des Sicherheitsprotokolls
#  ./deploy.sh mail-test [adresse] Mailserver prüfen, optional Test-E-Mail senden
#  ./deploy.sh checkmk            Ausgabe des Checkmk-Local-Checks anzeigen
#  ./deploy.sh smb                Verbindung zur SMB-Freigabe prüfen und Sicherungen abgleichen
#  ./deploy.sh reset-password N   Passwort für Konto N neu setzen
#  ./deploy.sh users              Konten auflisten
#  ./deploy.sh stop               Container stoppen (Daten bleiben erhalten)
#
#  Optionen:
#     -y, --yes                   keine Rückfragen (Umgebung → .env → Standard)
#     --mode port|proxy           Betriebsart vorgeben (sonst wird gefragt)
#     --network NAME              Docker-Netz des Reverse Proxys (Betriebsart proxy)
#     --no-pull                   Git-Update überspringen
#     --no-build                  Images nicht neu bauen
#     --no-prune                  alte Images/Build-Cache am Ende nicht aufräumen
#     -h, --help                  diese Hilfe
#
#  Betriebsarten:
#     port   eigener Port (WEB_PORT), z. B. für einen Proxy auf einem anderen Rechner
#     proxy  im Docker-Netz eines vorhandenen Reverse Proxys (Nginx Proxy Manager, Traefik …)
#            — im Proxy als Ziel http://<projekt>-web:8080 eintragen
#
#  Ohne Rückfragen, z. B.:
#    DEPLOY_MODE=proxy PROXY_NETWORK=npm_default PUBLIC_URL=https://shopfloor.firma.de \
#    ADMIN_NAME="Max Mustermann" ADMIN_USERNAME="max.mustermann" ADMIN_EMAIL="…" ADMIN_PASSWORD="…" ./deploy.sh -y
# =============================================================================
set -Eeuo pipefail

SCRIPT_VERSION="1.1.0"
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
ORIG_ARGS=("$@")
GIT_PULL=true; BUILD=true; PRUNE="${DEPLOY_PRUNE:-true}"
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes) ASSUME_YES=true ;;
    --no-pull) GIT_PULL=false ;;
    --no-build) BUILD=false ;;
    --no-prune) PRUNE=false ;;
    --mode) DEPLOY_MODE="${2:-}"; shift ;;
    --mode=*) DEPLOY_MODE="${1#*=}" ;;
    --network) PROXY_NETWORK="${2:-}"; shift ;;
    --network=*) PROXY_NETWORK="${1#*=}" ;;
    -h|--help) awk 'NR>2 && /^# =+$/ {exit} NR>2 {sub(/^#( |$)/, ""); sub(/^ /, ""); print}' "$0"; exit 0 ;;
    -*) die "Unbekannte Option: $1 (siehe ./deploy.sh --help)" ;;
    *) ARGS+=("$1") ;;
  esac
  shift
done
set -- "${ARGS[@]+"${ARGS[@]}"}"
[[ $# -gt 0 ]] && { COMMAND="$1"; shift; }
[[ -t 0 ]] || ASSUME_YES=true   # ohne Terminal keine Rückfragen

# ---------- Docker ------------------------------------------------------------
DC=()
# Fehlt Docker, wird es bei der Installation (./deploy.sh) auf Wunsch mit dem offiziellen
# Skript get.docker.com eingerichtet — wie beim E-Rechnung-Konverter. Ist der Benutzer nicht
# in der Gruppe "docker", läuft Docker für diesen Lauf über sudo.
SUDO=""
DOCKER=(docker)
DOCKER_GROUP_ADDED=false
COMPOSE_MIN="2.20.0"

install_pkg() {   # Paketname → mit dem vorhandenen Paketmanager installieren
  if command -v apt-get >/dev/null 2>&1; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq "$1"
  elif command -v dnf >/dev/null 2>&1; then $SUDO dnf install -y -q "$1"
  elif command -v yum >/dev/null 2>&1; then $SUDO yum install -y -q "$1"
  elif command -v zypper >/dev/null 2>&1; then $SUDO zypper -q install -y "$1"
  else return 1; fi
}

ensure_docker() {   # $1 = true: fehlendes Docker darf installiert werden
  local allow_install="${1:-false}" v
  if [[ "$(id -u)" -ne 0 ]] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

  if ! command -v docker >/dev/null 2>&1; then
    [[ "$allow_install" == true ]] || die "Docker ist nicht installiert — zuerst ./deploy.sh ausführen (richtet Docker auf Wunsch ein)."
    [[ "$(uname -s)" == Linux ]] || die "Docker bitte von Hand installieren: https://docs.docker.com/engine/install/"
    [[ "$(id -u)" -eq 0 || -n "$SUDO" ]] || die "Für die Docker-Installation als root ausführen oder sudo installieren."
    warn "Docker ist nicht installiert."
    confirm "Docker jetzt mit dem offiziellen Installationsskript (get.docker.com) installieren?" \
      || die "Ohne Docker geht es nicht. Anleitung: https://docs.docker.com/engine/install/"
    if ! command -v curl >/dev/null 2>&1; then
      info "Installiere curl …"
      install_pkg curl >>"$LOG_FILE" 2>&1 || die "curl fehlt und ließ sich nicht installieren — bitte von Hand nachinstallieren."
    fi
    info "Installiere Docker (dauert einige Minuten, Details in $LOG_FILE) …"
    if ! curl -fsSL https://get.docker.com | $SUDO sh >>"$LOG_FILE" 2>&1; then
      die "Docker-Installation fehlgeschlagen — Details in $LOG_FILE. Anleitung: https://docs.docker.com/engine/install/"
    fi
    $SUDO systemctl enable --now docker >>"$LOG_FILE" 2>&1 || true
    # Damit es beim nächsten Mal ohne sudo geht (wirkt nach erneuter Anmeldung)
    local who="${SUDO_USER:-${USER:-}}"
    if [[ -n "$who" && "$who" != root ]] && $SUDO usermod -aG docker "$who" 2>/dev/null; then DOCKER_GROUP_ADDED=true; fi
    ok "Docker installiert."
  fi

  DOCKER=(docker)
  if ! docker info >/dev/null 2>&1; then
    $SUDO systemctl start docker >/dev/null 2>&1 || true
    if docker info >/dev/null 2>&1; then :
    elif [[ -n "$SUDO" ]] && $SUDO docker info >/dev/null 2>&1; then
      DOCKER=(sudo docker)
      [[ "$allow_install" == true ]] && warn "Docker läuft für diesen Lauf über sudo (Benutzer ist nicht in der Gruppe 'docker')."
    else
      die "Kein Zugriff auf den Docker-Dienst. Läuft er? (sudo systemctl status docker)"
    fi
  fi

  v="$("${DOCKER[@]}" compose version --short 2>/dev/null || true)"
  if [[ -z "$v" ]]; then
    [[ "$allow_install" == true ]] && install_pkg docker-compose-plugin >>"$LOG_FILE" 2>&1 || true
    v="$("${DOCKER[@]}" compose version --short 2>/dev/null || true)"
  fi
  [[ -n "$v" ]] || die "Docker Compose v2 fehlt (Paket docker-compose-plugin)."
  printf '%s\n%s\n' "$COMPOSE_MIN" "${v#v}" | sort -V -C \
    || die "Docker Compose $v ist zu alt (mindestens $COMPOSE_MIN nötig) — bitte Docker aktualisieren."
  DC=("${DOCKER[@]}" compose)
  if [[ "$allow_install" == true ]]; then
    ok "Docker $("${DOCKER[@]}" version --format '{{.Server.Version}}' 2>/dev/null) · Compose $v"
  fi
}
detect_compose() { ensure_docker false; }
# Die .env ist maßgeblich: Umgebungsvariablen waren nur Eingaben für die Fragen oben.
# Compose würde sie sonst der .env vorziehen (z. B. einen belegten Port trotz Ausweichen).
dc() {
  local unset_args=() entry key
  for entry in "${SETTINGS[@]}"; do key="${entry%%|*}"; unset_args+=(-u "$key"); done
  env "${unset_args[@]}" "${DC[@]}" --env-file "$ENV_FILE" "$@"
}
api_running() { [[ -n "$(dc ps --status running -q api 2>/dev/null)" ]]; }
# exec -T reicht sonst das Terminal durch und verschluckt Eingaben für spätere Fragen —
# daher ohne Eingabe; nur create-admin bekommt das Passwort gezielt per Pipe (cli_in)
cli() { dc exec -T api node src/cli.js "$@" </dev/null; }
cli_in() { dc exec -T api node src/cli.js "$@"; }

# ---------- Einstellungen ----------------------------------------------------
# Name | Standard | Typ | Beschreibung
SETTINGS=(
  "COMPOSE_PROJECT_NAME|shopfloor|name|Projektname (eindeutig auf diesem Server; Präfix für Container, Netze, Volumes)"
  "DEPLOY_MODE|__auto__|mode|Betriebsart: port = eigener Port · proxy = im Docker-Netz eines vorhandenen Reverse Proxys (z. B. Nginx Proxy Manager)"
  "PROXY_NETWORK|__auto__|network|Docker-Netz des Reverse Proxys"
  "WEB_BIND|__auto__|ip|IP-Adresse, an die der Web-Port gebunden wird (127.0.0.1 = nur lokal)"
  "WEB_PORT|8080|port|Port für das Board auf diesem Server"
  "PUBLIC_URL|__auto__|url|Adresse, unter der das Board erreichbar ist (z. B. https://shopfloor.trobox.de)"
  "TZ|Europe/Berlin|text|Zeitzone (für Sicherungszeiten und Dateinamen)"
  "DB_NAME|shopfloor|name|Name der Datenbank"
  "DB_USER|shopfloor|name|Datenbank-Benutzer"
  "DB_PASSWORD|__random__|secret|Datenbank-Passwort"
  "APP_SECRET|__random__|keep|Schlüssel für gespeicherte Zugangsdaten, z. B. SMB-Passwort (wird erzeugt, nicht ändern)"
  "ALLOW_REGISTER|false|bool|Dürfen sich neue Benutzer selbst registrieren?"
  "ALLOW_DEMO|false|bool|Demo-Zugang (nur Lesen) auf der Anmeldeseite anbieten?"
  "SESSION_DAYS|14|int|Wie viele Tage bleibt eine Anmeldung höchstens gültig?"
  "SESSION_IDLE_HOURS|12|hours|Nach wie vielen Stunden ohne Aktivität abmelden? (0 = nie)"
  "PASSWORD_MIN_LENGTH|10|pwlen|Mindestlänge für Passwörter"
  "COOKIE_SECURE|__auto__|bool|Sitzungs-Cookie nur über HTTPS senden?"
  "TRUSTED_PROXIES|__auto__|iplist|IP-Adresse(n)/Netz des Reverse Proxys, dessen X-Forwarded-For als Client-IP gilt (leer = keiner)"
  "BACKUP_PATH|./backups|path|Ordner für Datenbanksicherungen auf dem Host"
  "BACKUP_ENABLED|true|bool|Standard für tägliche automatische Sicherung"
  "BACKUP_TIME|02:00|time|Uhrzeit der täglichen Sicherung (HH:MM)"
  "BACKUP_KEEP|14|int|Wie viele automatische Sicherungen aufbewahren?"
  "CHECKMK|__auto__|bool|Checkmk-Überwachung (Local Check für Board und Sicherungen) einrichten?"
  "SMTP_HOST||opthost|Mailserver für „Passwort vergessen“ — Startwert, später in der Oberfläche änderbar (leer = später dort einrichten)"
  "SMTP_PORT|587|port|Port des Mailservers (587 = STARTTLS, 465 = TLS, 25 = ohne)"
  "SMTP_SECURITY|starttls|smtpsec|Verschlüsselung zum Mailserver: starttls, tls oder none"
  "SMTP_USER||opttext|Benutzername am Mailserver (leer = ohne Anmeldung)"
  "SMTP_PASSWORD||mailpass|Passwort am Mailserver"
  "SMTP_FROM||mailfrom|Absender, z. B. Shopfloor Board <shopfloor@firma.de>"
  "COMPOSE_FILE|__auto__|derived|Compose-Dateien (ergibt sich aus der Betriebsart, nicht von Hand ändern)"
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

# Netz eines laufenden Reverse-Proxy-Containers (Nginx Proxy Manager, Traefik, nginx-proxy, Caddy)
detect_proxy_network() {
  local c
  c="$("${DOCKER[@]}" ps --format '{{.Names}} {{.Image}}' 2>/dev/null \
    | awk 'tolower($2) ~ /nginx-proxy-manager|traefik|nginx-proxy|caddy/ {print $1; exit}')" || true
  [[ -n "$c" ]] || return 0
  "${DOCKER[@]}" inspect "$c" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null \
    | tr ' ' '\n' | grep -vxE 'bridge|host|none|' | head -n1 || true
}
network_subnets() {   # Netzname → Subnetze mit Komma getrennt
  [[ -n "${1:-}" ]] || return 0
  "${DOCKER[@]}" network inspect "$1" --format '{{range .IPAM.Config}}{{.Subnet}},{{end}}' 2>/dev/null | sed 's/,$//' || true
}
port_in_use() {   # Port → belegt (und nicht von diesem Projekt)?
  local port="$1" project="${VAL[COMPOSE_PROJECT_NAME]:-shopfloor}"
  if "${DOCKER[@]}" ps --filter "label=com.docker.compose.project=$project" --format '{{.Ports}}' 2>/dev/null | grep -q ":$port->"; then
    return 1
  fi
  if command -v ss >/dev/null 2>&1; then ss -ltnH "sport = :$port" 2>/dev/null | grep -q .
  else (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; fi
}
project_taken() {   # Projektname → gibt es schon ein anderes Compose-Projekt dieses Namens?
  "${DOCKER[@]}" compose ls -a --format json 2>/dev/null | grep -q "\"Name\":\"$1\""
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
    mode)   v="${v,,}"; [[ "$v" == port || "$v" == proxy ]] || return 1 ;;
    opthost) [[ -z "$v" || "$v" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || return 1 ;;
    smtpsec) v="${v,,}"; [[ "$v" == starttls || "$v" == tls || "$v" == none ]] || return 1 ;;
    opttext) [[ ! "$v" =~ [[:space:]] ]] || return 1 ;;
    mailpass) [[ "$v" != *$'\n'* ]] || return 1 ;;
    mailfrom) [[ -z "$v" || "$v" =~ @ ]] || return 1
            case "$v" in *\"*|*\$*|*\`*|*\\*) return 1 ;; esac ;;
    network) [[ "$v" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || return 1
            "${DOCKER[@]}" network inspect "$v" >/dev/null 2>&1 || return 1 ;;
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
    mode) echo "port oder proxy" ;;
    opthost) echo "Hostname wie mail.firma.de, oder leer" ;;
    smtpsec) echo "starttls, tls oder none" ;;
    opttext) echo "ohne Leerzeichen, oder leer" ;;
    mailpass) echo "keine Zeilenumbrüche und kein '" ;;
    mailfrom) echo "E-Mail-Adresse, z. B. Shopfloor Board <shopfloor@firma.de>" ;;
    network) echo "Name eines vorhandenen Docker-Netzes (docker network ls)" ;;
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
        # Erstinstallation: läuft schon ein Reverse Proxy in Docker, wird proxy vorgeschlagen;
        # bestehende Installationen ohne den Eintrag bleiben bei port
        DEPLOY_MODE) [[ ! -f "$ENV_FILE" && -n "$(detect_proxy_network)" ]] && echo proxy || echo port ;;
        PROXY_NETWORK) detect_proxy_network ;;
        WEB_BIND) [[ "${VAL[DEPLOY_MODE]:-port}" == proxy ]] && echo 127.0.0.1 || echo 0.0.0.0 ;;
        PUBLIC_URL) echo "http://$(primary_ip):${VAL[WEB_PORT]:-8080}" ;;
        COOKIE_SECURE) [[ "${VAL[PUBLIC_URL]:-}" == https://* ]] && echo true || echo false ;;
        # Im Proxy-Netz kommt der Proxy aus dessen Subnetz — das gilt als vertrauenswürdig
        TRUSTED_PROXIES) [[ "${VAL[DEPLOY_MODE]:-port}" == proxy ]] && network_subnets "${VAL[PROXY_NETWORK]:-}" || true ;;
        CHECKMK) [[ -d "$CHECKMK_LOCAL_DIR" ]] && echo true || echo false ;;
        COMPOSE_FILE) [[ "${VAL[DEPLOY_MODE]:-port}" == proxy ]] && echo "docker-compose.yml:deploy/compose.proxy.yml" || echo "docker-compose.yml" ;;
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
    # Abgeleitetes und Einträge, die zur Betriebsart nicht passen, werden nicht gefragt
    if [[ "$type" == derived ]]; then VAL["$key"]="$(default_for "$key" "$dflt")"; continue; fi
    # Erzeugte Schlüssel: nie fragen, vorhandenen Wert behalten
    if [[ "$type" == keep ]]; then VAL["$key"]="${envval:-${CUR[$key]:-$(default_for "$key" "$dflt")}}"; continue; fi
    if [[ "$key" == PROXY_NETWORK && "${VAL[DEPLOY_MODE]}" != proxy ]]; then VAL["$key"]=""; continue; fi
    if [[ "$key" == SMTP_* && "$key" != SMTP_HOST && -z "${VAL[SMTP_HOST]:-}" ]]; then
      VAL["$key"]="$(validate "$type" "$start" 2>/dev/null || true)"; continue
    fi
    # Wechsel der Betriebsart: Standards der Betriebsart neu vorschlagen
    if [[ "$key" == WEB_BIND || "$key" == TRUSTED_PROXIES ]] && [[ -z "$envval" && "${CUR[DEPLOY_MODE]:-}" != "${VAL[DEPLOY_MODE]}" ]]; then
      start="$(default_for "$key" "$dflt")"
    fi
    if [[ "$key" == PROXY_NETWORK && "$interactive" == true ]]; then
      echo "  Vorhandene Docker-Netze:"
      "${DOCKER[@]}" network ls --format '{{.Name}}' | grep -vxE 'bridge|host|none' | sed 's/^/    - /' || true
    fi

    if [[ "$interactive" == true ]]; then
      while true; do
        if [[ "$type" == "mailpass" ]]; then
          shown="${C_DIM}[Enter = unverändert lassen, '-' = leeren]${C_RESET}"
          [[ -z "$start" ]] && shown="${C_DIM}[nicht gesetzt]${C_RESET}"
          printf '%s\n  %s%s%s %s: ' "$desc" "$C_BOLD" "$key" "$C_RESET" "$shown"
          IFS= read -rs answer; echo
          if [[ "$answer" == "-" ]]; then answer=""; start=""; fi
        elif [[ "$type" == "secret" ]]; then
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
    # Erstinstallation: Projektname darf auf diesem Server noch nicht vergeben sein
    if [[ "$key" == COMPOSE_PROJECT_NAME && ! -f "$ENV_FILE" ]] && project_taken "$norm"; then
      die "Auf diesem Server gibt es bereits ein Compose-Projekt „$norm“ — anderen Namen wählen (COMPOSE_PROJECT_NAME=… ./deploy.sh)."
    fi
    # Port frei? (der eigene, laufende Web-Container zählt nicht)
    if [[ "$key" == WEB_PORT ]]; then
      while port_in_use "${VAL[WEB_PORT]}"; do
        warn "Port ${VAL[WEB_PORT]} ist auf diesem Server schon belegt."
        if [[ "$interactive" == true ]]; then
          printf '  Anderen Port wählen [%s]: ' "$((VAL[WEB_PORT] + 1))"; IFS= read -r answer
          answer="${answer:-$((VAL[WEB_PORT] + 1))}"
          norm="$(validate port "$answer")" && VAL[WEB_PORT]="$norm" || warn "Ungültig — $(hint_for port)."
        else
          VAL[WEB_PORT]=$((VAL[WEB_PORT] + 1))
          info "Weiche auf Port ${VAL[WEB_PORT]} aus."
        fi
      done
    fi
  done
  # Bei Updates ohne Rückfragen: neu hinzugekommene Einstellungen nennen
  if [[ "$interactive" != true && -f "$ENV_FILE" ]]; then
    for entry in "${SETTINGS[@]}"; do
      IFS='|' read -r key _ type _ <<< "$entry"
      [[ "$type" == derived || "$type" == keep || -v "CUR[$key]" ]] && continue
      info "Neue Einstellung $key = '${VAL[$key]}' (ändern mit ./deploy.sh config)"
    done
  fi

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
      [[ "$type" == derived || "$type" == keep ]] && continue
      [[ "$key" == PROXY_NETWORK && "${VAL[DEPLOY_MODE]}" != proxy ]] && continue
      [[ "$key" == SMTP_* && "$key" != SMTP_HOST && -z "${VAL[SMTP_HOST]}" ]] && continue
      [[ "$type" == mailpass ]] && { printf '  %-22s %s\n' "$key" "$([[ -n "${VAL[$key]}" ]] && echo '••••••••' || echo '(leer)')"; continue; }
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
  "${DOCKER[@]}" volume inspect "${project}_db-data" >/dev/null 2>&1
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

# ---------- Checkmk ---------------------------------------------------------
# Local Check: Der Checkmk-Agent führt das Skript alle 5 Minuten aus (Unterordner 300).
# Es fragt den Status per docker exec direkt im API-Container ab — kein Port, kein Token.
CHECKMK_LOCAL_DIR="${CHECKMK_LOCAL_DIR:-/usr/lib/check_mk_agent/local}"
as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else return 1; fi
}
checkmk_script() { echo "$CHECKMK_LOCAL_DIR/300/shopfloor_${VAL[COMPOSE_PROJECT_NAME]}"; }
checkmk_prefix() { [[ "${VAL[COMPOSE_PROJECT_NAME]}" == shopfloor ]] && echo "Shopfloor" || echo "Shopfloor ${VAL[COMPOSE_PROJECT_NAME]}"; }
setup_checkmk() {
  local target project="${VAL[COMPOSE_PROJECT_NAME]}" prefix
  target="$(checkmk_script)"; prefix="$(checkmk_prefix)"
  if [[ "${VAL[CHECKMK]:-false}" != true ]]; then
    if [[ -f "$target" ]]; then as_root rm -f "$target" && info "Checkmk-Local-Check entfernt ($target)."; fi
    return 0
  fi
  if [[ ! -d "$CHECKMK_LOCAL_DIR" ]]; then
    warn "Checkmk-Agent nicht gefunden ($CHECKMK_LOCAL_DIR fehlt) — Local Check nicht eingerichtet."
    return 0
  fi
  as_root true || { warn "Für den Checkmk-Local-Check sind root-Rechte nötig — übersprungen."; return 0; }
  as_root mkdir -p "$CHECKMK_LOCAL_DIR/300"
  as_root tee "$target" >/dev/null <<EOF_CMK
#!/bin/sh
# Shopfloor Board (Projekt $project) — Checkmk-Local-Check, von deploy.sh installiert.
# Dienste: "$prefix Board", "$prefix Backup" und — wenn eingeschaltet — "$prefix Backup SMB".
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
C=\$(docker ps -q --filter label=com.docker.compose.project=$project --filter label=com.docker.compose.service=api --filter status=running 2>/dev/null | head -n 1)
if [ -z "\$C" ]; then
  echo '2 "$prefix Board" - API-Container läuft nicht (!!)'
  echo '3 "$prefix Backup" - Status unbekannt, API-Container läuft nicht'
  exit 0
fi
timeout 60 docker exec "\$C" node src/cli.js checkmk "$prefix" 2>/dev/null \\
  || echo '2 "$prefix Board" - Statusabfrage fehlgeschlagen (!!)'
EOF_CMK
  as_root chmod 755 "$target"
  ok "Checkmk-Local-Check eingerichtet: $target"
  info "In Checkmk beim Host eine Service-Erkennung ausführen — neue Dienste: „$prefix Board“, „$prefix Backup“."
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
    if dc exec -T web wget -qO- http://127.0.0.1:8080/api/health 2>/dev/null </dev/null | grep -q '"mode":"server"'; then
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
    printf '%s' "$ADMIN_PASSWORD" | cli_in create-admin "$ADMIN_NAME" "${ADMIN_ROLE:-Administration}" \
      "${ADMIN_USERNAME:-$(suggest_username "$ADMIN_NAME")}" "${ADMIN_EMAIL:-}" >/dev/null
    ok "Administrator „$ADMIN_NAME“ angelegt (Anmeldename: ${ADMIN_USERNAME:-$(suggest_username "$ADMIN_NAME")})."
    return 0
  fi
  if [[ "$ASSUME_YES" == true ]]; then
    warn "Noch kein Konto vorhanden. Anlegen mit: ./deploy.sh admin"
    warn "(oder im Browser registrieren — das erste Konto wird automatisch Administrator)"
    return 0
  fi
  create_admin_interactive
}

# Anmeldename aus dem Namen vorschlagen: „Jörg Müller“ → „joerg.mueller“
suggest_username() {
  local s
  s="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -e 's/ä/ae/g; s/ö/oe/g; s/ü/ue/g; s/ß/ss/g' \
       -e 's/[[:space:]]\+/./g; s/[^a-z0-9._-]//g; s/\.\.*/./g; s/^[._-]*//; s/[._-]*$//')"
  [[ ${#s} -ge 2 ]] || s="admin"
  printf '%s' "${s:0:36}"
}
create_admin_interactive() {
  local name role pw pw2 uname mail sug min="${VAL[PASSWORD_MIN_LENGTH]:-10}"
  while true; do printf 'Name (Anzeigename): '; IFS= read -r name; [[ -n "$name" ]] && break; done
  sug="$(suggest_username "$name")"
  while true; do
    printf 'Anmeldename [%s]: ' "$sug"; IFS= read -r uname; uname="${uname:-$sug}"; uname="${uname,,}"
    [[ "$uname" =~ ^[a-z0-9][a-z0-9._-]{1,39}$ ]] && break
    warn "Anmeldename: 2–40 Zeichen, nur Kleinbuchstaben, Ziffern, Punkt, Bindestrich und Unterstrich."
  done
  while true; do
    printf 'E-Mail (für „Passwort vergessen“, optional): '; IFS= read -r mail
    [[ -z "$mail" || "$mail" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[A-Za-z0-9-]{2,}$ ]] && break
    warn "Bitte eine gültige E-Mail-Adresse angeben oder leer lassen."
  done
  printf 'Rolle [Administration]: '; IFS= read -r role; role="${role:-Administration}"
  while true; do
    printf 'Passwort (mind. %s Zeichen): ' "$min"; IFS= read -rs pw; echo
    printf 'Passwort wiederholen: '; IFS= read -rs pw2; echo
    [[ ${#pw} -ge $min && "$pw" == "$pw2" ]] && break
    warn "Passwörter zu kurz oder nicht gleich — bitte erneut."
  done
  printf '%s' "$pw" | cli_in create-admin "$name" "$role" "$uname" "$mail"
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
  if [[ "${VAL[DEPLOY_MODE]}" == proxy ]]; then
    echo "  Reverse Proxy:    im Netz ${VAL[PROXY_NETWORK]} erreichbar als ${C_BOLD}http://${VAL[COMPOSE_PROJECT_NAME]}-web:8080${C_RESET}"
    echo "                    Im Nginx Proxy Manager einen Proxy Host für ${url#*://} anlegen:"
    echo "                    Schema http · Host ${VAL[COMPOSE_PROJECT_NAME]}-web · Port 8080 · SSL + Force SSL + HSTS an."
    echo "  Client-IP:        vertraut ${VAL[TRUSTED_PROXIES]:-(niemandem)}"
  elif [[ "$url" == https://* ]]; then
    echo "  Reverse Proxy (z. B. Nginx Proxy Manager): Proxy Host für ${url#https://} →"
    echo "  http://$(primary_ip):${VAL[WEB_PORT]} anlegen, SSL-Zertifikat zuweisen."
    echo "  Danach TRUSTED_PROXIES auf die IP des Proxys setzen (siehe Sicherheitsprotokoll, ./deploy.sh config)."
  else
    echo "  Hinweis: Über reines HTTP im LAN funktioniert alles, die Anmeldung ist aber"
    echo "  nur per HTTPS (z. B. hinter Nginx Proxy Manager) wirklich abgesichert."
  fi
  echo
  echo "  Status: ./deploy.sh status · Logs: ./deploy.sh logs · Update: ./deploy.sh"
}

# Git-Update: übersprungen bei lokalen Änderungen oder ohne Upstream. Liefert 0, wenn sich
# der Stand geändert hat (dann startet das Skript sich mit dem neuen Code neu).
git_update() {
  [[ "$GIT_PULL" == true && -d .git ]] && command -v git >/dev/null 2>&1 || return 1
  if [[ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
    warn "Lokale Änderungen im Projektordner — Git-Update übersprungen (git status)."
    return 1
  fi
  git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1 || { warn "Kein Upstream-Branch — Git-Update übersprungen."; return 1; }
  local before after
  before="$(git rev-parse --short HEAD)"
  git pull --ff-only --quiet >>"$LOG_FILE" 2>&1 || die "git pull fehlgeschlagen (lokaler Stand weicht ab?) — Details in $LOG_FILE"
  after="$(git rev-parse --short HEAD)"
  if [[ "$before" == "$after" ]]; then ok "Code ist aktuell ($after)"; return 1; fi
  ok "Code aktualisiert: $before → $after"
  return 0
}

do_deploy() {
  title "Shopfloor Board — Deploy $SCRIPT_VERSION"
  _log INFO "===== deploy ($COMMAND) gestartet ====="
  title "Voraussetzungen"
  ensure_docker true

  if [[ -f "$ENV_FILE" ]]; then
    # Bestehende Installation → Update: Einstellungen bleiben, nur Neues bekommt Standards
    title "Update der bestehenden Installation"
    read_env_file
    for k in "${!CUR[@]}"; do VAL["$k"]="${CUR[$k]}"; done
    if [[ -z "${DEPLOY_BACKUP_DONE:-}" ]]; then pre_backup; export DEPLOY_BACKUP_DONE=1; fi
    if git_update; then
      info "Starte mit dem neuen Stand neu …"
      exec "$0" "${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}" --no-pull
    fi
    configure false
  else
    title "Erstinstallation"
    if [[ "$ASSUME_YES" == true ]]; then configure false; else configure true; fi
  fi
  prepare_backup_dir

  title "Bauen und starten"
  dc config -q 2>>"$LOG_FILE" || die "Compose-Konfiguration ungültig — Details in $LOG_FILE (./deploy.sh config)"
  if [[ "${VAL[DEPLOY_MODE]}" == proxy ]]; then
    "${DOCKER[@]}" network inspect "${VAL[PROXY_NETWORK]}" >/dev/null 2>&1 \
      || die "Das Docker-Netz „${VAL[PROXY_NETWORK]}“ gibt es nicht (mehr) — ./deploy.sh config"
  fi
  if [[ "$BUILD" == true ]]; then
    dc build --pull 2>&1 | tee -a "$LOG_FILE" || die "Build fehlgeschlagen — Details in $LOG_FILE"
  else
    info "Bauen übersprungen (--no-build)."
  fi
  dc up -d --remove-orphans 2>&1 | tee -a "$LOG_FILE" || die "Start fehlgeschlagen — Details in $LOG_FILE"
  wait_healthy
  ensure_admin
  setup_checkmk

  # Nur Abfall: nicht mehr benutzte, unbenannte Images und Build-Cache älter als 7 Tage —
  # nie Container, Volumes, Netze oder benannte Images anderer Projekte
  if [[ "$PRUNE" == true ]]; then
    local freed_img freed_cache
    freed_img="$("${DOCKER[@]}" image prune -f 2>/dev/null | sed -n 's/^Total reclaimed space: //p')" || true
    freed_cache="$("${DOCKER[@]}" builder prune -f --filter until=168h 2>/dev/null | sed -n 's/^Total:[[:space:]]*//p')" || true
    ok "Aufgeräumt: alte Images ${freed_img:-0B}, Build-Cache älter als 7 Tage ${freed_cache:-0B}"
  fi
  summary
  if [[ "$DOCKER_GROUP_ADDED" == true ]]; then
    info "Benutzer ${SUDO_USER:-$USER} ist jetzt in der Gruppe 'docker' — nach erneuter Anmeldung geht ./deploy.sh ohne sudo."
  fi
  _log INFO "===== deploy beendet ====="
}

# ---------- Ablauf -----------------------------------------------------------
case "$COMMAND" in
  deploy|install|update) do_deploy ;;
  config)         detect_compose; configure true; info "Übernehmen mit: ./deploy.sh" ;;
  status)         detect_compose; load_env_for_run; dc ps
                  if api_running; then dc exec -T web wget -qO- http://127.0.0.1:8080/api/health 2>/dev/null </dev/null | sed 's/,"/,\n  "/g'; echo; fi ;;
  logs)           detect_compose; load_env_for_run; dc logs -f --tail=200 "$@" ;;
  backup)         detect_compose; load_env_for_run; api_running || die "Der API-Container läuft nicht."
                  cli backup "${1:-per deploy.sh}" ;;
  admin)          detect_compose; load_env_for_run; api_running || die "Der API-Container läuft nicht."
                  ASSUME_YES=false; create_admin_interactive ;;
  reset-password) detect_compose; load_env_for_run; [[ -n "${1:-}" ]] || die "Aufruf: ./deploy.sh reset-password <Name>"
                  dc exec api node src/cli.js reset-password "$1" ;;
  users)          detect_compose; load_env_for_run; cli list-users ;;
  checkmk)        detect_compose; load_env_for_run
                  if [[ -x "$(checkmk_script)" ]]; then info "Ausgabe des Local Checks $(checkmk_script):"; as_root "$(checkmk_script)"
                  else warn "Local Check nicht installiert (CHECKMK=${VAL[CHECKMK]:-?}) — Ausgabe direkt aus dem Container:"; cli checkmk "$(checkmk_prefix)"; fi ;;
  smb)            detect_compose; load_env_for_run; api_running || die "Der API-Container läuft nicht."
                  cli smb-sync ;;
  mail-test)      detect_compose; load_env_for_run; api_running || die "Der API-Container läuft nicht."
                  cli mail-test "${1:-}" ;;
  audit)          detect_compose; load_env_for_run; api_running || die "Der API-Container läuft nicht."
                  cli audit "${1:-50}" ;;
  stop|down)      detect_compose; load_env_for_run; dc down; ok "Gestoppt — Daten und Sicherungen bleiben erhalten." ;;
  *)              die "Unbekannter Befehl '$COMMAND' — Hilfe: ./deploy.sh --help" ;;
esac
