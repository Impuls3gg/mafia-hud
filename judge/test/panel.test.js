// Проверяет настоящий пульт в Chrome вместе с настоящим сервером.
const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { room, startServer, connect, until, findChrome, openPanel } = require('./helpers');

const skip = findChrome() ? false : 'нужен Chrome: укажите путь в CHROME_PATH';
const SECRET = 'correct-horse';
const NICKS = ['Алиса', 'Борис', 'Вера', 'Глеб', 'Дарья', 'Егор', 'Жанна', 'Захар', 'Ирина', 'Кирилл'];
// как в mafia-hud.html: фото 300×400 в JPEG, но для теста размер важнее содержимого
const PHOTO = 'data:image/png;base64,' + Buffer.alloc(180000, 7).toString('base64');

function gameState(judge) {
  return {
    v: 1, title: 'Кубок города', game: 3, accent: '#1c7ed6', showFouls: true, photoVer: 0, judge,
    roster: NICKS.map((nick, i) => ({ id: 'p' + i, nick })),
    seats: NICKS.map((_, i) => ({ pid: 'p' + i, role: 'civ', status: 'alive', fouls: 0 })),
    nights: [{ shot: '', check: '', don: '' }],
    wait: { show: false, running: false, endAt: 0, left: 1, total: 1 }
  };
}

// Пульт раз в 100 мс сообщает сюда текст статуса судьи.
function statusBeacon(t) {
  return new Promise(resolve => {
    const box = { text: '' };
    const server = http.createServer((req, res) => {
      box.text = decodeURIComponent(req.url.slice(2));
      res.writeHead(204, { 'access-control-allow-origin': '*' }).end();
    }).listen(0, () => {
      box.url = `http://localhost:${server.address().port}`;
      resolve(box);
    });
    t.after(() => { server.close(); server.closeAllConnections(); });
  });
}

async function joinWhenReady(t, address) {
  return until(async () => {
    const client = await connect(t, address);
    return client.ws ? client : null;
  }, 20000);
}

function lastState(judge) {
  return judge.texts().map(text => JSON.parse(text)).filter(m => m.kind === 'state').at(-1);
}

test('команды судьи меняют игру в пульте', { skip }, async t => {
  const server = await startServer(t);
  const judge = await connect(t, server.url(room('a'), 'judge'));
  openPanel(t, gameState({ url: server.http, room: room('a'), hud: room('f'), key: '' }));
  assert.ok(await until(() => judge.got.some(m => m.includes('"panel":1')), 20000), 'пульт не подключился');
  judge.ws.send('{"kind":"hello"}');
  assert.ok(await until(() => lastState(judge)));
  assert.equal(lastState(judge).seats[3].nick, 'Глеб');

  const send = async (cmd, ok) => {
    judge.ws.send(JSON.stringify({ kind: 'cmd', ...cmd }));
    assert.ok(await until(() => ok(lastState(judge).seats)), JSON.stringify(cmd));
  };
  await send({ a: 'role', i: 3, v: 'mafia' }, s => s[3].role === 'mafia');
  await send({ a: 'foul', i: 0, d: 1 }, s => s[0].fouls === 1);
  await send({ a: 'foul', i: 0, d: 1 }, s => s[0].fouls === 2);
  await send({ a: 'foul', i: 0, d: 1 }, s => s[0].fouls === 3 && s[0].st === 'alive');
  await send({ a: 'foul', i: 0, d: 1 }, s => s[0].st === 'removed');
  await send({ a: 'status', i: 0, v: 'alive' }, s => s[0].st === 'alive' && s[0].fouls === 3);
  await send({ a: 'status', i: 8, v: 'voted' }, s => s[8].st === 'voted');
  await send({ a: 'shot', i: 2 }, s => s[2].st === 'killed' && s[2].kn === 1);
  await send({ a: 'shot', i: 6 }, s => s[6].kn === 2);
  await send({ a: 'shot', i: 2 }, s => s[2].st === 'alive');

  const count = judge.texts().length;
  judge.ws.send('{"kind":"cmd","a":"role","i":3,"v":"king"}');
  judge.ws.send('{"kind":"cmd","a":"foul","i":99,"d":1}');
  judge.ws.send('{"kind":"cmd","a":"status","i":1,"v":"alive"}');
  assert.ok(await until(() => judge.texts().length > count));
  assert.equal(lastState(judge).seats[3].role, 'mafia', 'неверная роль не применяется');
  assert.equal(lastState(judge).seats.length, 10);
});

test('роль можно не выдавать и снять', { skip }, async t => {
  const server = await startServer(t);
  const state = gameState({ url: server.http, room: room('a'), hud: room('f'), key: '' });
  state.seats.forEach(seat => { seat.role = ''; });
  const judge = await connect(t, server.url(room('a'), 'judge'));
  openPanel(t, state, { photos: { p0: PHOTO, 'p0.mafia': PHOTO + 'AA' } });
  assert.ok(await until(() => judge.got.some(m => m.includes('"panel":1')), 20000), 'пульт не подключился');

  const screen = await joinWhenReady(t, server.url(room('f'), 'screen'));
  const view = () => screen.texts().map(text => JSON.parse(text)).filter(m => m.kind === 'view').at(-1)?.view;
  screen.ws.send(JSON.stringify({ app: 'mafiahud', from: 'test', kind: 'hello', mode: 'overlay' }));
  assert.ok(await until(() => view()));
  assert.equal(view().seats[0].role, '');
  assert.equal(view().seats[0].ph, 'p0', 'без роли показывается обычное фото');

  judge.ws.send('{"kind":"cmd","a":"role","i":0,"v":"mafia"}');
  assert.ok(await until(() => view().seats[0].ph === 'p0.mafia'), 'с ролью показывается фото роли');
  judge.ws.send('{"kind":"cmd","a":"role","i":0,"v":""}');
  assert.ok(await until(() => view().seats[0].role === '' && view().seats[0].ph === 'p0'), 'роль не снялась');
});

test('пульт сообщает о неверном пароле и не повторяет попытки', { skip }, async t => {
  const server = await startServer(t, SECRET);
  const beacon = await statusBeacon(t);
  openPanel(t, gameState({ url: server.http, room: room('a'), hud: room('f'), key: 'wrong' }), { beacon: beacon.url });
  assert.ok(await until(() => beacon.text.includes('Неверный пароль сервера'), 20000), beacon.text);
  await new Promise(resolve => setTimeout(resolve, 3500));
  assert.ok(beacon.text.includes('Неверный пароль сервера'), beacon.text);
});

test('пульт с паролем передаёт данные экрану через сервер', { skip }, async t => {
  const server = await startServer(t, SECRET);
  const beacon = await statusBeacon(t);
  openPanel(t, gameState({ url: server.http, room: room('a'), hud: room('f'), key: SECRET }), { photos: { p0: PHOTO }, beacon: beacon.url });
  assert.ok(await until(() => beacon.text.includes('судья ещё не зашёл'), 20000), beacon.text);

  const screen = await joinWhenReady(t, server.url(room('f'), 'screen'));
  assert.ok(screen, 'экран не подключился');
  const messages = () => screen.texts().map(text => JSON.parse(text));
  screen.ws.send(JSON.stringify({ app: 'mafiahud', from: 'test', kind: 'hello', mode: 'overlay' }));
  assert.ok(await until(() => messages().some(m => m.kind === 'view')));
  assert.equal(messages().filter(m => m.kind === 'view').at(-1).view.seats[0].nick, 'Алиса');
  assert.ok(await until(() => messages().some(m => m.kind === 'photo' && m.data === PHOTO)), 'фото не дошло');

  const judge = await joinWhenReady(t, server.url(room('a'), 'judge'));
  assert.ok(await until(() => beacon.text.includes('Судья на связи')), beacon.text);
  judge.ws.send('{"kind":"cmd","a":"foul","i":4,"d":1}');
  const fouls = () => messages().filter(m => m.kind === 'view').at(-1).view.seats[4].fouls;
  assert.ok(await until(() => fouls() === 1), 'команда судьи не дошла до экрана');
  assert.ok(!judge.texts().some(text => text.includes('"kind":"view"')), 'данные худа не идут судье');
});
