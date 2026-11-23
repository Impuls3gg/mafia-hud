const crypto = require('node:crypto');

const ROOM = /^[a-f0-9]{32}$/;
const SESSION_MS = 30 * 60 * 1000;
const WINDOW_MS = 60000;
const MAX_FAILURES = 12;
const MAX_TRACKED = 2048;
const CLOSE_BAD_PASSWORD = 4401, CLOSE_NO_ROOM = 4403, CLOSE_SESSION_EXPIRED = 4408, CLOSE_RATE_LIMIT = 4429;

const digest = text => crypto.createHash('sha256').update(text).digest();
const equal = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

function createAccess(secret, defaultGame) {
  const failures = new Map();
  const signature = payload => crypto.createHmac('sha256', secret).update('hud-session:' + payload).digest('hex');
  const session = () => {
    const payload = (Date.now() + SESSION_MS) + '.' + crypto.randomBytes(16).toString('hex');
    return payload + '.' + signature(payload);
  };
  function validSession(token) {
    if (!secret) return false;
    if (typeof token !== 'string' || !/^\d{13}\.[a-f0-9]{32}\.[a-f0-9]{64}$/.test(token)) return false;
    const [expires, nonce, mac] = token.split('.');
    return +expires > Date.now() && equal(mac, signature(expires + '.' + nonce));
  }
  function host(auth, address) {
    if (!secret) return CLOSE_BAD_PASSWORD;
    if (validSession(auth.session)) return 0;
    if (typeof auth.session === 'string') return CLOSE_BAD_PASSWORD;
    const now = Date.now();
    for (const [ip, count] of failures) if (count.until <= now) failures.delete(ip);
    const count = failures.get(address);
    if (count?.n >= MAX_FAILURES) return CLOSE_RATE_LIMIT;
    if (typeof auth.key === 'string' && auth.key.length <= 1024 && equal(auth.key, secret)) return 0;
    if (count) count.n++;
    else if (failures.size < MAX_TRACKED) failures.set(address, { n: 1, until: now + WINDOW_MS });
    else return CLOSE_RATE_LIMIT;
    return CLOSE_BAD_PASSWORD;
  }
  function refuse(role, auth, address, game = defaultGame) {
    if (role === 'host') return host(auth, address);
    const key = role === 'judge' ? 'room' : 'hud';
    return typeof auth.room === 'string' && ROOM.test(auth.room) && game?.rooms()[key] === auth.room ? 0 : CLOSE_NO_ROOM;
  }
  function credentials(token = session()) {
    return { session: token, sessionMs: Math.max(0, Number(token.split('.')[0]) - Date.now()) };
  }
  function requestSession(request) {
    return request.headers.cookie?.match(/(?:^|;\s*)mafia_session=([^;]*)/)?.[1];
  }
  return { refuse, credentials, requestSession, authorized: request => validSession(requestSession(request)) };
}

module.exports = { createAccess, CLOSE_NO_ROOM, CLOSE_SESSION_EXPIRED };
