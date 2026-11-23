// Общие помощники тестов: запуск настоящего сервера и клиенты к нему. Зависимостей нет.
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const room = char => char.repeat(32);

function freePort() {
  return new Promise(resolve => {
    const probe = net.createServer().listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const testResources = new WeakMap();
function resources(t) {
  if (!testResources.has(t)) {
    const owned = { stops: [], dirs: [] };
    testResources.set(t, owned);
    t.after(async () => {
      await Promise.all(owned.stops.map(stop => stop()));
      for (const dir of owned.dirs) fs.rmSync(dir, { recursive: true, force: true });
    });
  }
  return testResources.get(t);
}

function tempData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mafia-hud-data-'));
  resources(t).dirs.push(dir);
  return dir;
}

async function startServer(t, secret, data, fixedPort, provision = true) {
  const port = fixedPort || await freePort();
  const dir = data || tempData(t);
  const env = { ...process.env, PORT: port, JUDGE_SECRET: secret || '', DATA_DIR: dir };
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'server.js')], { env, stdio: 'ignore' });
  const stopped = new Promise(resolve => child.once('exit', resolve));
  const stop = () => {
    child.kill();
    return stopped;
  };
  resources(t).stops.push(stop);
  for (let i = 0; i < 50; i++) {
    const open = await new Promise(resolve => {
      const sock = net.connect(port, 'localhost', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => resolve(false));
    });
    if (open) break;
    await sleep(50);
  }
  const http = `http://localhost:${port}`;
  let gameId;
  if (secret && provision) {
    const admin = await signIn(http, secret);
    const dashboard = await admin('/dashboard').then(response => response.json());
    gameId = dashboard.games[0]?.id;
    if (!gameId) {
      const tournament = await testTournament(admin);
      const [newGame] = await stageGames(admin, tournament.id);
      await placeTestGame(admin, tournament.id, newGame.id, tournament.seating);
      gameId = newGame.id;
    }
  }
  const server = {
    port,
    data: dir,
    stop,
    http,
    gameId,
    gameUrl: http + '/games/' + gameId,
    url: (id, role, key, selected = gameId) => ({
      address: `ws://localhost:${port}/ws?` + new URLSearchParams({ role, game: selected ?? '' }),
      auth: { room: id, key },
    }),
  };
  return server;
}

async function signIn(base, key) {
  const session = await fetch(base + '/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }),
  });
  if (!session.ok) throw new Error('Не удалось войти, HTTP ' + session.status);
  const cookie = session.headers.get('set-cookie').split(';')[0];
  return (route, method = 'GET', data) => fetch(base + '/api' + route, {
    method, headers: { cookie, ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

async function testTournament(admin) {
  const tournament = await admin('/tournaments', 'POST', { title: 'Тестовый турнир' }).then(response => response.json());
  const players = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    admin('/tournaments/' + tournament.id + '/participants', 'POST', { nick: 'Игрок ' + (i + 1) })
      .then(response => response.json())));
  return { id: tournament.id, seating: players.map(player => player.id) };
}

async function stageGames(admin, tournament, { name = 'Тестовая игра', rounds = 1, players = 10 } = {}) {
  const path = '/tournaments/' + tournament;
  const setup = await admin(path + '/admin/stage', 'POST', { name, rounds, players, coefficient: 1, final: false, swiss: false });
  if (!setup.ok) throw new Error('Не удалось создать стадию. ' + await setup.text());
  const { stages } = await admin(path + '/admin').then(response => response.json());
  const stageId = stages.find(stage => stage.name === name).id;
  const created = await admin(path + '/admin/create', 'POST', { stageId });
  if (!created.ok) throw new Error('Не удалось создать игры. ' + await created.text());
  return (await admin(path).then(response => response.json())).games.filter(game => game.stageId === stageId);
}

async function placeTestGame(admin, tournament, gameId, players) {
  const seating = Array.from({ length: 10 }, (_, index) => players[index] ?? '');
  const response = await admin('/tournaments/' + tournament + '/admin/place', 'POST', { gameId, seating, overwrite: true });
  if (!response.ok) throw new Error('Не удалось сохранить рассадку. ' + await response.text());
  return admin('/games/' + gameId).then(response => response.json());
}

async function seedSeating(t, server, game) {
  const client = await connect(t, server.url(game.links.judge.split('#')[1], 'judge', undefined, game.id));
  try {
    const message = kind => client.texts().map(JSON.parse).find(item => item.kind === kind);
    client.ws.send('{"kind":"hello"}');
    const initial = await until(() => message('state'));
    const names = initial.seats.map((_, i) => 'Игрок ' + (i + 1));
    client.ws.send(JSON.stringify({ kind: 'seating', names, version: initial.seating.version, shuffle: false, request: 1 }));
    const result = await until(() => message('seatingResult'));
    if (!result || result.error) throw new Error(result?.error || 'Рассадка не сохранена.');
  } finally {
    client.ws.close();
  }
}

// Подключается и ждёт: при отказе возвращает код закрытия, иначе клиента с накопленными сообщениями.
function connect(t, { address, auth }) {
  return new Promise(resolve => {
    const ws = new WebSocket(address), got = [];
    let timer;
    ws.onmessage = e => got.push(e.data);
    ws.onclose = e => { clearTimeout(timer); resolve(e.code); };
    ws.onopen = () => {
      ws.send(JSON.stringify({ kind: 'auth', ...auth }));
      timer = setTimeout(() => {
        ws.onclose = null;
        t.after(() => ws.close());
        resolve({ ws, got, texts: () => got.filter(m => !m.startsWith('{"kind":"peers"')) });
      }, 150);
    };
  });
}

async function until(check, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  return check();
}

function hostSend(host) {
  const client = crypto.randomBytes(16).toString('hex');
  return message => {
    if (message.kind === 'patch') {
      const state = host.texts().map(JSON.parse).filter(m => m.kind === 'game').at(-1).S;
      const ops = message.ops.map(op => {
        if (!Array.isArray(op) || op.length !== 2) return op;
        const [path, value] = op;
        const previous = path.reduce((node, key) => node && Object.hasOwn(node, key) ? node[key] : undefined, state);
        return [path, value, { value: previous }];
      });
      message = { ...message, client, revision: state.revision, ops };
    }
    host.ws.send(JSON.stringify(message));
  };
}

// Собирает кадр так, как его отправляет браузер: с маской и нужной длиной.
function maskedFrame(opcode, fin, payload) {
  const mask = crypto.randomBytes(4), len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([(fin ? 128 : 0) | opcode, 128 | len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = (fin ? 128 : 0) | opcode;
    head[1] = 128 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = (fin ? 128 : 0) | opcode;
    head[1] = 128 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  const body = Buffer.from(payload);
  for (let i = 0; i < len; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

// Клиент без браузера: нужен, чтобы отправлять дроблёные сообщения.
function rawClient(t, port, id, role, key, gameId) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, 'localhost', () => {
      sock.write(`GET /ws?role=${role}&game=${gameId} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n\r\n`);
    });
    t.after(() => sock.destroy());
    sock.on('error', reject);
    sock.once('data', data => {
      if (!data.includes('101')) return reject(new Error(String(data)));
      sock.write(maskedFrame(1, true, Buffer.from(JSON.stringify({ kind: 'auth', room: id, key }))));
      resolve(sock);
    });
  });
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  return candidates.find(file => file && fs.existsSync(file));
}

async function closeChrome(chrome, dir) {
  killTree(chrome);
  await sleep(300); // Windows отпускает файлы профиля не сразу
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

// Открывает страницу в Chrome и возвращает управление ею: page.run выполняет код на странице, page.close закрывает браузер.
async function openPage(t, url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mafia-hud-test-'));
  const port = await freePort();
  const chrome = spawn(findChrome(), ['--headless=new', '--disable-gpu', '--no-sandbox', `--user-data-dir=${path.join(dir, 'profile')}`, `--remote-debugging-port=${port}`, url], { stdio: 'ignore', detached: process.platform !== 'win32' });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await closeChrome(chrome, dir); } };
  t.after(close);
  return { ...await devtools(port), close };
}

// Подключается к открытой вкладке Chrome по его отладочному протоколу.
async function devtools(port) {
  const tab = await until(async () => {
    const list = await fetch(`http://localhost:${port}/json`).then(res => res.json()).catch(() => []);
    return list.find(item => item.type === 'page');
  }, 20000);
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(resolve => { socket.onopen = resolve; });
  let id = 0;
  const waiting = new Map();
  socket.onmessage = e => {
    const reply = JSON.parse(e.data);
    waiting.get(reply.id)?.(reply);
    waiting.delete(reply.id);
  };
  const run = expression => new Promise((resolve, reject) => {
    waiting.set(++id, reply => {
      const details = reply.result?.exceptionDetails;
      if (details) reject(new Error(details.exception?.description || details.text));
      else resolve(reply.result?.result?.value);
    });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  return { run };
}

// Chrome запускает дочерние процессы, и на Windows их нужно закрывать вместе с основным.
function killTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
}

module.exports = { ROOT, sleep, room, tempData, startServer, signIn, testTournament, stageGames, placeTestGame, seedSeating, connect, until, hostSend, maskedFrame, rawClient, findChrome, openPage };
