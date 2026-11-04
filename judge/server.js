// Сервер судьи: отдаёт страницу для телефона и пересылает сообщения между пультом и судьёй внутри комнаты.
// Игру он не хранит. Зависимостей нет, нужен только Node.js.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = +process.env.PORT || 8787;
const SECRET = process.env.JUDGE_SECRET || ''; // пароль сервера; без него комнаты может создавать любой
const PAGE = path.join(__dirname, 'judge.html');
const MAX_MESSAGE = 64 * 1024;
const MAX_PER_ROOM = 8;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CLOSE_BAD_PASSWORD = 4401, CLOSE_NO_ROOM = 4403;
const rooms = new Map(); // код комнаты -> Set подключений

function frame(sock, opcode, payload) {
  if (sock.destroyed) return;
  const head = payload.length < 126
    ? Buffer.from([0x80 | opcode, payload.length])
    : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 255]);
  sock.write(Buffer.concat([head, payload]));
}
const sendText = (sock, text) => frame(sock, 1, Buffer.from(text));

const digest = text => crypto.createHash('sha256').update(text).digest();
const passwordOk = text => crypto.timingSafeEqual(digest(text), digest(SECRET));

// Комнату создаёт только пульт с паролем, судья входит в уже созданную.
function refusal(role, room, password) {
  if (!SECRET) return 0;
  if (role === 'panel') return passwordOk(password) ? 0 : CLOSE_BAD_PASSWORD;
  return rooms.has(room) ? 0 : CLOSE_NO_ROOM;
}

function sendPeers(room) {
  const list = [...(rooms.get(room) || [])];
  const msg = JSON.stringify({
    kind: 'peers',
    panel: list.filter(s => s.role === 'panel').length,
    judge: list.filter(s => s.role === 'judge').length
  });
  list.forEach(s => sendText(s, msg));
}

function leave(sock) {
  const set = rooms.get(sock.room);
  if (!set || !set.delete(sock)) return;
  if (set.size) sendPeers(sock.room); else rooms.delete(sock.room);
}

function onMessage(sock, text) {
  rooms.get(sock.room)?.forEach(peer => { if (peer !== sock) sendText(peer, text); });
}

function onData(sock, chunk) {
  sock.buf = Buffer.concat([sock.buf, chunk]);
  while (sock.buf.length >= 2) {
    const b0 = sock.buf[0], b1 = sock.buf[1], opcode = b0 & 15;
    let len = b1 & 127, off = 2;
    // браузер всегда маскирует кадры; такие короткие сообщения он не дробит
    if (!(b1 & 128) || !(b0 & 128) || len === 127) return sock.destroy();
    if (len === 126) {
      if (sock.buf.length < 4) return;
      len = sock.buf.readUInt16BE(2);
      off = 4;
    }
    if (len > MAX_MESSAGE) return sock.destroy();
    if (sock.buf.length < off + 4 + len) return;
    const mask = sock.buf.subarray(off, off + 4);
    const data = Buffer.from(sock.buf.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
    sock.buf = sock.buf.subarray(off + 4 + len);
    if (opcode === 1) onMessage(sock, data.toString());
    else if (opcode === 8) { frame(sock, 8, data); return sock.end(); }
    else if (opcode === 9) frame(sock, 10, data);
    else if (opcode === 10) sock.alive = true;
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && new URL(req.url, 'http://x').pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    fs.createReadStream(PAGE).pipe(res);
    return;
  }
  res.writeHead(404).end();
});

server.on('upgrade', (req, sock) => {
  sock.on('error', () => sock.destroy());
  const url = new URL(req.url, 'http://x');
  const room = url.searchParams.get('room') || '', role = url.searchParams.get('role');
  const key = req.headers['sec-websocket-key'];
  const set = rooms.get(room);
  if (url.pathname !== '/ws' || !key || !/^[a-f0-9]{32}$/.test(room) || !['panel', 'judge'].includes(role)
    || (set && set.size >= MAX_PER_ROOM)) {
    sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const refused = refusal(role, room, url.searchParams.get('key') || '');
  if (refused) {
    frame(sock, 8, Buffer.from([refused >> 8, refused & 255]));
    sock.end();
    return;
  }
  Object.assign(sock, { room, role, buf: Buffer.alloc(0), alive: true });
  if (!set) rooms.set(room, new Set());
  rooms.get(room).add(sock);
  sock.setNoDelay(true);
  sock.on('data', chunk => onData(sock, chunk));
  sock.on('close', () => leave(sock));
  sendPeers(room);
});

// пинг держит соединение через туннель и убирает отвалившиеся телефоны
setInterval(() => {
  rooms.forEach(set => set.forEach(sock => {
    if (!sock.alive) return sock.destroy();
    sock.alive = false;
    frame(sock, 9, Buffer.alloc(0));
  }));
}, 30000);

server.listen(PORT, () => console.log(`Сервер судьи запущен: http://localhost:${PORT}`));
