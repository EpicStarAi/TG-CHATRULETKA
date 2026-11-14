# TG CHATRULETKA

Telegram Mini App for random one-to-one video chat. Adults only (18+).

## Run locally
1. `cp .env.example .env` and fill in values (never commit `.env`).
2. `npm install`
3. `npm run dev:server` (signaling on :8080) and `npm run dev:client` (UI on :5173).

## Login
- Telegram: the server verifies `initData` with HMAC using the bot token (`server/index.js`, `verifyTelegramInitData`).
- Gmail: Google OAuth. Set the redirect URI to `PUBLIC_URL/auth/google/callback` in Google Cloud.

## Production
Serve `client/dist` and `server/` behind HTTPS (Caddy or nginx). WebRTC needs a TURN server for many networks.
Set the bot's Mini App URL in BotFather to `PUBLIC_URL`.

## Safety
Age confirmation is a self-declaration only. Report and block buttons exist, but moderation tooling (storage, review queue) is still to be built.
