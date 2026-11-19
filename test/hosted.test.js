// Проверяет игру, которая хранится на сервере: судья и экраны работают без открытого пульта.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { sleep, room, tempData, startServer, connect, until, hostSend, findChrome, openPage } = require('./helpers');

const skip = findChrome() ? false : 'нужен Chrome: укажите путь в CHROME_PATH';
const SECRET = 'correct-horse';
const BAD_PASSWORD = 4401, NO_ROOM = 4403;
const PHOTO = 'data:image/jpeg;base64,' + Buffer.alloc(120000, 9).toString('base64');

const hostUrl = (server, key = SECRET) => server.url('', 'host', key);
const messages = client => client.texts().map(text => JSON.parse(text));
const lastOf = (client, kind) => messages(client).filter(m => m.kind === kind).at(-1);
const seats = client => lastOf(client, 'state')?.seats;
const view = client => lastOf(client, 'view')?.view;

// Входит в пульт и возвращает его вместе с созданной игрой.
async function openGame(t, server) {
  const host = await connect(t, hostUrl(server));
  const S = await until(() => lastOf(host, 'game')?.S);
  return { host, S, rooms: S.judge, send: hostSend(host) };
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
  assert.ok(!fs.existsSync(path.join(open.data, 'hud.sqlite')), 'база создаётся только с паролем');
  const { rooms } = await openGame(t, server);
  assert.match(rooms.room, /^[a-f0-9]{32}$/);
  assert.match(rooms.hud, /^[a-f0-9]{32}$/);
  assert.notEqual(rooms.room, rooms.hud);
});

test('судья и экраны работают без пульта, а игра переживает перезапуск сервера', async t => {
  const data = tempData(t);
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

test('ссылка на худ не даёт прав судьи, а старый вход с ролью panel закрыт', async t => {
  const server = await startServer(t, SECRET);
  const { rooms } = await openGame(t, server);
  assert.equal(await connect(t, server.url(rooms.hud, 'judge')), NO_ROOM);
  assert.equal(await connect(t, server.url(rooms.room, 'screen')), NO_ROOM);
  assert.equal(typeof await connect(t, server.url(rooms.room, 'panel', SECRET)), 'number');
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

test('пульт переключает худ между игрой и экранами победы', async t => {
  const server = await startServer(t, SECRET);
  const { host, rooms, send } = await openGame(t, server);
  const screen = await joinScreen(t, server, rooms);
  assert.equal(view(screen).scene, 'game', 'новая игра начинается со сцены игры');

  send({ kind: 'patch', seq: 1, ops: [[['scene'], 'red']] });
  assert.ok(await until(() => view(screen).scene === 'red'), 'худ не переключился на red');
  send({ kind: 'patch', seq: 2, ops: [[['scene'], 'black']] });
  assert.ok(await until(() => view(screen).scene === 'black'), 'худ не переключился на black');
  // Неизвестная сцена отклоняется целиком, последний корректный экран остаётся.
  send({ kind: 'patch', seq: 3, ops: [[['scene'], 'oops']] });
  assert.ok(await until(() => lastOf(host, 'game').ack === 3 && lastOf(host, 'game').error));
  assert.equal(view(screen).scene, 'black');
});

test('протокол дня: выставления, голоса, таймер речи, лучший ход и заметки', async t => {
  const server = await startServer(t, SECRET);
  const { rooms } = await openGame(t, server);
  const judge = await joinJudge(t, server, rooms);
  const screen = await joinScreen(t, server, rooms);
  const state = () => lastOf(judge, 'state');
  const cmd = c => judge.ws.send(JSON.stringify({ kind: 'cmd', ...c }));
  assert.deepEqual(state().days, [{ noms: [], stage: 'vote', revote: [], tied: [], out: [] }], 'игра без протокола получает пустой первый день');

  cmd({ a: 'nom', i: 3 }); cmd({ a: 'nom', i: 7 }); cmd({ a: 'nom', i: 3 }); cmd({ a: 'nom', i: 3 });
  assert.ok(await until(() => state().days[0].noms.map(n => n.i).join() === '7,3'), 'повторное выставление снимает игрока, порядок сохраняется');
  cmd({ a: 'votes', i: 7, d: 1 }); cmd({ a: 'votes', i: 7, d: 1 }); cmd({ a: 'votes', i: 3, d: -1 });
  assert.ok(await until(() => state().days[0].noms[0].v === 2 && state().days[0].noms[1].v === 0));
  assert.ok(await until(() => view(screen).noms.length === 2 && view(screen).noms[0].v === 2), 'выставленные не дошли до худа');

  cmd({ a: 'timer', op: 'speak', v: '4' });
  assert.ok(await until(() => state().timer.speaker === '4' && state().timer.running), 'речь не началась');
  assert.ok(await until(() => view(screen).timer.speaker === '4'));
  await sleep(300);
  cmd({ a: 'timer', op: 'pause' });
  assert.ok(await until(() => !state().timer.running));
  assert.ok(state().timer.remain < 60000 && state().timer.remain > 55000, 'таймер не отсчитывал время');
  cmd({ a: 'timer', op: 'set', ms: 30000 });
  assert.ok(await until(() => state().timer.total === 30000 && state().timer.remain === 30000));
  cmd({ a: 'timer', op: 'speak', v: '99' }); // несуществующее место не принимается
  cmd({ a: 'day' });
  assert.ok(await until(() => state().days.length === 2 && state().timer.speaker === ''), 'новый день не начался');
  assert.deepEqual(view(screen).noms, [], 'на худе выставленные нового дня');

  cmd({ a: 'night', k: 0, f: 'shot', v: '5' });
  cmd({ a: 'lh', k: 0, v: '1' }); cmd({ a: 'lh', k: 2, v: '8' }); cmd({ a: 'lh', k: 5, v: '2' });
  assert.ok(await until(() => state().lh.join() === '1,,8' && state().pu === '5'), 'лучший ход не записан');
  assert.deepEqual(view(screen).lh, { pu: '5', seats: ['1', '', '8'] });
  // ячейка первого убиенного в таблице судьи, как на MafiaUniverse: игрок становится первым убиенным,
  // берутся три разных существующих номера, лишние и повторы отбрасываются
  cmd({ a: 'lhset', i: 2, v: ['4', '4', '0', '99', '7', '9'] });
  assert.ok(await until(() => state().pu === '2' && state().lh.join() === '4,0,7'), 'лучший ход из ячейки не записан');
  assert.ok(await until(() => view(screen).lh.pu === '2'), 'худ не узнал первого убиенного');
  cmd({ a: 'lhset', i: 2, v: [] });
  assert.ok(await until(() => state().lh.join() === ',,' && state().pu === '5'), 'после очистки первым убиенным снова считается отстрел первой ночи');

  cmd({ a: 'score', i: 2, f: 'b', v: 0.3 }); cmd({ a: 'score', i: 2, f: 'p', v: 1.6 }); cmd({ a: 'score', i: 2, f: 'x', v: 1 }); cmd({ a: 'score', i: 4, f: 't', v: 1.234 });
  assert.ok(await until(() => state().seats[2].b === 0.3 && state().seats[4].t === 1.23), 'допы не записаны');
  assert.equal(state().seats[2].p, 0, 'больше 1,5 балла не бывает');
  cmd({ a: 'notes', v: 'Игрок 3 сорвал речь' });
  assert.ok(await until(() => state().notes === 'Игрок 3 сорвал речь'));
  cmd({ a: 'notes', v: 'x'.repeat(5000) });
  assert.ok(await until(() => state().notes.length === 2000), 'заметки не ограничены по длине');
});

test('страница судьи: баллы и лучший ход вводятся с клавиатуры', { skip }, async t => {
  const server = await startServer(t, SECRET);
  const { rooms, host } = await openGame(t, server);
  const page = await openPage(t, `${server.http}/#${rooms.room}`);
  const stored = () => lastOf(host, 'game').S;
  assert.ok(await until(() => page.run("document.querySelectorAll('.sc-in').length===30&&!document.querySelector('.sc-in').disabled"), 20000), 'страница судьи не открылась');
  const key = (sel, text) => page.run(`{const i=document.querySelector(${JSON.stringify(sel)});i.focus();i.value=${JSON.stringify(text)};i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))}`);
  await key('.sc-in[data-f="b"][data-i="0"]', '0,4');
  assert.ok(await until(() => stored().seats[0].bonus === 0.4), 'допы с клавиатуры не дошли');
  assert.equal(await page.run('document.activeElement.dataset.i+document.activeElement.dataset.f'), '1b', 'Enter переводит к следующему игроку');
  await key('.sc-in[data-f="t"][data-i="5"]', 'abc');
  assert.equal(await page.run("document.querySelector('.sc-in[data-f=\"t\"][data-i=\"5\"]').classList.contains('bad')"), true, 'неверное значение не подсвечено');
  await page.run("document.activeElement.blur()");
  await page.run("document.querySelectorAll('.lhb')[6].click()");
  assert.ok(await until(() => page.run("!!document.querySelector('.lhtype')")));
  await key('.lhtype', '3 5 10');
  assert.ok(await until(() => stored().lhPu === '6' && stored().lh.join() === '2,4,9'), 'лучший ход с клавиатуры не записан');
});

test('голосование: итог, переголосование при равенстве и вопрос «подняли/оставили»', async t => {
  const server = await startServer(t, SECRET);
  const { rooms } = await openGame(t, server);
  const judge = await joinJudge(t, server, rooms);
  const screen = await joinScreen(t, server, rooms);
  const state = () => lastOf(judge, 'state');
  const day = () => state().days.at(-1);
  const cmd = c => judge.ws.send(JSON.stringify({ kind: 'cmd', ...c }));
  const lifted = () => view(screen).noms.map(n => n.i).join();

  // день 1: явный лидер покидает стол
  cmd({ a: 'nom', i: 1 }); cmd({ a: 'nom', i: 4 });
  cmd({ a: 'vote', i: 1, v: 6 }); cmd({ a: 'vote', i: 4, v: 3 }); cmd({ a: 'vote', i: 4, v: 11 }); // 11 голосов не бывает
  assert.ok(await until(() => day().noms.map(n => n.v).join() === '6,3'));
  cmd({ a: 'voteEnd' });
  assert.ok(await until(() => day().stage === 'done' && day().out.join() === '1'), 'лидер не покинул стол');
  assert.equal(state().seats[1].st, 'voted');
  assert.ok(await until(() => lifted() === ''), 'после итога плашки опускаются');
  cmd({ a: 'nom', i: 7 }); // после итога выставлять нельзя
  cmd({ a: 'voteReset' });
  assert.ok(await until(() => day().stage === 'vote' && state().seats[1].st === 'alive'), '«Изменить» не вернул игрока');
  assert.equal(day().noms.length, 2);

  // день 2: поровну → переголосование → снова поровну → подняли
  cmd({ a: 'day' });
  cmd({ a: 'nom', i: 2 }); cmd({ a: 'nom', i: 5 }); cmd({ a: 'nom', i: 8 });
  cmd({ a: 'vote', i: 2, v: 4 }); cmd({ a: 'vote', i: 5, v: 4 }); cmd({ a: 'vote', i: 8, v: 1 });
  cmd({ a: 'voteEnd' });
  assert.ok(await until(() => day().stage === 'revote' && day().revote.map(n => n.i).join() === '2,5'), 'нет переголосования между равными');
  assert.ok(await until(() => lifted() === '2,5'), 'на худе приподняты не участники переголосования');
  cmd({ a: 'vote', i: 8, v: 9 }); // не участник переголосования
  cmd({ a: 'vote', i: 2, v: 5 }); cmd({ a: 'vote', i: 5, v: 5 });
  cmd({ a: 'voteEnd' });
  assert.ok(await until(() => day().stage === 'lift' && day().tied.join() === '2,5'), 'нет вопроса «подняли/оставили»');
  cmd({ a: 'lift', v: 'up' });
  assert.ok(await until(() => day().out.join() === '2,5' && state().seats[2].st === 'voted' && state().seats[5].st === 'voted'), '«Подняли» не убрал обоих');

  // день 3: снова поровну дважды → оставили
  cmd({ a: 'day' });
  cmd({ a: 'nom', i: 0 }); cmd({ a: 'nom', i: 9 });
  cmd({ a: 'vote', i: 0, v: 3 }); cmd({ a: 'vote', i: 9, v: 3 }); cmd({ a: 'voteEnd' });
  assert.ok(await until(() => day().stage === 'revote'));
  cmd({ a: 'vote', i: 0, v: 2 }); cmd({ a: 'vote', i: 9, v: 2 }); cmd({ a: 'voteEnd' });
  assert.ok(await until(() => day().stage === 'lift'));
  cmd({ a: 'lift', v: 'stay' });
  assert.ok(await until(() => day().stage === 'done' && day().out.length === 0), '«Оставили» должен оставить всех');
  assert.equal(state().seats[0].st, 'alive');
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
  const db = new DatabaseSync(path.join(server.data, 'hud.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM photos').get().count, 0);
    assert.equal(JSON.parse(db.prepare('SELECT state FROM game').get().state).seats.length, 10);
  } finally {
    db.close();
  }
});

test('пульт с сервера открывается заново на другом устройстве', { skip }, async t => {
  const server = await startServer(t, SECRET);
  const url = `${server.http}/panel`;
  // при полном прогоне тесты запускают несколько Chrome сразу, поэтому ожидания с запасом
  const login = async (page, key) => {
    await until(() => page.run("!!document.getElementById('login')"), 40000);
    await page.run(`document.getElementById('lKey').value=${JSON.stringify(key)};document.getElementById('login').requestSubmit()`);
  };
  const ready = page => until(() => page.run("!!document.getElementById('rows')"), 40000);

  const watcher = await openGame(t, server); // показывает, что дошло до сервера
  const stored = () => lastOf(watcher.host, 'game').S;
  const laptop = await openPage(t, url);
  await login(laptop, 'nope');
  assert.ok(await until(() => laptop.run("document.getElementById('lSt').textContent==='Неверный пароль'")), 'нет сообщения о пароле');
  await login(laptop, SECRET);
  assert.ok(await ready(laptop), 'пульт не открылся');

  await laptop.run(`const i=document.querySelector('.rn');i.value='Алиса';i.dispatchEvent(new Event('input',{bubbles:true}));
    const r=document.querySelector('#rows [data-f=role]');r.value='mafia';r.dispatchEvent(new Event('change',{bubbles:true}));`);
  assert.ok(await until(() => stored().roster[0].nick === 'Алиса' && stored().seats[0].role === 'mafia'), 'правка не дошла до сервера');
  const rooms = stored().judge;
  assert.ok(await until(() => laptop.run("document.getElementById('jLink').value.includes('/#')")), 'нет ссылки судьи');
  assert.equal(await laptop.run("document.getElementById('jLink').value"), `${server.http}/#${rooms.room}`);

  // экран в настоящей странице худа
  const obs = await openPage(t, `${server.http}/hud?room=${rooms.hud}`);
  assert.ok(await until(() => laptop.run("document.getElementById('cDisp').textContent.includes('● HUD')"), 40000), 'пульт не видит экран');

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
  assert.ok(await until(() => obs.run("document.querySelectorAll('.tile')[2]?.classList.contains('s-voted')")), 'худ не обновился без пульта');

  const phone = await openPage(t, url);
  await login(phone, SECRET);
  assert.ok(await ready(phone), 'пульт не открылся на втором устройстве');
  assert.ok(await until(() => phone.run("document.querySelector('#rows .fn').textContent==='2'")), 'игра не восстановилась');
  assert.equal(await phone.run("document.querySelector('.rn').value"), 'Алиса');
  assert.equal(await phone.run('localStorage.length + sessionStorage.length'), 0);
  assert.equal(await obs.run('localStorage.length + sessionStorage.length'), 0);
  assert.equal(await phone.run("document.querySelector('#rows [data-f=role]').value"), 'mafia');
});

// Повторяет разметку страницы «Игры» турнира на MafiaUniverse; ники выдуманные.
const muGame = (key, title, ended, nicks) => `<div class="box_game_res mx-2 my-2 " id="game_${key}">
  <div class="win_ border-0 d-flex justify-content-between"><div></div><div class=""><a class="text-white" href="/Games/Details/${key}">${title}</a></div><div class="caneditgame"></div></div>
  <div class="win_ border-0 ">Судья ${key} </div><div class="win_ border-0 "> 13-11-2026 13:56 </div>
  <table class="ended_${ended}"><tbody>${nicks.map((nick, i) => `<tr class=" "><td> ${i + 1} </td><td class="text-start"> ${nick} </td><td><div class="text-center"></div></td><td></td></tr>`).join('')}</tbody></table></div>`;
const muNicks = (prefix, first) => [first || `${prefix}1`, ...Array.from({ length: 9 }, (_, i) => `${prefix}${i + 2}`)];
const MU_PAGE = `<!doctype html><html><head><title>Результаты игр Тестовый кубок - MafiaUniverse</title></head><body><h4>Результаты игр Тестовый кубок</h4>
  ${muGame('g11', 'Тур 1 стол 1', true, muNicks('А'))}${muGame('g12', 'Тур 1 стол 2', true, muNicks('Б'))}
  ${muGame('g21', 'Тур 2 стол 1', false, muNicks('В', 'Альфа'))}${muGame('g22', 'Тур 2 стол 2', false, muNicks('Г', 'Tom &amp; Jerry'))}
  ${muGame('f11', 'Финал 1 стол 1', false, muNicks('Д'))}${muGame('f21', 'Финал 2 стол 1', false, Array(10).fill(''))}</body></html>`;

test('рассадка из MafiaUniverse: стол, номер игры и переход между играми', { skip }, async t => {
  const server = await startServer(t, SECRET);
  const watcher = await openGame(t, server);
  const stored = () => lastOf(watcher.host, 'game').S;
  const page = await openPage(t, `${server.http}/panel`);
  await until(() => page.run("!!document.getElementById('login')"), 20000);
  await page.run(`document.getElementById('lKey').value='${SECRET}';document.getElementById('login').requestSubmit()`);
  assert.ok(await until(() => page.run("!!document.getElementById('mu')"), 20000), 'пульт не открылся');
  await page.run('window.confirm=()=>true');

  const parsed = await page.run(`muParse(new DOMParser().parseFromString(${JSON.stringify(MU_PAGE)},'text/html'),'https://mafiauniverse.org/Tournaments/GamesList/777')`);
  assert.equal(parsed.id, '777');
  assert.equal(parsed.title, 'Тестовый кубок');
  assert.equal(parsed.games.length, 6);
  assert.deepEqual(parsed.games[0], { key: 'g11', title: 'Тур 1 стол 1', judge: 'Судья g11', date: '13-11-2026 13:56', ended: true, seats: muNicks('А') });
  assert.equal(parsed.games[3].seats[0], 'Tom & Jerry');
  // закладка — это код, который должен собраться
  assert.equal(await page.run("new Function(decodeURIComponent(document.getElementById('muBm').href.slice('javascript:'.length)))&&true"), true);

  // знакомый игрок с тем же ником (без учёта регистра) остаётся прежним, чтобы сохранились его фото
  await page.run("{const i=document.querySelector('.rn');i.value='альфа';i.dispatchEvent(new Event('input',{bubbles:true}))}");
  assert.ok(await until(() => stored().roster[0].nick === 'альфа'));
  const alpha = stored().roster[0].id;

  await page.run(`muTake(muClean(${JSON.stringify(parsed)}))`);
  assert.ok(await until(() => stored().mu?.games.length === 6), 'турнир не сохранился на сервере');
  assert.equal(stored().mu.table, 0, 'столов два, поэтому стол выбирают вручную');

  const pickTable = n => page.run(`{const s=document.getElementById('muTable');s.value='${n}';s.dispatchEvent(new Event('change',{bubbles:true}))}`);
  const nicks = () => { const S = stored(); return S.seats.map(s => S.roster.find(r => r.id === s.pid)?.nick || ''); };
  await pickTable(1);
  assert.ok(await until(() => stored().mu.cur === 'g21'), 'не рассажена первая несыгранная игра стола');
  assert.deepEqual(nicks(), ['альфа', ...muNicks('В').slice(1)]);
  assert.equal(stored().seats[0].pid, alpha);
  assert.equal(stored().game, 2);

  // ручная правка места остаётся возможной
  await page.run("{const s=document.querySelector('#rows [data-f=role]');s.value='don';s.dispatchEvent(new Event('change',{bubbles:true}))}");
  assert.ok(await until(() => stored().seats[0].role === 'don'));

  await page.run("document.querySelector('[data-a=muNext]').click()");
  assert.ok(await until(() => stored().mu.cur === 'f11'), 'не перешёл к следующей игре');
  assert.equal(stored().game, 3, 'финал после двух туров за столом — третья игра, без отдельной подписи');
  assert.equal(stored().seats[0].role, '', 'новая рассадка сбрасывает роли прошлой игры');
  assert.equal(await page.run("document.querySelector('#mu tr.cur td').textContent"), 'Финал 1');
  // у второго финала ещё нет рассадки: пульт остаётся на прежней игре и объясняет почему
  await page.run("document.querySelector('[data-a=muNext]').click()");
  assert.ok(await until(() => page.run("document.getElementById('mu').textContent.includes('ещё нет рассадки')")), 'нет сообщения о пустой рассадке');
  assert.equal(stored().mu.cur, 'f11');
  assert.equal(await page.run("document.querySelector('[data-a=muSeat][data-k=f21]').disabled"), true);

  await pickTable(2);
  assert.ok(await until(() => stored().mu.cur === 'g22'));
  assert.equal(nicks()[0], 'Tom & Jerry');
  assert.equal(stored().game, 2);
  // номер игры по-прежнему можно поменять вручную
  await page.run("document.querySelector('[data-a=gamePlus]').click()");
  assert.ok(await until(() => stored().game === 3));

  // страницы пульта: открывается та, что указана в адресе, остальные скрыты
  await page.run("location.hash='design'");
  assert.ok(await until(() => page.run("document.querySelector('[data-page=design]').classList.contains('on')&&getComputedStyle(document.querySelector('[data-page=game]')).display==='none'")), 'страница не переключилась');
  assert.equal(await page.run("document.querySelector('.p-tabs a.on').textContent"), 'Дизайн');
  // прозрачность выбывших — обычная настройка плашек
  await page.run("{const r=document.getElementById('u_ot');r.value='80';r.dispatchEvent(new Event('input',{bubbles:true}))}");
  assert.ok(await until(() => stored().ui.ot === 80), 'прозрачность не сохранилась');
  assert.equal(await page.run("document.getElementById('o_ot').textContent"), '80%');

  // ник на худе можно поменять: импорт узнаёт игрока по нику на MafiaUniverse и не заводит его заново
  assert.equal(stored().roster.find(r => r.id === alpha).mu, 'Альфа', 'знакомый игрок привязан к нику на MafiaUniverse');
  const v2 = stored().roster.find(r => r.nick === 'В2');
  assert.equal(v2.mu, 'В2');
  await page.run(`{const i=document.querySelector('.rn[data-id="${v2.id}"]');i.value='Виталий';i.dispatchEvent(new Event('input',{bubbles:true}))}`);
  assert.ok(await until(() => stored().roster.find(r => r.id === v2.id).nick === 'Виталий'));
  assert.equal(await page.run(`document.querySelector('.rmu[data-id="${v2.id}"]').value`), 'В2');
  const count = stored().roster.length;
  await pickTable(1);
  assert.ok(await until(() => stored().mu.cur === 'g21'));
  assert.equal(stored().seats[1].pid, v2.id);
  assert.equal(nicks()[1], 'Виталий');
  assert.equal(stored().roster.length, count, 'игрок задвоился');

  // «Удалить всех игроков» очищает список и места
  await page.run("document.querySelector('[data-a=delAll]').click()");
  assert.ok(await until(() => stored().roster.length === 0 && stored().seats.every(s => s.pid === '')), 'игроки не удалились');
  assert.equal(await page.run("document.getElementById('roster').textContent.includes('Список пуст')"), true);
});

// Повторяет форму редактирования игры на MafiaUniverse (/Games/Edit/...): только поля, которые заполняет закладка.
const muFormRow = (k, nick) => `<tr><td><input type="hidden" id="GamePlayers_${k}__Position" name="GamePlayers[${k}].Position" value="${k + 1}"></td>
  <td><input class="GamePlayers_Player_Name" value="${nick}"></td>
  <td><span class="hasfoul"></span><input type="hidden" id="GamePlayers_${k}__Foul" name="GamePlayers[${k}].Foul" value="0"></td>
  <td><input type="hidden" class="playerkilledfirst" id="GamePlayers_${k}__KilledFirst" name="GamePlayers[${k}].KilledFirst" value="False"><input style="display:none" class="bestMoveInput" id="GamePlayers_${k}__BestMove" name="GamePlayers[${k}].BestMove" value=""></td>
  <td><select id="GamePlayers_${k}__GameRoleId" name="GamePlayers[${k}].GameRoleId"><option value="1">Мирный</option><option value="2">Шериф</option><option value="3">Мафия</option><option value="4">Дон</option></select></td>
  <td><input id="GamePlayers_${k}__BonusScore" value="0,00"><input id="GamePlayers_${k}__PenaltyScore" value="0,00"><input id="GamePlayers_${k}__TechPenaltyScore" value="0,00"></td></tr>`;
const MU_FORM = `<!doctype html><form id="gameForm"><select id="GameWinnerId"><option value="0"></option><option value="1">Мирные</option><option value="2">Мафия</option><option value="3">Ничья</option></select>
  <table>${Array.from({ length: 10 }, (_, k) => muFormRow(k, k === 3 ? 'Чужой' : `Игрок ${k + 1}`)).join('')}</table><textarea id="Note">Заметка с сайта</textarea></form>`;

test('экспорт на MafiaUniverse: закладка заполняет протокол игры', { skip }, async t => {
  const server = await startServer(t, SECRET);
  const { rooms } = await openGame(t, server);
  const judge = await joinJudge(t, server, rooms);
  const cmd = c => judge.ws.send(JSON.stringify({ kind: 'cmd', ...c }));
  const page = await openPage(t, `${server.http}/panel`);
  await until(() => page.run("!!document.getElementById('login')"), 20000);
  await page.run(`document.getElementById('lKey').value='${SECRET}';document.getElementById('login').requestSubmit()`);
  assert.ok(await until(() => page.run("!!document.getElementById('muFillBm')"), 20000), 'пульт не открылся');
  assert.equal(await page.run("new Function(decodeURIComponent(document.getElementById('muFillBm').href.slice('javascript:'.length)))&&true"), true, 'закладка не собирается');

  cmd({ a: 'role', i: 1, v: 'sheriff' }); cmd({ a: 'role', i: 4, v: 'mafia' }); cmd({ a: 'role', i: 6, v: 'mafia' }); cmd({ a: 'role', i: 8, v: 'don' });
  cmd({ a: 'foul', i: 0, d: 1 }); cmd({ a: 'foul', i: 0, d: 1 }); cmd({ a: 'foul', i: 9, d: 1 });
  cmd({ a: 'night', k: 0, f: 'shot', v: '2' });
  cmd({ a: 'lhset', i: 2, v: ['4', '6', '8'] });
  cmd({ a: 'nom', i: 4 }); cmd({ a: 'nom', i: 5 }); cmd({ a: 'vote', i: 4, v: 7 }); cmd({ a: 'vote', i: 5, v: 2 }); cmd({ a: 'voteEnd' });
  cmd({ a: 'score', i: 3, f: 'b', v: 0.5 }); cmd({ a: 'score', i: 7, f: 'p', v: 1 }); cmd({ a: 'score', i: 7, f: 't', v: 0.25 });
  cmd({ a: 'notes', v: 'Игрок 6 сорвал речь' });
  assert.ok(await until(() => page.run("S.notes==='Игрок 6 сорвал речь'&&S.seats[7].tech===0.25&&(S.days[0].out||[]).join()==='4'")), 'игра не дошла до пульта');
  cmd({ a: 'winner', v: 'draw' }); cmd({ a: 'winner', v: 'nobody' });
  assert.ok(await until(() => page.run("S.winner==='draw'")), 'победа судьи не дошла до пульта');

  const r = await page.run(`(()=>{const doc=new DOMParser().parseFromString(${JSON.stringify(MU_FORM)},'text/html');
    const d=muExport(),dry=muFill(doc,d,true),g=(k,n)=>doc.getElementById('GamePlayers_'+k+'__'+n);
    muFill(doc,d,false);
    return {warn:dry.warn,roles:[...Array(10).keys()].map(k=>g(k,'GameRoleId').value).join(''),fouls:[...Array(10).keys()].map(k=>g(k,'Foul').value).join(''),
      foulText:doc.querySelector('.hasfoul').textContent,killed:[...Array(10).keys()].filter(k=>g(k,'KilledFirst').value==='True').join(),
      best:g(2,'BestMove').value,bestShown:g(2,'BestMove').style.display,scores:[3,7].map(k=>[g(k,'BonusScore').value,g(k,'PenaltyScore').value,g(k,'TechPenaltyScore').value].join('/')).join(' '),win:doc.getElementById('GameWinnerId').value,note:doc.getElementById('Note').value}})()`);
  assert.deepEqual(r.warn, ['Место 4: на сайте «Чужой», в HUD «Игрок 4»'], 'чужой игрок на месте не замечен');
  assert.equal(r.roles, '1211313141', 'роли');
  assert.equal(r.fouls, '2000000001', 'фолы');
  assert.equal(r.foulText, '2');
  assert.equal(r.killed, '2', 'первый убиенный');
  assert.equal(r.best, '5,7,9', 'лучший ход номерами через запятую');
  assert.equal(r.bestShown, '');
  assert.equal(r.scores, '0,50/0,00/0,00 0,00/1,00/0,25', 'допы, минусы и тех. минусы в формате сайта');
  assert.equal(r.win, '3', 'ничья, которую поставил судья');
  assert.match(r.note, /^Заметка с сайта\n\nИгрок 6 сорвал речь\n\nГолосования:\nДень 1: 5 \(7\), 6 \(2\) → стол покидает 5$/, 'заметка дописана к заметке с сайта');
});

test('изменения пульта без связи доходят, когда сервер вернулся', { skip }, async t => {
  const data = tempData(t);
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

  // Сервер принимает первое назначение, но его подтверждение не доходит до пульта.
  await page.run(`(()=>{
    const transmit=WebSocket.prototype.send;
    WebSocket.prototype.send=function(text){
      const message=JSON.parse(text);
      if(message.kind==='patch'){
        WebSocket.prototype.send=transmit;
        window.offlineSocket=this;
        const onMessage=this.onmessage;
        this.onmessage=event=>{
          const response=JSON.parse(event.data);
          if(!(response.kind==='game'&&response.ack===message.seq))onMessage.call(this,event);
        };
      }
      return transmit.call(this,text);
    };
    const role=document.querySelector('#rows [data-f=role]');
    role.value='sheriff';role.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  assert.ok(await until(() => lastOf(watcher, 'game').S.seats[0].role === 'sheriff'));
  await page.run('window.offlineSocket.close()');
  assert.ok(await until(() => page.run("document.getElementById('cSt').textContent==='Нет связи с сервером'")));
  await page.run(`(()=>{
    const role=document.querySelector('#rows [data-f=role]');
    role.value='';role.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  assert.ok(await until(() => lastOf(watcher, 'game').S.seats[0].role === '', 15000), 'офлайн-отмена назначения потерялась');
});

test('SQLite подхватывает прежнюю игру и фото один раз', async t => {
  const data = tempData(t);
  const photos = path.join(data, 'photos');
  const stateFile = path.join(data, 'game.json');
  const judge = { room: room('a'), hud: room('b'), key: 'старый пароль' };
  fs.mkdirSync(photos);
  fs.writeFileSync(path.join(photos, 'p0'), PHOTO);
  fs.writeFileSync(stateFile, JSON.stringify({
    title: 'До SQLite',
    judge,
    roster: [{ id: 'p0', nick: 'Алиса' }],
    seats: Array.from({ length: 10 }, (_, i) => ({ pid: i === 0 ? 'p0' : '', role: '', status: 'alive', fouls: 0 }))
  }));

  const first = await startServer(t, SECRET, data);
  const { host, S, send } = await openGame(t, first);
  assert.equal(S.title, 'До SQLite');
  assert.deepEqual(S.judge, { room: judge.room, hud: judge.hud });
  assert.ok(await until(() => messages(host).some(m => m.kind === 'photo' && m.pid === 'p0' && m.data === PHOTO)));
  send({ kind: 'photo', pid: 'p0', data: null });
  send({ kind: 'patch', seq: 1, ops: [[['title'], 'После SQLite']] });
  assert.ok(await until(() => lastOf(host, 'game').ack === 1));

  await first.stop();
  const second = await startServer(t, SECRET, data);
  const restored = await openGame(t, second);
  assert.equal(restored.S.title, 'После SQLite');
  const screen = await joinScreen(t, second, restored.rooms);
  assert.equal(view(screen).seats[0].hp, false);
  assert.ok(fs.existsSync(stateFile), 'старый файл остаётся резервной копией');
});
