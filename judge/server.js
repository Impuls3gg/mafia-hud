// Сервер судьи: отдаёт страницы для телефона и OBS, хранит игру и пересылает сообщения между пультом, судьёй и экранами.
// Игра хранится, только если задан пароль сервера. Без него сервер лишь пересылает сообщения. Зависимостей нет, нужен только Node.js.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createGame } = require('./game');

const PORT = +process.env.PORT || 8787;
const SECRET = process.env.JUDGE_SECRET || ''; // пароль сервера; без него комнаты может создавать любой
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PAGES = { '/': 'judge.html', '/hud': 'mafia-hud.html', '/win-civilians': 'win-civilians.html', '/win-mafia': 'win-mafia.html' };
if (SECRET) PAGES['/panel'] = 'mafia-hud.html';
const ROLES = ['panel', 'judge', 'screen', 'host']; // host — пульт, открытый с сервера
const HOSTS = 'hosts'; // такие пульты не привязаны к комнате
const MAX_MESSAGE = 1024 * 1024; // фото игроков идут одним сообщением
const MAX_PER_ROOM = 8;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CLOSE_BAD_PASSWORD = 4401, CLOSE_NO_ROOM = 4403, CLOSE_MOVED = 4409, CLOSE_RELOAD = 4000;
const FROM_SERVER = { app: 'mafiahud', from: 'server' };
const rooms = new Map(); // код комнаты -> Set подключений

// На сервере страницы лежат рядом, а в репозитории файлы худа находятся на уровень выше.
const pagePath = name => [__dirname, path.join(__dirname, '..')].map(dir => path.join(dir, name)).find(fs.existsSync);
const game = SECRET ? createGame(DATA_DIR, pagePath('mafia-hud.html')) : null;

function frame(sock, opcode, payload) {
  if (sock.destroyed) return;
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) head = Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]);
  else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  sock.write(Buffer.concat([head, payload]));
}
const sendText = (sock, text) => frame(sock, 1, Buffer.from(text));
const send = (sock, message) => sendText(sock, JSON.stringify({ ...FROM_SERVER, ...message }));
const members = (room, role) => [...(rooms.get(room) || [])].filter(s => !role || s.role === role);
function closeWith(sock, code) {
  frame(sock, 8, Buffer.from([code >> 8, code & 255]));
  sock.end();
}

const digest = text => crypto.createHash('sha256').update(text).digest();
const passwordOk = text => crypto.timingSafeEqual(digest(text), digest(SECRET));

// Комнату создаёт только пульт с паролем, судья и экраны входят в уже созданную. В комнатах хранимой игры пульт заменяет сам сервер.
function refusal(role, room, password) {
  if (role === 'host') return game && passwordOk(password) ? 0 : CLOSE_BAD_PASSWORD;
  if (SECRET && role === 'panel' && !passwordOk(password)) return CLOSE_BAD_PASSWORD;
  if (game?.owns(room)) {
    if (role === 'panel') return CLOSE_MOVED;
    return room === game.rooms()[role === 'judge' ? 'room' : 'hud'] ? 0 : CLOSE_NO_ROOM;
  }
  if (SECRET && role !== 'panel' && !rooms.has(room)) return CLOSE_NO_ROOM;
  return 0;
}

function sendPeers(room) {
  const list = members(room);
  const owned = !!game?.owns(room);
  const judges = list.filter(s => s.role === 'judge').length;
  const msg = JSON.stringify({
    kind: 'peers',
    panel: owned ? 1 : list.filter(s => s.role === 'panel').length,
    judge: judges
  });
  list.forEach(s => sendText(s, msg));
  if (owned && room === game.rooms().room) members(HOSTS).forEach(s => send(s, { kind: 'peers', judge: judges }));
}

function leave(sock) {
  const set = rooms.get(sock.room);
  if (!set || !set.delete(sock)) return;
  if (!set.size) rooms.delete(sock.room);
  sendPeers(sock.room);
}

function sendPhotos(sock) {
  game.seatedPhotos().forEach(pid => {
    if (sock.photos.has(pid)) return;
    sock.photos.add(pid);
    send(sock, { kind: 'photo', pid, data: game.photo(pid) });
  });
}

function sendView(sock) {
  sendPhotos(sock); // сначала фото, чтобы при смене роли плашка не мигала пустой
  send(sock, { kind: 'view', view: game.view() });
}

// После каждого изменения экраны, судья и открытые пульты получают новую игру.
function publish() {
  const { room, hud } = game.rooms();
  members(hud, 'screen').forEach(sendView);
  members(room, 'judge').forEach(s => sendText(s, JSON.stringify(game.judgeState())));
  members(HOSTS).forEach(s => send(s, { kind: 'game', S: game.state(), ack: s.seq }));
}

function changeRooms(before) {
  for (const old of [before.room, before.hud]) {
    if (old && !game.owns(old)) members(old).forEach(s => closeWith(s, CLOSE_NO_ROOM));
  }
  for (const room of [game.rooms().room, game.rooms().hud]) {
    members(room, 'panel').forEach(s => closeWith(s, CLOSE_MOVED));
    sendPeers(room);
  }
}

function fromHost(sock, message) {
  const before = { ...game.rooms() };
  if (message.kind === 'patch' && Array.isArray(message.ops)) {
    sock.seq = message.seq;
    game.patch(message.ops);
    if (before.room !== game.rooms().room || before.hud !== game.rooms().hud) changeRooms(before);
    publish();
  } else if (message.kind === 'photo' && game.setPhoto(message.pid, message.data)) {
    members(game.rooms().hud).forEach(s => s.photos.delete(message.pid));
    members(HOSTS).forEach(s => { if (s !== sock) send(s, message); });
    if (!sock.importing) publish();
  } else if (message.kind === 'import' && game.replace(message.S)) {
    sock.importing = true;
    changeRooms(before);
  } else if (message.kind === 'moved') {
    sock.importing = false;
    members(HOSTS).forEach(s => { if (s !== sock) closeWith(s, CLOSE_RELOAD); });
    publish();
    send(sock, { kind: 'moved' });
  } else if (message.kind === 'ping') members(game.rooms().hud, 'screen').forEach(s => send(s, { kind: 'ping' }));
}

function fromPlayer(sock, message, text) {
  if (sock.role === 'judge') {
    if (message.kind === 'hello') sendText(sock, JSON.stringify(game.judgeState()));
    else if (message.kind === 'cmd' && game.command(message)) publish();
    return;
  }
  if (message.kind === 'hello') {
    sock.photos.clear();
    sendView(sock);
  }
  if (message.kind === 'hello' || message.kind === 'pong') members(HOSTS).forEach(s => sendText(s, text));
}

function onMessage(sock, text) {
  if (sock.role === 'host' || game?.owns(sock.room)) {
    let message;
    try {
      message = JSON.parse(text);
      if (sock.role === 'host') fromHost(sock, message);
      else fromPlayer(sock, message, text);
    } catch (error) {
      console.error('Сообщение не обработано:', error.message);
    }
    return;
  }
  // судья и экраны говорят только с пультом, поэтому не могут подделать данные друг для друга
  rooms.get(sock.room)?.forEach(peer => { if (peer !== sock && (sock.role === 'panel' || peer.role === 'panel')) sendText(peer, text); });
}

function onData(sock, chunk) {
  sock.buf = Buffer.concat([sock.buf, chunk]);
  while (sock.buf.length >= 2) {
    const b0 = sock.buf[0], b1 = sock.buf[1], opcode = b0 & 15;
    let len = b1 & 127, off = 2;
    // браузер всегда маскирует кадры, а большие сообщения дробит на несколько
    if (!(b1 & 128)) return sock.destroy();
    if (len === 126) {
      if (sock.buf.length < 4) return;
      len = sock.buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (sock.buf.length < 10) return;
      const big = sock.buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE)) return sock.destroy();
      len = Number(big);
      off = 10;
    }
    if (len > MAX_MESSAGE) return sock.destroy();
    if (sock.buf.length < off + 4 + len) return;
    const mask = sock.buf.subarray(off, off + 4);
    const data = Buffer.from(sock.buf.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
    sock.buf = sock.buf.subarray(off + 4 + len);
    if (opcode === 0 || opcode === 1) {
      sock.parts.push(data);
      sock.partsSize += len;
      if (sock.partsSize > MAX_MESSAGE) return sock.destroy();
      if (b0 & 128) {
        const text = Buffer.concat(sock.parts).toString();
        sock.parts = [];
        sock.partsSize = 0;
        onMessage(sock, text);
      }
    } else if (opcode === 8) { frame(sock, 8, data); return sock.end(); }
    else if (opcode === 9) frame(sock, 10, data);
    else if (opcode === 10) sock.alive = true;
  }
}

const server = http.createServer((req, res) => {
  const name = PAGES[new URL(req.url, 'http://x').pathname];
  const file = req.method === 'GET' && name && pagePath(name);
  if (!file) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

server.on('upgrade', (req, sock) => {
  sock.on('error', () => sock.destroy());
  const url = new URL(req.url, 'http://x');
  const role = url.searchParams.get('role');
  const room = role === 'host' ? HOSTS : url.searchParams.get('room') || '';
  const key = req.headers['sec-websocket-key'];
  const set = rooms.get(room);
  if (url.pathname !== '/ws' || !key || (role !== 'host' && !/^[a-f0-9]{32}$/.test(room)) || !ROLES.includes(role)
    || (set && set.size >= MAX_PER_ROOM)) {
    sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const refused = refusal(role, room, url.searchParams.get('key') || '');
  if (refused) return closeWith(sock, refused);
  Object.assign(sock, { room, role, buf: Buffer.alloc(0), parts: [], partsSize: 0, alive: true, seq: 0, photos: new Set() });
  if (!set) rooms.set(room, new Set());
  rooms.get(room).add(sock);
  sock.setNoDelay(true);
  sock.on('data', chunk => onData(sock, chunk));
  sock.on('close', () => leave(sock));
  sendPeers(room);
  if (role === 'host') {
    game.open();
    send(sock, { kind: 'game', S: game.state(), ack: 0, hello: true });
    game.photoIds().forEach(pid => send(sock, { kind: 'photo', pid, data: game.photo(pid) }));
    send(sock, { kind: 'peers', judge: members(game.rooms().room, 'judge').length });
  }
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
