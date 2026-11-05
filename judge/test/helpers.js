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

async function startServer(t, secret) {
  const port = await freePort();
  const env = { ...process.env, PORT: port, JUDGE_SECRET: secret || '' };
  const child = spawn(process.execPath, [path.join(ROOT, 'judge', 'server.js')], { env, stdio: 'ignore' });
  t.after(() => child.kill());
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

// Открывает настоящий пульт в Chrome без окна. OBS подменён, поэтому тест не трогает запущенный OBS.
function openPanel(t, state, { photos = {}, beacon } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mafia-hud-test-'));
  const seed = [
    "const W=WebSocket;window.WebSocket=function(u){if(u.includes(':4455'))throw new Error('no obs');return new W(u)};",
    `localStorage.setItem('mafiaHudState.v4',${JSON.stringify(JSON.stringify(state))});`,
    ...Object.entries(photos).map(([id, data]) => `localStorage.setItem('mafiaHudPhoto.v4.${id}',${JSON.stringify(data)});`),
    beacon ? `setInterval(()=>{const e=document.getElementById('jSt');if(e)fetch('${beacon}/?'+encodeURIComponent(e.textContent),{mode:'no-cors'}).catch(()=>{})},100);` : ''
  ].join('');
  const page = fs.readFileSync(path.join(ROOT, 'mafia-hud.html'), 'utf8').replace('<body>', () => `<body><script>${seed}</script>`);
  const file = path.join(dir, 'panel.html');
  fs.writeFileSync(file, page);
  const chrome = spawn(findChrome(), ['--headless=new', '--disable-gpu', '--no-sandbox', `--user-data-dir=${path.join(dir, 'profile')}`, '--remote-debugging-port=0', `file:///${file.replace(/\\/g, '/').replace(/^\//, '')}#panel`], { stdio: 'ignore' });
  t.after(async () => {
    killTree(chrome);
    await sleep(300); // Windows отпускает файлы профиля не сразу
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  return chrome;
}

// Chrome запускает дочерние процессы, и на Windows их нужно закрывать вместе с основным.
function killTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill();
}

module.exports = { ROOT, sleep, room, startServer, connect, until, maskedFrame, rawClient, findChrome, openPanel };
