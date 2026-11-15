// TG CHATRULETKA signaling and Telegram auth server (Node 18+, no framework)
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8080);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const ICE_SERVERS = JSON.parse(process.env.ICE_SERVERS || '[{"urls":"stun:stun.l.google.com:19302"}]');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
// TURN relay (coturn with use-auth-secret). Credentials are short-lived and only handed to signed-in users.
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_URLS = (process.env.TURN_URLS || '').split(',').map((u) => u.trim()).filter(Boolean);
const TURN_TTL_SEC = 6 * 60 * 60;

const sessions = new Map(); // token -> { userId, provider, name, exp }
const users = new Map();    // userId -> profile
const waiting = [];         // queue of socket clients
const clients = new Set();

// ---- Telegram Mini App initData verification (HMAC per Telegram docs) ----
// Returns { profile } or { error } with a short reason code (no secrets) for logs and the client.
export function checkTelegramInitData(initData, botToken, maxAgeSec = 86400) {
  if (!botToken) return { error: 'bot_token_missing' };
  if (!initData) return { error: 'init_data_empty' };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { error: 'hash_missing' };
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) {
    return { error: 'bad_signature' }; // usually: TELEGRAM_BOT_TOKEN belongs to a different bot
  }
  const authDate = Number(params.get('auth_date') || 0);
  if (Date.now() / 1000 - authDate > maxAgeSec) return { error: 'expired' };
  let user;
  try { user = JSON.parse(params.get('user') || '{}'); } catch { return { error: 'bad_user' }; }
  if (!user.id) return { error: 'bad_user' };
  return { profile: { id: `tg:${user.id}`, provider: 'telegram', name: user.first_name || 'User' } };
}

export function verifyTelegramInitData(initData, botToken, maxAgeSec = 86400) {
  return checkTelegramInitData(initData, botToken, maxAgeSec).profile || null;
}

// Which bot does TELEGRAM_BOT_TOKEN belong to? Logged at startup and exposed in /config,
// so a token from the wrong bot is visible immediately.
let botUsername = process.env.TELEGRAM_BOT_USERNAME || '';
async function loadBotInfo() {
  if (!BOT_TOKEN) { console.warn('TELEGRAM_BOT_TOKEN is not set: Telegram sign-in is disabled'); return; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`).then((x) => x.json());
    if (r.ok) { botUsername = r.result.username; console.log(`Telegram bot: @${botUsername}`); }
    else console.warn(`Telegram getMe rejected the bot token: ${r.description}`);
  } catch (e) {
    console.warn(`Telegram getMe failed: ${e.message}`);
  }
}

// TURN REST API credentials (coturn `use-auth-secret`): username = "<expiry>:<user>", password = base64(HMAC-SHA1(secret, username)).
export function turnCredentials(userId, { secret = TURN_SECRET, urls = TURN_URLS, now = Date.now(), ttlSec = TURN_TTL_SEC } = {}) {
  if (!secret || !urls.length) return null;
  const username = `${Math.floor(now / 1000) + ttlSec}:${String(userId).replace(/:/g, '-')}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { urls, username, credential };
}

function iceServersFor(user) {
  const turn = turnCredentials(user.id);
  return turn ? [...ICE_SERVERS, turn] : ICE_SERVERS;
}

function issueSession(profile) {
  const token = crypto.randomBytes(32).toString('hex');
  users.set(profile.id, profile);
  sessions.set(token, { userId: profile.id, exp: Date.now() + SESSION_TTL_MS });
  return token;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) reject(new Error('too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
  });
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);

  if (url.pathname === '/config') return send(res, 200, { iceServers: ICE_SERVERS, telegramEnabled: !!BOT_TOKEN, botUsername });

  if (url.pathname === '/auth/telegram' && req.method === 'POST') {
    try {
      const { initData } = await readJson(req);
      const { profile, error } = checkTelegramInitData(String(initData || ''), BOT_TOKEN);
      if (!profile) {
        console.warn(`Telegram sign-in rejected: ${error}`);
        return send(res, 401, { error });
      }
      return send(res, 200, { token: issueSession(profile), name: profile.name });
    } catch { return send(res, 400, { error: 'bad_request' }); }
  }

  if (url.pathname === '/health') return send(res, 200, { ok: true, online: clients.size });
  return send(res, 404, { error: 'not_found' });
});

// ---- Matchmaking and WebRTC signaling over WebSocket ----
const wss = new WebSocketServer({ server, path: '/ws' });

function sessionFromToken(token) {
  const s = sessions.get(token);
  if (!s || s.exp < Date.now()) return null;
  return users.get(s.userId);
}

function removeFromQueue(ws) {
  const i = waiting.indexOf(ws);
  if (i >= 0) waiting.splice(i, 1);
}

function unpair(ws, notify = true) {
  const peer = ws.peer;
  if (!peer) return;
  ws.peer = null;
  peer.peer = null;
  if (notify && peer.readyState === 1) peer.send(JSON.stringify({ type: 'peer_left' }));
}

function tryMatch(ws) {
  removeFromQueue(ws);
  const other = waiting.find((w) => w !== ws && w.readyState === 1 && w.user.id !== ws.user.id);
  if (!other) { waiting.push(ws); ws.send(JSON.stringify({ type: 'searching' })); return; }
  removeFromQueue(other);
  ws.peer = other; other.peer = ws;
  ws.send(JSON.stringify({ type: 'matched', role: 'caller', name: other.user.name, iceServers: iceServersFor(ws.user) }));
  other.send(JSON.stringify({ type: 'matched', role: 'callee', name: ws.user.name, iceServers: iceServersFor(other.user) }));
}

wss.on('connection', (ws, req) => {
  const token = new URL(req.url, PUBLIC_URL).searchParams.get('token') || '';
  const user = sessionFromToken(token);
  if (!user) { ws.send(JSON.stringify({ type: 'auth_required' })); return ws.close(4401); }
  ws.user = user;
  clients.add(ws);
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
    switch (msg.type) {
      case 'start': return tryMatch(ws);
      case 'next': unpair(ws); return tryMatch(ws);
      case 'stop': unpair(ws); removeFromQueue(ws); return;
      case 'signal':
        if (ws.peer && ws.peer.readyState === 1) ws.peer.send(JSON.stringify({ type: 'signal', data: msg.data }));
        return;
      case 'chat':
        if (ws.peer && ws.peer.readyState === 1 && typeof msg.text === 'string') {
          ws.peer.send(JSON.stringify({ type: 'chat', text: msg.text.slice(0, 500) }));
        }
        return;
      case 'report': // store for moderation; here we just drop the pair
        console.log(`report by ${ws.user.id} against peer ${ws.peer?.user?.id}`);
        unpair(ws); removeFromQueue(ws); return;
    }
  });
  ws.on('close', () => { unpair(ws); removeFromQueue(ws); clients.delete(ws); });
});

if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  server.listen(PORT, () => console.log(`TG CHATRULETKA server on :${PORT}`));
  loadBotInfo();
}

export { server, sessions, users };
