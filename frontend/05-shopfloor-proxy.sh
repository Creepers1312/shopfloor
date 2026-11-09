#!/bin/sh
# Beim Container-Start: vertrauenswürdige Reverse Proxys für die echte Client-IP eintragen.
# TRUSTED_PROXIES = Komma-getrennte IP-Adressen oder Netze, z. B. "172.17.0.1" oder "10.0.0.5,10.0.0.6".
# Leer = kein Proxy davor; dann gilt die Verbindungsadresse.
set -eu
out=/tmp/shopfloor-realip.conf
: > "$out"
list="$(printf '%s' "${TRUSTED_PROXIES:-}" | tr ',;' '  ')"
count=0
for p in $list; do
  case "$p" in
    *[!0-9a-fA-F.:/]*|"")
      echo "05-shopfloor-proxy: ungültiger Eintrag in TRUSTED_PROXIES: $p" >&2
      exit 1 ;;
  esac
  echo "set_real_ip_from $p;" >> "$out"
  count=$((count + 1))
done
if [ "$count" -gt 0 ]; then
  echo "real_ip_header X-Forwarded-For;" >> "$out"
  echo "real_ip_recursive on;" >> "$out"
  echo "05-shopfloor-proxy: $count vertrauenswürdige(r) Proxy(s) eingetragen"
else
  echo "05-shopfloor-proxy: kein Reverse Proxy eingetragen — Verbindungsadresse gilt als Client-IP"
fi
