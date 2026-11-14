#!/usr/bin/env bash
# Run ON the VPS as root (Ubuntu 24.04). Usage: DOMAIN=chat.example.com bash setup-vps.sh
set -euo pipefail
: "${DOMAIN:?set DOMAIN, e.g. DOMAIN=chat.example.com}"
APP_DIR=/opt/tg-chatruletka
REPO=https://github.com/EpicStarAi/TG-CHATRULETKA.git

apt-get update -y
apt-get install -y curl git ca-certificates debian-keyring debian-archive-keyring apt-transport-https
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone "$REPO" "$APP_DIR"; fi
cd "$APP_DIR" && npm ci --omit=dev || npm install --omit=dev
npm --prefix "$APP_DIR" install --no-audit --no-fund
(cd client && npm install --no-audit --no-fund && npx vite build) 2>/dev/null || npm run build

ENV_FILE=/etc/tg-chatruletka.env
if [ ! -f "$ENV_FILE" ]; then
  read -r -s -p "Telegram bot token (input hidden): " BOT_TOKEN; echo
  cat > "$ENV_FILE" <<ENV
PORT=8080
PUBLIC_URL=https://$DOMAIN
TELEGRAM_BOT_TOKEN=$BOT_TOKEN
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"}]
ENV
  chmod 600 "$ENV_FILE"
fi

cp deploy/tg-chatruletka.service /etc/systemd/system/tg-chatruletka.service
systemctl daemon-reload && systemctl enable --now tg-chatruletka

sed "s/__DOMAIN__/$DOMAIN/g" deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

echo "Done. Check: curl -s https://$DOMAIN/health"
