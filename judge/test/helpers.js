// Общие помощники тестов: запуск настоящего сервера и клиенты к нему. Зависимостей нет.
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
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

async function startServer(t, secret, data, fixedPort) {
  const port = fixedPort || await freePort();
  const dir = data || tempData(t);
  const env = { ...process.env, PORT: port, JUDGE_SECRET: secret || '', DATA_DIR: dir };
  const child = spawn(process.execPath, [path.join(ROOT, 'judge', 'server.js')], { env, stdio: 'ignore' });
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
  return {
    port,
    data: dir,
    stop,
    http: `http://localhost:${port}`,
    url: (id, role, key) => `ws://localhost:${port}/ws?room=${id}&role=${role}` + (key === undefined ? '' : `&key=${encodeURIComponent(key)}`)
  };
}

// Подключается и ждёт: при отказе возвращает код закрытия, иначе клиента с накопленными сообщениями.
function connect(t, address) {
  return new Promise(resolve => {
    const ws = new WebSocket(address), got = [];
    let timer;
    ws.onmessage = e => got.push(e.data);
    ws.onclose = e => { clearTimeout(timer); resolve(e.code); };
    ws.onopen = () => {
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
function rawClient(t, port, id, role, key) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, 'localhost', () => {
      sock.write(`GET /ws?room=${id}&role=${role}&key=${key || ''} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n\r\n`);
    });
    t.after(() => sock.destroy());
    sock.on('error', reject);
    sock.once('data', data => (data.includes('101') ? resolve(sock) : reject(new Error(String(data)))));
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

module.exports = { ROOT, sleep, room, freePort, tempData, startServer, connect, until, maskedFrame, rawClient, findChrome, openPage, devtools };
