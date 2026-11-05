const assert = require('node:assert/strict');
const { test } = require('node:test');
const { sleep, room, startServer, connect, until, maskedFrame, rawClient } = require('./helpers');

const SECRET = 'correct-horse';
const BAD_PASSWORD = 4401, NO_ROOM = 4403;

test('отдаёт только страницы судьи и худа', async t => {
  const server = await startServer(t);
  const pages = { '/': 'Мафия · судья', '/hud': 'Мафия', '/win-civilians': "FORCE_MODE='red'", '/win-mafia': "FORCE_MODE='black'" };
  for (const [page, text] of Object.entries(pages)) {
    const res = await fetch(server.http + page);
    assert.equal(res.status, 200, page);
    assert.ok((await res.text()).includes(text), page);
  }
  for (const page of ['/server.js', '/judge.html', '/mafia-hud.html', '/hud/x', '/.env']) {
    assert.equal((await fetch(server.http + page)).status, 404, page);
  }
});

test('не принимает неверную комнату и роль', async t => {
  const server = await startServer(t);
  assert.equal(typeof await connect(t, server.url('short', 'judge')), 'number');
  assert.equal(typeof await connect(t, server.url(room('a'), 'admin')), 'number');
});

test('без пароля пульт и судья обмениваются сообщениями', async t => {
  const server = await startServer(t);
  const judge = await connect(t, server.url(room('a'), 'judge'));
  const panel = await connect(t, server.url(room('a'), 'panel'));
  judge.ws.send('{"kind":"cmd"}');
  panel.ws.send('{"kind":"state"}');
  assert.ok(await until(() => panel.texts().includes('{"kind":"cmd"}')));
  assert.ok(await until(() => judge.texts().includes('{"kind":"state"}')));
});

test('комнату создаёт только пульт с паролем', async t => {
  const server = await startServer(t, SECRET);
  assert.equal(await connect(t, server.url(room('a'), 'panel')), BAD_PASSWORD);
  assert.equal(await connect(t, server.url(room('a'), 'panel', 'nope')), BAD_PASSWORD);
  assert.equal(await connect(t, server.url(room('a'), 'panel', 'x'.repeat(500))), BAD_PASSWORD);
  assert.equal(await connect(t, server.url(room('a'), 'judge')), NO_ROOM);
  assert.equal(await connect(t, server.url(room('a'), 'screen')), NO_ROOM);

  const panel = await connect(t, server.url(room('a'), 'panel', SECRET));
  assert.ok(panel.ws);
  const judge = await connect(t, server.url(room('a'), 'judge'));
  assert.ok((await connect(t, server.url(room('a'), 'screen'))).ws);
  assert.equal(await connect(t, server.url(room('b'), 'judge')), NO_ROOM);

  panel.ws.close();
  await sleep(150);
  assert.equal(judge.ws.readyState, WebSocket.OPEN, 'судья остаётся, пока пульт перезагружается');
  assert.ok((await fetch(`${server.http}/`)).ok);
});

test('пустая комната исчезает', async t => {
  const server = await startServer(t, SECRET);
  const panel = await connect(t, server.url(room('a'), 'panel', SECRET));
  panel.ws.close();
  await sleep(150);
  assert.equal(await connect(t, server.url(room('a'), 'judge')), NO_ROOM);
});

test('судья и экраны говорят только с пультом', async t => {
  const server = await startServer(t, SECRET);
  const panel = await connect(t, server.url(room('a'), 'panel', SECRET));
  const judge = await connect(t, server.url(room('a'), 'judge'));
  const screen = await connect(t, server.url(room('a'), 'screen'));
  const other = await connect(t, server.url(room('a'), 'screen'));

  screen.ws.send('{"from":"screen"}');
  judge.ws.send('{"from":"judge"}');
  assert.ok(await until(() => panel.texts().length === 2));
  panel.ws.send('{"from":"panel"}');
  assert.ok(await until(() => other.texts().includes('{"from":"panel"}')));
  assert.ok(await until(() => screen.texts().includes('{"from":"panel"}')));
  assert.deepEqual(other.texts(), ['{"from":"panel"}']);
  assert.deepEqual(judge.texts(), ['{"from":"panel"}']);
});

test('большие сообщения доходят целыми', async t => {
  const server = await startServer(t, SECRET);
  const panel = await connect(t, server.url(room('a'), 'panel', SECRET));
  const screen = await connect(t, server.url(room('a'), 'screen'));
  for (const size of [125, 126, 65535, 65536, 300000]) {
    const text = JSON.stringify({ data: 'x'.repeat(size) });
    panel.ws.send(text);
    assert.ok(await until(() => screen.texts().at(-1) === text), `размер ${size}`);
  }
});

test('собирает сообщение, разбитое на несколько кадров', async t => {
  const server = await startServer(t, SECRET);
  const panel = await rawClient(t, server.port, room('a'), 'panel', SECRET);
  const screen = await connect(t, server.url(room('a'), 'screen'));
  const text = JSON.stringify({ data: 'я'.repeat(120000) });
  const bytes = Buffer.from(text), third = Math.floor(bytes.length / 3);
  panel.write(maskedFrame(1, false, bytes.subarray(0, third)));
  panel.write(maskedFrame(9, true, Buffer.from('ping')));
  panel.write(maskedFrame(0, false, bytes.subarray(third, third * 2)));
  panel.write(maskedFrame(0, true, bytes.subarray(third * 2)));
  assert.ok(await until(() => screen.texts().at(-1) === text));
  panel.write(maskedFrame(1, true, Buffer.from('{"next":true}')));
  assert.ok(await until(() => screen.texts().at(-1) === '{"next":true}'), 'следующее сообщение не склеилось с прошлым');
});

test('обрывает слишком большое сообщение', async t => {
  const server = await startServer(t, SECRET);
  for (const pieces of [1, 2]) {
    const panel = await rawClient(t, server.port, room('a'), 'panel', SECRET);
    const closed = new Promise(resolve => panel.on('close', () => resolve(true)));
    const size = 1024 * 1024 + 1;
    if (pieces === 1) panel.write(maskedFrame(1, true, Buffer.alloc(size, 120)));
    else {
      panel.write(maskedFrame(1, false, Buffer.alloc(size - 10, 120)));
      panel.write(maskedFrame(0, true, Buffer.alloc(20, 120)));
    }
    assert.ok(await Promise.race([closed, sleep(3000)]), `частей: ${pieces}`);
  }
});

test('ограничивает число подключений к комнате', async t => {
  const server = await startServer(t, SECRET);
  assert.ok((await connect(t, server.url(room('a'), 'panel', SECRET))).ws);
  for (let i = 1; i < 8; i++) assert.ok((await connect(t, server.url(room('a'), 'screen'))).ws);
  assert.equal(typeof await connect(t, server.url(room('a'), 'screen')), 'number');
});
