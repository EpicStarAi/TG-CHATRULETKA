#!/usr/bin/env bash
# Install a coturn TURN relay for TG CHATRULETKA on the same VPS. Run as root (Ubuntu 24.04).
# Usage: DOMAIN=puseta.website bash deploy/setup-turn.sh
#
# - Generates a shared secret (kept on the server only) and writes it to both
#   /etc/turnserver.conf and /etc/tg-chatruletka.env, then restarts the app.
# - The app hands out short-lived TURN credentials to signed-in users only.
# - Does not touch nginx, Caddy or any other site. Safe to re-run (keeps the secret).
set -euo pipefail
: "${DOMAIN:?set DOMAIN, e.g. DOMAIN=puseta.website}"
APP_ENV=/etc/tg-chatruletka.env
CONF=/etc/turnserver.conf
CERT_DIR=/etc/coturn/certs
LE_DIR=/etc/letsencrypt/live/$DOMAIN
MIN_PORT=49152
MAX_PORT=49999

[ -f "$APP_ENV" ] || { echo "Missing $APP_ENV (create it and start tg-chatruletka first)"; exit 1; }

# Refuse to fight another service for the TURN ports.
if ss -lntup 2>/dev/null | grep -E ':(3478|5349)\s' | grep -vq turnserver; then
  echo "Port 3478 or 5349 is already used by another program:"; ss -lntup | grep -E ':(3478|5349)\s'; exit 1
fi

apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y coturn
[ -f /etc/default/coturn ] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn

# Reuse the existing secret on re-runs so active sessions keep working.
SECRET=$(grep -sE '^static-auth-secret=' "$CONF" | cut -d= -f2- || true)
[ -n "$SECRET" ] || SECRET=$(openssl rand -hex 32)

# TLS (turns: on 5349) using the certbot certificate nginx already has. coturn cannot read
# /etc/letsencrypt directly, so copy the files and re-copy them on every renewal.
TLS_LINES=""
if [ -f "$LE_DIR/fullchain.pem" ]; then
  install -d -m 750 -o root -g turnserver "$CERT_DIR"
  HOOK=/etc/letsencrypt/renewal-hooks/deploy/coturn-$DOMAIN.sh
  install -d /etc/letsencrypt/renewal-hooks/deploy
  cat > "$HOOK" <<HOOKEOF
#!/bin/sh
install -m 640 -o root -g turnserver $LE_DIR/fullchain.pem $CERT_DIR/fullchain.pem
install -m 640 -o root -g turnserver $LE_DIR/privkey.pem $CERT_DIR/privkey.pem
systemctl restart coturn 2>/dev/null || true
HOOKEOF
  chmod 755 "$HOOK"
  "$HOOK"
  TLS_LINES="tls-listening-port=5349
cert=$CERT_DIR/fullchain.pem
pkey=$CERT_DIR/privkey.pem
no-tlsv1
no-tlsv1_1"
else
  echo "No certificate at $LE_DIR - TURN over TLS (5349) is skipped; UDP/TCP 3478 still work."
fi

umask 077
cat > "$CONF" <<CONFEOF
# Managed by TG CHATRULETKA deploy/setup-turn.sh
listening-port=3478
$TLS_LINES
fingerprint
use-auth-secret
static-auth-secret=$SECRET
realm=$DOMAIN
server-name=$DOMAIN
min-port=$MIN_PORT
max-port=$MAX_PORT
total-quota=200
stale-nonce=600
no-multicast-peers
no-cli
no-software-attribute
log-file=syslog
# Never relay into private / local networks.
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
CONFEOF
chown root:turnserver "$CONF"; chmod 640 "$CONF"

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 3478/udp; ufw allow 3478/tcp; ufw allow 5349/tcp; ufw allow "$MIN_PORT:$MAX_PORT/udp"
fi

systemctl enable coturn >/dev/null
systemctl restart coturn

URLS="turn:$DOMAIN:3478?transport=udp,turn:$DOMAIN:3478?transport=tcp"
[ -n "$TLS_LINES" ] && URLS="$URLS,turns:$DOMAIN:5349?transport=tcp"
sed -i '/^TURN_SECRET=/d;/^TURN_URLS=/d' "$APP_ENV"
printf 'TURN_SECRET=%s\nTURN_URLS=%s\n' "$SECRET" "$URLS" >> "$APP_ENV"
chmod 600 "$APP_ENV"
systemctl restart tg-chatruletka

sleep 1
systemctl is-active --quiet coturn && echo "coturn: running" || { echo "coturn failed:"; journalctl -u coturn -n 20 --no-pager; exit 1; }
ss -lntup | grep -E ':(3478|5349)\s' || true
echo "Done. TURN URLs: $URLS"
echo "If your hosting has an external firewall, open 3478/udp+tcp, 5349/tcp and $MIN_PORT-$MAX_PORT/udp."
