const assert = require('node:assert/strict');
const { test } = require('node:test');
const { sleep, room, startServer, connect, until, maskedFrame, rawClient } = require('./helpers');

const SECRET = 'correct-horse';
async function hostFor(t, server) {
  return connect(t, server.url('', 'host', SECRET));
}
const game = host => host.texts().map(JSON.parse).filter(m => m.kind === 'game').at(-1);
const photo = host => host.texts().map(JSON.parse).filter(m => m.kind === 'photo').at(-1);

test('отдаёт только страницы и публичные ресурсы HUD', async t => {
  const server = await startServer(t, SECRET);
  for (const page of ['/', '/panel', '/hud', '/win-civilians', '/win-mafia', '/assets/style.css', '/assets/rules.js']) {
    assert.equal((await fetch(server.http + page)).status, 200, page);
  }
  for (const page of ['/server.js', '/store.js', '/judge.html', '/mafia-hud.html', '/hud/x', '/.env', '/hud.sqlite']) {
    assert.equal((await fetch(server.http + page)).status, 404, page);
  }
});

test('не принимает неверную комнату и роль', async t => {
  const server = await startServer(t, SECRET);
  assert.equal(typeof await connect(t, server.url('short', 'judge')), 'number');
  assert.equal(typeof await connect(t, server.url(room('a'), 'admin')), 'number');
  assert.equal(await connect(t, server.url(room('a'), 'judge')), 4403);
  assert.equal(await connect(t, server.url(room('a'), 'screen')), 4403);
});

test('большие сообщения с фото доходят целыми', async t => {
  const server = await startServer(t, SECRET);
  const host = await hostFor(t, server);
  const observer = await hostFor(t, server);
  for (const size of [125, 126, 65535, 65536, 300000]) {
    const data = 'data:image/jpeg;base64,' + 'A'.repeat(size);
    host.ws.send(JSON.stringify({ kind: 'photo', pid: 'sample', data }));
    assert.ok(await until(() => photo(observer)?.data === data), 'размер ' + size);
  }
});

test('собирает сообщение, разбитое на несколько кадров', async t => {
  const server = await startServer(t, SECRET);
  const host = await rawClient(t, server.port, '', 'host', SECRET);
  const observer = await hostFor(t, server);
  const data = 'data:image/jpeg;base64,' + 'A'.repeat(240000);
  const bytes = Buffer.from(JSON.stringify({ kind: 'photo', pid: 'sample', data }));
  const third = Math.floor(bytes.length / 3);
  host.write(maskedFrame(1, false, bytes.subarray(0, third)));
  host.write(maskedFrame(9, true, Buffer.from('ping')));
  host.write(maskedFrame(0, false, bytes.subarray(third, third * 2)));
  host.write(maskedFrame(0, true, bytes.subarray(third * 2)));
  assert.ok(await until(() => photo(observer)?.data === data));
  host.write(maskedFrame(1, true, Buffer.from('{"kind":"photo","pid":"sample","data":null}')));
  assert.ok(await until(() => photo(observer)?.data === null), 'следующее сообщение обработано отдельно');
});

test('обрывает слишком большое сообщение', async t => {
  const server = await startServer(t, SECRET);
  for (const pieces of [1, 2]) {
    const host = await rawClient(t, server.port, '', 'host', SECRET);
    const closed = new Promise(resolve => host.on('close', () => resolve(true)));
    // Считываем ответ пульта, чтобы события сокета продолжали поступать.
    host.resume();
    const size = 1024 * 1024 + 1;
    if (pieces === 1) host.write(maskedFrame(1, true, Buffer.alloc(size, 120)));
    else {
      host.write(maskedFrame(1, false, Buffer.alloc(size - 10, 120)));
      host.write(maskedFrame(0, true, Buffer.alloc(20, 120)));
    }
    assert.ok(await Promise.race([closed, sleep(3000)]), 'частей: ' + pieces);
  }
});

test('ограничивает число подключений к комнате', async t => {
  const server = await startServer(t, SECRET);
  const host = await hostFor(t, server);
  const hud = (await until(() => game(host))).S.judge.hud;
  for (let i = 0; i < 8; i++) assert.ok((await connect(t, server.url(hud, 'screen'))).ws);
  assert.equal(typeof await connect(t, server.url(hud, 'screen')), 'number');
});
