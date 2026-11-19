const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { isIP } = require('node:net');
const { createGame } = require('./game');
const { createAccess, CLOSE_NO_ROOM, CLOSE_SESSION_EXPIRED } = require('./access');
const { attachTransport, send: sendText } = require('./transport');
const { createResults } = require('./show-results');

const PORT = +process.env.PORT || 8787;
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const SECRET = process.env.JUDGE_SECRET || '';
const TRUST_PROXY = process.env.HUD_TRUST_CADDY === '1';
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'judge', 'data');
const PAGES = {
  '/': 'judge.html',
  '/panel': 'mafia-hud.html',
  '/hud': 'mafia-hud.html',
  '/win-civilians': 'mafia-hud.html',
  '/win-mafia': 'mafia-hud.html',
};
const ASSETS = {
  '/assets/style.css': 'style.css',
  '/assets/rules.js': 'rules.js',
  '/assets/client.js': 'client.js',
  '/assets/state.js': 'state.js',
  '/assets/screen.js': 'screen.js',
  '/assets/panel.js': 'panel.js',
};
const MAX_PER_ROOM = 8;
const CLOSE_RELOAD = 4000;
const FROM_SERVER = { app: 'mafiahud', from: 'server' };
const encode = message => JSON.stringify({ ...FROM_SERVER, ...message });
const send = (socket, message) => sendText(socket, encode(message));
const roles = { host: new Set(), judge: new Set(), screen: new Set() };
const game = SECRET ? createGame(DATA_DIR, path.join(CLIENT_DIR, 'rules.js')) : null;
const access = createAccess(SECRET, game);
const results = createResults(game, publish, send);
let speechEnd, scheduledDeadline;

function scheduleSpeechEnd(retry = 0) {
  const timer = game?.state()?.timer;
  const deadline = timer?.running ? timer.endAt : undefined;
  if (speechEnd && scheduledDeadline === deadline) return;
  clearTimeout(speechEnd);
  speechEnd = null;
  if (deadline === undefined) return;
  scheduledDeadline = deadline;
  const delay = Math.min(2147483647, Math.max(retry, deadline - Date.now()));
  speechEnd = setTimeout(() => {
    speechEnd = null;
    try {
      if (game.expireSpeech()) publish();
      else scheduleSpeechEnd();
    } catch (error) {
      console.error('Не удалось завершить речь:', error.message);
      scheduleSpeechEnd(1000);
    }
  }, delay).unref();
}

function sendPeers() {
  const judge = roles.judge.size;
  for (const host of roles.host) send(host, { kind: 'peers', judge });
}

function sendPhotos(socket, view) {
  const visible = new Set(view.seats.flatMap(seat => [seat.pid, seat.ph]).filter(Boolean));
  for (const id of socket.photos) if (!visible.has(id)) socket.photos.delete(id);
  for (const pid of visible) {
    if (socket.photos.has(pid)) continue;
    socket.photos.add(pid);
    send(socket, { kind: 'photo', pid, data: game.photo(pid) });
  }
}

function sendView(socket, view, text) {
  sendPhotos(socket, view);
  sendText(socket, text);
}

function publish() {
  scheduleSpeechEnd();
  if (roles.screen.size) {
    const view = game.view();
    const text = encode({ kind: 'view', view });
    for (const socket of roles.screen) if (socket.introduced) sendView(socket, view, text);
  }
  if (roles.judge.size) {
    const text = JSON.stringify(game.judgeState());
    for (const socket of roles.judge) sendText(socket, text);
  }
  for (const socket of roles.host) send(socket, { kind: 'game', S: game.state(), ack: socket.seq });
}

function updateRooms() {
  for (const role of ['judge', 'screen']) {
    for (const socket of roles[role]) {
      if (game.owns(role, socket.room)) continue;
      roles[role].delete(socket);
      socket.close(CLOSE_NO_ROOM);
    }
  }
  sendPeers();
}

function photosChanged(ids) {
  for (const pid of ids) {
    for (const socket of roles.screen) socket.photos.delete(pid);
    const text = encode({ kind: 'photo', pid, data: game.photo(pid) });
    for (const socket of roles.host) sendText(socket, text);
  }
}

function hostChange(socket, message) {
  const { seq, client, revision } = message;
  if (!Number.isSafeInteger(seq) || seq < 1 || typeof client !== 'string' || !/^[a-f0-9]{32}$/.test(client)) return;
  const receipt = { client, seq };
  const reject = (error, retry) => send(socket, { kind: 'game', S: game.state(), ack: seq, error, retry });
  const before = game.rooms();
  let result;
  try {
    if (message.kind === 'deletePlayer') result = game.deletePlayer(message.pid, receipt);
    else if (!Array.isArray(message.ops) || !message.ops.every(op => Array.isArray(op) && op.length === 3)) {
      return reject('Некорректные данные правки.');
    } else result = game.patch(message.ops, receipt, revision);
  } catch (error) {
    console.error('Не удалось сохранить изменение:', error.message);
    return reject('Сервер пока не сохранил правку. Повторяем отправку…', true);
  }
  if (result.error) return reject(result.error);
  socket.seq = seq;
  if (result.duplicate) return send(socket, { kind: 'game', S: game.state(), ack: seq });
  if (before !== game.rooms() &&
      (before.room !== game.rooms().room || before.hud !== game.rooms().hud)) updateRooms();
  if (result.deleted?.length) photosChanged(result.deleted);
  publish();
}

function fromHost(socket, message) {
  if (message.kind === 'patch' || message.kind === 'deletePlayer') {
    hostChange(socket, message);
  } else if (message.kind === 'photo') {
    const stored = socket.importing
      ? game.importPhoto(socket.importing, message.pid, message.data)
      : game.setPhoto(message.pid, message.data);
    if (!stored) return send(socket, { kind: 'error', error: 'Фото не принято. Проверьте размер и формат.' });
    if (!socket.importing) {
      photosChanged([message.pid]);
      publish();
    }
  } else if (message.kind === 'import') {
    socket.importing = game.prepareImport(message.S);
    if (!socket.importing) send(socket, { kind: 'error', error: 'Игра для переноса имеет неверный формат.' });
  } else if (message.kind === 'moved' && socket.importing) {
    game.replace(socket.importing);
    socket.importing = null;
    results.cancel();
    updateRooms();
    for (const other of roles.host) if (other !== socket) other.close(CLOSE_RELOAD);
    publish();
    send(socket, { kind: 'moved' });
  } else if (message.kind === 'muFetch') results.fetch(socket, message);
  else if (message.kind === 'muCancel') results.cancel();
  else if (message.kind === 'ping') for (const screen of roles.screen) send(screen, { kind: 'ping' });
}

function fromPlayer(socket, message) {
  if (!game.owns(socket.role, socket.room)) return;
  if (socket.role === 'judge') {
    if (message.kind === 'hello') sendText(socket, JSON.stringify(game.judgeState()));
    else if (message.kind === 'cmd' && game.command(message)) publish();
    return;
  }
  if (message.kind === 'hello' && !socket.introduced) {
    socket.introduced = true;
    const view = game.view();
    sendView(socket, view, encode({ kind: 'view', view }));
  }
  if ((message.kind === 'hello' || message.kind === 'pong') && socket.introduced &&
      ['overlay', 'red', 'black'].includes(message.mode)) {
    const presence = { kind: message.kind, mode: message.mode };
    for (const host of roles.host) send(host, presence);
  }
}

function initialPhotos(socket, ids) {
  let index = 0;
  function next(error) {
    if (error || index === ids.length) return;
    const pid = ids[index++];
    sendText(socket, encode({ kind: 'photo', pid, data: game.photo(pid) }), next);
  }
  next();
}

function clientAddress(request) {
  const forwarded = request.headers['x-hud-client-ip'];
  return TRUST_PROXY && typeof forwarded === 'string' && isIP(forwarded)
    ? forwarded : request.socket.remoteAddress;
}

function connected(socket, request) {
  const url = new URL(request.url, 'http://local');
  const role = url.searchParams.get('role');
  if (!Object.hasOwn(roles, role)) return socket.close(1008);
  const authTimer = setTimeout(() => socket.close(1008), 5000);
  authTimer.unref();
  let expiry;
  let budget = 240;
  let measuredAt = Date.now();
  socket.on('close', () => {
    clearTimeout(authTimer);
    clearTimeout(expiry);
    if (roles[role].delete(socket) && role === 'judge') sendPeers();
    if (role === 'host') results.cancel(socket);
  });
  socket.on('message', (data, binary) => {
    const now = Date.now();
    budget = Math.min(240, budget + (now - measuredAt) * .12) - 1;
    measuredAt = now;
    if (budget < 0 || binary) return socket.close(1008);
    try {
      const message = JSON.parse(data.toString());
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      if (!socket.role) {
        if (message.kind !== 'auth' || data.length > 4096) return socket.close(1008);
        const refused = access.refuse(role, message, clientAddress(request));
        if (refused) return socket.close(refused);
        if (roles[role].size >= MAX_PER_ROOM) return socket.close(1008);
        if (role === 'host') game.open();
        clearTimeout(authTimer);
        Object.assign(socket, { role, room: message.room, seq: 0, photos: new Set() });
        roles[role].add(socket);
        if (role === 'host') {
          const credentials = access.credentials(typeof message.session === 'string' ? message.session : undefined);
          expiry = setTimeout(() => socket.close(CLOSE_SESSION_EXPIRED), credentials.sessionMs);
          expiry.unref();
          send(socket, { kind: 'ready', ...credentials });
          send(socket, { kind: 'game', S: game.state(), ack: 0, hello: true });
          initialPhotos(socket, game.photoIds());
          send(socket, { kind: 'peers', judge: roles.judge.size });
        } else {
          send(socket, { kind: 'ready' });
          if (role === 'judge') {
            send(socket, { kind: 'peers', panel: 1 });
            sendPeers();
          }
        }
      } else if (role === 'host') fromHost(socket, message);
      else fromPlayer(socket, message);
    } catch (error) {
      if (!socket.role) {
        socket.close(1011);
        return;
      }
      console.error('Сообщение не обработано:', error.message);
      send(socket, { kind: 'error', error: 'Не удалось обработать изменение.' });
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') return res.writeHead(404).end();
  const pathname = req.url.split('?')[0];
  if (pathname === '/panel' && !SECRET) return res.writeHead(404).end();
  const name = Object.hasOwn(PAGES, pathname) ? PAGES[pathname]
    : Object.hasOwn(ASSETS, pathname) ? ASSETS[pathname] : null;
  if (!name) return res.writeHead(404).end();
  const file = path.join(CLIENT_DIR, name);
  if (!fs.existsSync(file)) return res.writeHead(404).end();
  const mime = name.endsWith('.js') ? 'text/javascript'
    : name.endsWith('.css') ? 'text/css' : 'text/html';
  res.writeHead(200, {
    'content-type': mime + '; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  fs.createReadStream(file).on('error', error => res.destroy(error)).pipe(res);
});

attachTransport(server, clientAddress, connected);
scheduleSpeechEnd();
server.on('close', () => clearTimeout(speechEnd));
server.listen(PORT, BIND_HOST, () => console.log(`Сервер судьи запущен: http://${BIND_HOST}:${PORT}`));
