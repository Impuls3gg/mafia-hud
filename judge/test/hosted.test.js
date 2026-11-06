// Проверяет игру, которая хранится на сервере: судья и экраны работают без открытого пульта.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { sleep, room, freePort, startServer, connect, until, findChrome, openPanel, openPage, devtools } = require('./helpers');

const skip = findChrome() ? false : 'нужен Chrome: укажите путь в CHROME_PATH';
const SECRET = 'correct-horse';
const BAD_PASSWORD = 4401, NO_ROOM = 4403, MOVED = 4409;
const PHOTO = 'data:image/jpeg;base64,' + Buffer.alloc(120000, 9).toString('base64');

const hostUrl = (server, key = SECRET) => `ws://localhost:${server.port}/ws?role=host&key=${key}`;
const messages = client => client.texts().map(text => JSON.parse(text));
const lastOf = (client, kind) => messages(client).filter(m => m.kind === kind).at(-1);
const seats = client => lastOf(client, 'state')?.seats;
const view = client => lastOf(client, 'view')?.view;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mafia-hud-data-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Входит в пульт и возвращает его вместе с созданной игрой.
async function openGame(t, server) {
  const host = await connect(t, hostUrl(server));
  const S = await until(() => lastOf(host, 'game')?.S);
  return { host, S, rooms: S.judge, send: message => host.ws.send(JSON.stringify(message)) };
}

async function joinJudge(t, server, rooms) {
  const judge = await connect(t, server.url(rooms.room, 'judge'));
  judge.ws.send('{"kind":"hello"}');
  assert.ok(await until(() => seats(judge)), 'судья не получил игру');
  return judge;
}

async function joinScreen(t, server, rooms) {
  const screen = await connect(t, server.url(rooms.hud, 'screen'));
  screen.ws.send(JSON.stringify({ app: 'mafiahud', from: 'test', kind: 'hello', mode: 'overlay' }));
  assert.ok(await until(() => view(screen)), 'экран не получил игру');
  return screen;
}

test('пульт на сервере доступен только с паролем', async t => {
  const open = await startServer(t);
  assert.equal((await fetch(`${open.http}/panel`)).status, 404, 'без пароля сервер не хранит игру');
  assert.equal(await connect(t, hostUrl(open, '')), BAD_PASSWORD);

  const server = await startServer(t, SECRET);
  assert.equal((await fetch(`${server.http}/panel`)).status, 200);
  assert.equal(await connect(t, hostUrl(server, '')), BAD_PASSWORD);
  assert.equal(await connect(t, hostUrl(server, 'nope')), BAD_PASSWORD);
  assert.ok(!fs.existsSync(path.join(server.data, 'game.json')), 'игра не создаётся без пароля');
  const { rooms } = await openGame(t, server);
  assert.match(rooms.room, /^[a-f0-9]{32}$/);
  assert.match(rooms.hud, /^[a-f0-9]{32}$/);
  assert.notEqual(rooms.room, rooms.hud);
});

test('судья и экраны работают без пульта, а игра переживает перезапуск сервера', async t => {
  const data = tempDir(t);
  const first = await startServer(t, SECRET, data);
  const { host, rooms, send } = await openGame(t, first);
  send({ kind: 'patch', seq: 1, ops: [[['title'], 'Кубок города'], [['roster', '0', 'nick'], 'Алиса']] });
  const pid = (await until(() => lastOf(host, 'game').ack === 1 && lastOf(host, 'game').S)).seats[0].pid;
  send({ kind: 'photo', pid, data: PHOTO });
  await sleep(100);
  host.ws.close();
  await sleep(100);

  const judge = await joinJudge(t, first, rooms);
  assert.equal(messages(judge).length && judge.got.map(JSON.parse).find(m => m.kind === 'peers').panel, 1, 'кнопки судьи активны');
  const screen = await joinScreen(t, first, rooms);
  assert.equal(view(screen).title, 'Кубок города');
  assert.ok(messages(screen).find(m => m.kind === 'photo' && m.pid === pid).data === PHOTO, 'экран не получил фото');

  judge.ws.send('{"kind":"cmd","a":"foul","i":0,"d":1}');
  assert.ok(await until(() => view(screen).seats[0].fouls === 1), 'экран не обновился');
  assert.ok(await until(() => seats(judge)[0].fouls === 1), 'судья не обновился');
  judge.ws.send('{"kind":"cmd","a":"status","i":3,"v":"voted"}');
  assert.ok(await until(() => view(screen).seats[3].status === 'voted'));

  await first.stop();
  const second = await startServer(t, SECRET, data);
  const again = await openGame(t, second);
  assert.deepEqual(again.rooms, rooms, 'ссылки не меняются');
  assert.equal(again.S.title, 'Кубок города');
  assert.equal(again.S.seats[0].fouls, 1);
  assert.equal(again.S.seats[3].status, 'voted');
  assert.ok(await until(() => messages(again.host).some(m => m.kind === 'photo' && m.data === PHOTO)), 'фото не сохранилось');
});

test('ссылка на худ не даёт прав судьи, а старый пульт уходит на сервер', async t => {
  const server = await startServer(t, SECRET);
  const { rooms } = await openGame(t, server);
  assert.equal(await connect(t, server.url(rooms.hud, 'judge')), NO_ROOM);
  assert.equal(await connect(t, server.url(rooms.room, 'screen')), NO_ROOM);
  assert.equal(await connect(t, server.url(rooms.room, 'panel', 'nope')), BAD_PASSWORD);
  assert.equal(await connect(t, server.url(rooms.room, 'panel', SECRET)), MOVED);
  assert.equal(await connect(t, server.url(rooms.hud, 'panel', SECRET)), MOVED);
});

test('правки пульта и судьи не затирают друг друга, а новая ссылка отключает старую', async t => {
  const server = await startServer(t, SECRET);
  const { host, rooms, send } = await openGame(t, server);
  const judge = await joinJudge(t, server, rooms);
  const peers = () => lastOf(host, 'peers')?.judge;
  assert.ok(await until(() => peers() === 1), 'пульт не видит судью');
  const visitor = await connect(t, server.url(rooms.room, 'judge'));
  assert.ok(await until(() => peers() === 2));
  visitor.ws.close();
  assert.ok(await until(() => peers() === 1), 'пульт не заметил ухода судьи');
  judge.ws.send('{"kind":"cmd","a":"foul","i":1,"d":1}');
  send({ kind: 'patch', seq: 1, ops: [[['title'], 'Финал']] });
  assert.ok(await until(() => lastOf(host, 'game').ack === 1 && lastOf(host, 'game').S.seats[1].fouls === 1));
  assert.equal(lastOf(host, 'game').S.title, 'Финал');

  const room2 = 'c'.repeat(32);
  const closed = new Promise(resolve => { judge.ws.onclose = e => resolve(e.code); });
  send({ kind: 'patch', seq: 2, ops: [[['judge', 'room'], room2]] });
  assert.equal(await closed, NO_ROOM);
  assert.ok(await until(() => peers() === 0), 'последний судья ушёл, а пульт этого не видит');
  assert.equal(await connect(t, server.url(rooms.room, 'judge')), NO_ROOM);
  assert.ok((await connect(t, server.url(room2, 'judge'))).ws);
});

test('неверные сообщения не ломают сервер и игру', async t => {
  const server = await startServer(t, SECRET);
  const { host, rooms, send } = await openGame(t, server);
  const judge = await joinJudge(t, server, rooms);
  for (const bad of ['not json', 'null', '{"kind":"cmd","a":"__proto__","i":0}', '{"kind":"cmd","a":"constructor","i":0}',
    '{"kind":"cmd","a":"role","i":0,"v":"constructor"}', '{"kind":"cmd","a":"night","k":"__proto__","f":"shot","v":"1"}',
    '{"kind":"cmd","a":"night","k":0,"f":"shot","v":{"toString":1}}']) judge.ws.send(bad);
  send({ kind: 'photo', pid: '../../evil', data: PHOTO });
  send({ kind: 'photo', pid: 'p0', data: 'javascript:alert(1)' });
  send({ kind: 'patch', seq: 1, ops: [[['__proto__', 'x'], 1], [['constructor', 'prototype', 'x'], 1], 'bad', [['nope', 'deep', 'x'], 1]] });
  send({ kind: 'import', S: { seats: 'bad' } });
  host.ws.send('not json');
  judge.ws.send('{"kind":"cmd","a":"foul","i":2,"d":1}');
  assert.ok(await until(() => seats(judge)[2].fouls === 1), 'сервер перестал отвечать');
  assert.equal(seats(judge)[0].role, '');
  assert.deepEqual(fs.readdirSync(path.join(server.data, 'photos')), []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(server.data, 'game.json'), 'utf8')).seats.length, 10);
});

test('пульт с сервера открывается заново на другом устройстве', { skip }, async t => {
  const server = await startServer(t, SECRET);
  const url = `${server.http}/panel`;
  const login = async (page, key) => {
    await until(() => page.run("!!document.getElementById('login')"), 20000);
    await page.run(`document.getElementById('lKey').value=${JSON.stringify(key)};document.getElementById('login').requestSubmit()`);
  };
  const ready = page => until(() => page.run("!!document.getElementById('rows')"), 20000);

  const watcher = await openGame(t, server); // показывает, что дошло до сервера
  const stored = () => lastOf(watcher.host, 'game').S;
  const laptop = await openPage(t, url);
  await login(laptop, 'nope');
  assert.ok(await until(() => laptop.run("document.getElementById('lSt').textContent==='Неверный пароль'")), 'нет сообщения о пароле');
  await login(laptop, SECRET);
  assert.ok(await ready(laptop), 'пульт не открылся');
  assert.equal(await laptop.run("getComputedStyle(document.getElementById('jUrl')).display==='none'||getComputedStyle(document.getElementById('jUrl').parentElement).display"), 'none');

  await laptop.run(`const i=document.querySelector('.rn');i.value='Алиса';i.dispatchEvent(new Event('input',{bubbles:true}));
    const r=document.querySelector('#rows [data-f=role]');r.value='mafia';r.dispatchEvent(new Event('change',{bubbles:true}));`);
  assert.ok(await until(() => stored().roster[0].nick === 'Алиса' && stored().seats[0].role === 'mafia'), 'правка не дошла до сервера');
  const rooms = stored().judge;
  assert.ok(await until(() => laptop.run("document.getElementById('jLink').value.includes('/#')")), 'нет ссылки судьи');
  assert.equal(await laptop.run("document.getElementById('jLink').value"), `${server.http}/#${rooms.room}`);

  // экран в настоящей странице худа
  const obs = await openPage(t, `${server.http}/hud?room=${rooms.hud}`);
  assert.ok(await until(() => laptop.run("document.getElementById('cDisp').textContent.includes('● HUD')"), 20000), 'пульт не видит экран');

  const judge = await joinJudge(t, server, rooms);
  judge.ws.send('{"kind":"cmd","a":"foul","i":0,"d":1}');
  assert.ok(await until(() => laptop.run("document.querySelector('#rows .fn').textContent==='1'")), 'пульт не показал правку судьи');
  await laptop.run("document.getElementById('fTitle').blur()");
  await until(() => laptop.run("document.getElementById('jSt').textContent==='Судья на связи'"));

  await laptop.close(); // ноутбук выключили
  await sleep(300);
  judge.ws.send('{"kind":"cmd","a":"foul","i":0,"d":1}');
  judge.ws.send('{"kind":"cmd","a":"status","i":2,"v":"voted"}');
  assert.ok(await until(() => seats(judge)[0].fouls === 2 && seats(judge)[2].st === 'voted'), 'судья не работает без пульта');
  assert.ok(await until(() => obs.run("JSON.parse(localStorage.getItem('mafiaHudView.v5')).seats[2].status==='voted'")), 'худ не обновился без пульта');

  const phone = await openPage(t, url);
  await login(phone, SECRET);
  assert.ok(await ready(phone), 'пульт не открылся на втором устройстве');
  assert.ok(await until(() => phone.run("document.querySelector('#rows .fn').textContent==='2'")), 'игра не восстановилась');
  assert.equal(await phone.run("document.querySelector('.rn').value"), 'Алиса');
  assert.equal(await phone.run("document.querySelector('#rows [data-f=role]').value"), 'mafia');
});

test('изменения пульта без связи доходят, когда сервер вернулся', { skip }, async t => {
  const data = tempDir(t);
  const first = await startServer(t, SECRET, data);
  const { host } = await openGame(t, first);
  host.ws.close();
  const page = await openPage(t, `${first.http}/panel`);
  await until(() => page.run("!!document.getElementById('login')"), 20000);
  await page.run(`document.getElementById('lKey').value='${SECRET}';document.getElementById('login').requestSubmit()`);
  assert.ok(await until(() => page.run("!!document.getElementById('fTitle')"), 20000));

  // тот же адрес нужен странице после перезапуска, поэтому сервер поднимается на прежнем порту
  await first.stop();
  assert.ok(await until(() => page.run("document.getElementById('cSt').textContent==='Нет связи с сервером'")));
  await page.run("const f=document.getElementById('fTitle');f.value='Без связи';f.dispatchEvent(new Event('input',{bubbles:true}));");
  const second = await startServer(t, SECRET, data, first.port);
  const { host: watcher } = await openGame(t, second);
  assert.ok(await until(() => lastOf(watcher, 'game').S.title === 'Без связи', 15000), 'правка потерялась');
});

test('пульт из файла переносит игру на сервер, а ссылки остаются прежними', { skip }, async t => {
  const server = await startServer(t, SECRET);
  const nicks = ['Алиса', 'Борис', 'Вера', 'Глеб', 'Дарья', 'Егор', 'Жанна', 'Захар', 'Ирина', 'Кирилл'];
  const state = {
    v: 1, title: 'Кубок города', game: 3, accent: '#1c7ed6', showFouls: true, photoVer: 0,
    judge: { url: server.http, room: room('a'), hud: room('f'), key: SECRET },
    roster: nicks.map((nick, i) => ({ id: 'p' + i, nick })),
    seats: nicks.map((_, i) => ({ pid: 'p' + i, role: i ? '' : 'mafia', status: 'alive', fouls: 0 })),
    nights: [{ shot: '', check: '', don: '' }],
    wait: { show: false, running: false, endAt: 0, left: 1, total: 1 }
  };
  const debugPort = await freePort();
  openPanel(t, state, { photos: { p0: PHOTO, 'p0.mafia': PHOTO + 'AA' }, debugPort });
  const panel = await devtools(debugPort);

  const screen = await until(async () => {
    const client = await connect(t, server.url(room('f'), 'screen'));
    return client.ws ? client : null;
  }, 20000);
  const judge = await until(async () => {
    const client = await connect(t, server.url(room('a'), 'judge'));
    return client.ws ? client : null;
  });
  await until(() => panel.run("document.getElementById('jSt').textContent==='Судья на связи'"));

  await panel.run("window.confirm=()=>true;document.querySelector('[data-a=jMove]').click()");
  assert.ok(await until(() => panel.run("document.getElementById('jSt').textContent.startsWith('Игра перенесена')")), 'игра не перенеслась');
  await sleep(200);
  assert.equal(screen.ws.readyState, WebSocket.OPEN, 'экран остаётся на своей ссылке');
  assert.equal(judge.ws.readyState, WebSocket.OPEN, 'судья остаётся на своей ссылке');

  judge.ws.send('{"kind":"cmd","a":"foul","i":4,"d":1}');
  assert.ok(await until(() => view(screen)?.seats[4].fouls === 1), 'экран не получает игру от сервера');
  assert.equal(view(screen).title, 'Кубок города');
  assert.ok(await until(() => messages(screen).some(m => m.kind === 'photo' && m.pid === 'p0.mafia' && m.data === PHOTO + 'AA')), 'фото роли не перенеслось');
  assert.ok(await until(() => panel.run("document.getElementById('jSt').textContent.startsWith('Игра перенесена')")), 'пульт снова подключился');

  const { host, S } = await openGame(t, server);
  assert.equal(S.judge.room, room('a'));
  assert.equal(S.judge.hud, room('f'));
  assert.equal(S.judge.key, '', 'пароль не хранится в игре');
  assert.ok(await until(() => messages(host).filter(m => m.kind === 'photo').length === 2), 'пульт получает не все фото');
});
