import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyTelegramInitData, turnCredentials } from './index.js';

const BOT = '123:TEST';
function signedInitData(fields, botToken = BOT) {
  const p = new URLSearchParams(fields);
  const dataCheck = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(dataCheck).digest('hex'));
  return p.toString();
}
const now = () => String(Math.floor(Date.now() / 1000));

test('accepts correctly signed Telegram initData', () => {
  const data = signedInitData({ auth_date: now(), user: JSON.stringify({ id: 42, first_name: 'Ann' }) });
  assert.deepEqual(verifyTelegramInitData(data, BOT), { id: 'tg:42', provider: 'telegram', name: 'Ann' });
});

test('rejects initData signed with another bot token or tampered', () => {
  const data = signedInitData({ auth_date: now(), user: JSON.stringify({ id: 42 }) }, '999:OTHER');
  assert.equal(verifyTelegramInitData(data, BOT), null);
  const ok = signedInitData({ auth_date: now(), user: JSON.stringify({ id: 42 }) });
  assert.equal(verifyTelegramInitData(ok.replace('42', '43'), BOT), null);
});

test('rejects stale initData', () => {
  const data = signedInitData({ auth_date: String(Math.floor(Date.now() / 1000) - 2 * 86400), user: '{"id":1}' });
  assert.equal(verifyTelegramInitData(data, BOT), null);
});

test('TURN credentials follow the coturn use-auth-secret scheme', () => {
  const t = turnCredentials('tg:42', { secret: 's3cret', urls: ['turn:x:3478'], now: 1_000_000_000_000, ttlSec: 3600 });
  assert.equal(t.username, '1000003600:tg-42');
  assert.equal(t.credential, crypto.createHmac('sha1', 's3cret').update('1000003600:tg-42').digest('base64'));
  assert.deepEqual(t.urls, ['turn:x:3478']);
});

test('no TURN credentials without secret or URLs', () => {
  assert.equal(turnCredentials('tg:1', { secret: '', urls: ['turn:x'] }), null);
  assert.equal(turnCredentials('tg:1', { secret: 'x', urls: [] }), null);
});
