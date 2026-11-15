# TG CHATRULETKA

Telegram Mini App for random one-to-one video chat. Adults only (18+).

## Run locally
1. `cp .env.example .env` and fill in values (never commit `.env`).
2. `npm install`
3. `npm run dev:server` (signaling on :8080) and `npm run dev:client` (UI on :5173).

## Login
- Telegram: the server verifies `initData` with HMAC using the bot token (`server/index.js`, `verifyTelegramInitData`).

## Production
Serve `client/dist` and `server/` behind HTTPS (Caddy or nginx).

### TURN relay
Many mobile and corporate networks block direct WebRTC connections, so a TURN relay is needed.
On the VPS run `DOMAIN=your-domain bash deploy/setup-turn.sh`. It installs coturn, generates a
secret kept only on the server, writes `TURN_SECRET`/`TURN_URLS` to `/etc/tg-chatruletka.env`
and restarts the app. The server then gives each matched, signed-in user TURN credentials valid
for 6 hours (coturn `use-auth-secret`). Open 3478/udp+tcp, 5349/tcp and 49152-49999/udp.

## Tests
`npm test`
Set the bot's Mini App URL in BotFather to `PUBLIC_URL`.

## Safety
Age confirmation is a self-declaration only. Report and block buttons exist, but moderation tooling (storage, review queue) is still to be built.
