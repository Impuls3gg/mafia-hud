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
  assert.ok(await until(() => state().days[0].noms[0].v === 2 && state().days[0].noms[1].v === 8));
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
  cmd({ a: 'voteEnd' });
  assert.ok(await until(() => state().days.length === 2 && state().timer.speaker === ''), 'новый день не начался');
  assert.deepEqual(view(screen).noms, [], 'на худе выставленные нового дня');

  cmd({ a: 'night', k: 0, f: 'shot', v: '5' });
  cmd({ a: 'lh', k: 0, v: '1' }); cmd({ a: 'lh', k: 2, v: '8' }); cmd({ a: 'lh', k: 5, v: '2' });
  assert.ok(await until(() => state().lh.join() === '1,,8' && state().pu === '5'), 'лучший ход не записан');
  assert.deepEqual(view(screen).lh, { pu: '5', seats: ['1', '', '8'] });
  // Обе записи доступны судье и HUD.
  cmd({ a: 'lhset', i: 2, v: ['4', '4', '0', '99', '7', '9'] });
  assert.ok(await until(() => state().lhExtra?.seats.join() === '4,0,7'), 'второй лучший ход не записан');
  assert.equal(state().lhExtra.pu, '2');
  assert.deepEqual(view(screen).lh, { pu: '5', seats: ['1', '', '8'] });
  assert.ok(await until(() => view(screen).lhExtra?.pu === '2'));
  assert.deepEqual(view(screen).lhExtra.seats, ['4', '0', '7']);
  cmd({ a: 'lhset', i: 2, v: [] });
  assert.ok(await until(() => state().lhExtra === null && state().lh.join() === '1,,8'));
  cmd({ a: 'lhset', i: 5, v: [] });
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
  await key('.lhtype', '3510');
  assert.ok(await until(() => stored().lhPu === '6' && stored().lh.join() === '2,4,9'), 'лучший ход с клавиатуры не записан');
  await page.run("document.querySelectorAll('.lhb')[7].click()");
  await page.run(`(()=>{
    const input=document.querySelector('.lhtype');
    input.value='2 4 6';input.dispatchEvent(new Event('input',{bubbles:true}));
    input.form.requestSubmit();
  })()`);
  assert.ok(await until(() => stored().lhExtra?.pu === '7'));
  assert.ok(await until(() => page.run("document.querySelectorAll('.lhb.set').length===2")));
  assert.deepEqual(await page.run("[...document.querySelectorAll('.lhb.set')].map(b=>b.textContent)"), ['3 5 10', '2 4 6']);
  await page.run(`(()=>{
    const f=document.createElement('iframe');f.id='lh-hud';f.src=${JSON.stringify('/hud#' + rooms.hud)};document.body.append(f);
  })()`);
  assert.ok(await until(() => page.run("document.getElementById('lh-hud')?.contentDocument?.querySelectorAll('.lhp.on').length===2")));
  assert.deepEqual(await page.run(`[...document.getElementById('lh-hud').contentDocument.querySelectorAll('.tile')]
    .flatMap((tile,i)=>{const lh=tile.querySelector('.lhp.on');return lh?[[i+1,[...lh.querySelectorAll('.chip')].map(chip=>chip.textContent)]]:[]})`),
  [[7, ['3', '5', '10']], [8, ['2', '4', '6']]]);
});

test('на телефоне кнопки речи стоят справа от ника, по истечении времени судья и HUD завершают речь', { skip }, async t => {
  const server = await startServer(t, SECRET);
  const { rooms, host, send } = await openGame(t, server);
  const page = await openPage(t, `${server.http}/#${rooms.room}`);
  assert.ok(await until(() => page.run("!!document.querySelector('.player')"), 20000));
  await page.run("const f=document.createElement('iframe');f.id='phone';f.style.width='360px';f.height='760';f.src=location.href;document.body.append(f)");
  const doc = "(document.getElementById('phone')?.contentDocument)";
  const row = doc + "?.querySelector('.player')";
  const stored = () => lastOf(host, 'game').S;
  assert.ok(await until(() => page.run(`!!${row} && !${row}.querySelector('.speech-actions button').disabled`), 20000));
  assert.equal(await page.run(`(()=>{
    const row=${row},nick=row.querySelector('.nick').getBoundingClientRect(),
      controls=row.querySelector('.speech-actions').getBoundingClientRect();
    return controls.left>=nick.right-1 && Math.abs(controls.top+controls.height/2-nick.top-nick.height/2)<2
      && controls.right<=${doc}.documentElement.clientWidth;
  })()`), true);
  assert.deepEqual(await page.run(`[...${doc}.querySelectorAll('#nights .act span')].map(el=>el.textContent)`), ['Отстрел', 'Дон', 'Шериф']);
  assert.deepEqual(await page.run(`[...${row}.querySelectorAll('.foul-cell .fo button')].map(b=>b.textContent)`), ['+', '−']);

  await page.run(`${row}.querySelector('.nick').click()`);
  assert.deepEqual(await page.run(`[...${doc}.querySelectorAll('.acts button')].map(b=>b.textContent)`), ['Убит', 'Заголосован', 'Удалён']);
  await page.run(`(()=>{
    const f=document.createElement('iframe');f.id='overlay';f.src=${JSON.stringify('/hud#' + rooms.hud)};document.body.append(f);
  })()`);
  const overlay = "document.getElementById('overlay')?.contentDocument";
  assert.ok(await until(() => page.run(`!!${overlay}?.querySelector('.tile .nick span')?.firstChild`)));
  await page.run(`window.tableRow=${row};window.hudNick=${overlay}.querySelector('.tile .nick span').firstChild`);

  await page.run(`${row}.querySelectorAll('.speech-actions button')[1].click()`);
  assert.ok(await until(() => stored().timer.running && stored().timer.total === 30000 && stored().timer.speaker === '0'));
  await page.run(`${doc}.querySelectorAll('.player')[1].querySelector('.speech-actions button').click()`);
  assert.ok(await until(() => page.run(`${overlay}.querySelector('.spk .sw').textContent.startsWith('2 ·')
    && ${doc}.querySelectorAll('.player')[1].classList.contains('speak')`)));
  await page.run(`${row}.querySelectorAll('.speech-actions button')[1].click()`);
  await page.run(`${row}.querySelectorAll('.speech-actions button')[2].click()`);
  assert.ok(await until(() => stored().seats[0].fouls === 2 && stored().timer.endAt - Date.now() > 30000));
  assert.ok(await until(() => page.run(`${row}.querySelectorAll('.speech-actions button')[2].disabled`)));
  assert.ok(await until(() => page.run(`${overlay}.querySelector('.tile.speak .fc')?.textContent==='2'`)));
  assert.equal(await page.run(`window.tableRow===${row} && window.hudNick===${overlay}.querySelector('.tile .nick span').firstChild`), true);

  send({ kind: 'patch', seq: 1, ops: [[['timer', 'endAt'], Date.now() + 1000]] });
  assert.ok(await until(() => stored().timer.left === 0 && stored().timer.speaker === '' && !stored().timer.running));
  assert.ok(await until(() => page.run(`(()=>{
    const judge=${doc},hud=${overlay};
    const clock=judge.getElementById('clock');
    return clock.textContent==='0:00' && clock.getClientRects().length>0 && !judge.querySelector('.player.speak')
      && !judge.querySelector('.speech-actions .on') && !hud.querySelector('.spk.on') && !hud.querySelector('.tile.speak');
  })()`)));

  await page.run(`${row}.querySelector('.speech-actions button').click()`);
  assert.ok(await until(() => stored().timer.running && stored().timer.speaker === '0' && stored().timer.total === 60000));
  assert.ok(await until(() => page.run(`!${doc}.querySelector('.timer.finished') && !!${overlay}.querySelector('.spk.on')`)));
  assert.equal(await page.run(`${doc}.getElementById('tReset').previousElementSibling.id`), 'tPlay');
  assert.equal(await page.run(`${doc}.getElementById('tPlay').getAttribute('aria-label')`), 'Остановить и обнулить таймер');
  await page.run(`${doc}.getElementById('tPlay').click()`);
  assert.ok(await until(() => !stored().timer.running && stored().timer.speaker === '' && stored().timer.left === 0));
  assert.ok(await until(() => page.run(`(()=>{
    const clock=${doc}.getElementById('clock');
    return clock.textContent==='0:00' && clock.getClientRects().length>0
      && !${overlay}.querySelector('.spk.on, .tile.speak');
  })()`)));
  assert.equal(await page.run(`(()=>{
    const judge=${doc};
    judge.getElementById('tReset').click();
    return judge.getElementById('clock').textContent;
  })()`), '1:00');
  assert.ok(await until(() => stored().timer.running && stored().timer.speaker === '0' && stored().timer.total === 60000));
  assert.ok(await until(() => page.run(`!!${overlay}.querySelector('.spk.on, .tile.speak')`)));
});

test('запоздавшее обновление не возвращает секунды на таймере судьи и HUD', { skip }, async t => {
  const server = await startServer(t, SECRET);
  const { rooms } = await openGame(t, server);
  const screen = await joinScreen(t, server, rooms);
  const page = await openPage(t, `${server.http}/#${rooms.room}`);
  assert.ok(await until(() => page.run("!!document.querySelector('.player')"), 20000));
  await page.run(`(() => {
    const frame=document.createElement('iframe');
    frame.id='timer-hud'; frame.src=${JSON.stringify('/hud#' + rooms.hud)}; document.body.append(frame);
  })()`);
  const overlay = "document.getElementById('timer-hud')";
  const hudClock = `${overlay}.contentDocument?.querySelector('.spk .clk')`;
  assert.ok(await until(() => page.run(`!!${hudClock}`), 20000));
  await page.run("document.querySelector('.speech-actions button').click()");
  assert.ok(await until(() => view(screen).timer.running));
  assert.ok(await until(() => page.run("last.timer.running")));
  const previousJudge = await page.run('JSON.stringify(last)');
  const previousView = view(screen);
  assert.equal(JSON.parse(previousJudge).timer.endAt, previousView.timer.endAt);

  assert.ok(await until(() => page.run(`(() => {
    const clocks=[clock.textContent,${hudClock}.textContent];
    return clocks.every(text => /^0:5[0-8]$/.test(text));
  })()`)));
  const samples = await page.run(`(() => {
    const times=()=>[clock.textContent,${hudClock}.textContent]
      .map(text=>text.split(':').reduce((total,value)=>total*60+Number(value),0));
    const before=times();
    ws.onmessage({data:${JSON.stringify(previousJudge)}});
    ${overlay}.contentWindow.applyView(${JSON.stringify(previousView)});
    return {before,after:times()};
  })()`);
  assert.ok(samples.after.every((seconds, index) => seconds <= samples.before[index]), JSON.stringify(samples));
});

test('при задержке судья начинает с 1:00, а HUD показывает актуальное время', { skip }, async t => {
  const server = await startServer(t, SECRET);
  const { rooms } = await openGame(t, server);
  const screen = await joinScreen(t, server, rooms);
  const page = await openPage(t, `${server.http}/#${rooms.room}`);
  assert.ok(await until(() => page.run("!!document.querySelector('.player')"), 20000));
  await page.run(`(() => {
    const frame=document.createElement('iframe');
    frame.id='timer-frame'; frame.src=${JSON.stringify('/hud#' + rooms.hud)}; document.body.append(frame);
  })()`);
  assert.ok(await until(() => page.run("!!document.getElementById('timer-frame').contentDocument?.querySelector('.spk')")));
  const first = await page.run(`(async () => {
    const hud=document.getElementById('timer-frame');
    hud.contentWindow.applyView(${JSON.stringify(view(screen))});
    const transmit=ws.send.bind(ws);
    ws.send=data=>{
      if(JSON.parse(data).op==='speak')setTimeout(()=>transmit(data),1300);
      else transmit(data);
    };
    const box=hud.contentDocument.querySelector('.spk');
    const firstHud=new Promise(resolve=>{
      const watch=new MutationObserver(()=>{
        if(box.classList.contains('on')){
          watch.disconnect();
          resolve(box.querySelector('.clk').textContent);
        }
      });
      watch.observe(box,{attributes:true,attributeFilter:['class']});
    });
    const firstJudge=new Promise(resolve=>requestAnimationFrame(()=>{
      const end=performance.now()+1150;
      while(performance.now()<end){}
      tick();
      resolve(clock.textContent);
    }));
    document.querySelector('.speech-actions button').click();
    return Promise.all([firstJudge,firstHud]);
  })()`);
  assert.equal(first[0], '1:00');
  assert.match(first[1], /^0:5[89]$/);
  assert.ok(await until(() => page.run(`(() => {
    const hud=document.getElementById('timer-frame').contentDocument;
    return clock.textContent!=='1:00'&&hud.querySelector('.spk .clk').textContent!=='1:00';
  })()`)));
});

test('таймеры на 60, 30 и 20 секунд показывают полное время сразу, даже если команда задержалась', { skip }, async t => {
  const server = await startServer(t, SECRET);
  const { rooms } = await openGame(t, server);
  const screen = await joinScreen(t, server, rooms);
  const page = await openPage(t, `${server.http}/#${rooms.room}`);
  assert.ok(await until(() => page.run("!!document.querySelector('.player')"), 20000));
  await page.run(`(() => {
    const transmit=ws.send.bind(ws), receive=ws.onmessage;
    ws.send=data=>{
      const message=JSON.parse(data);
      if(message.op!=='countdown'&&message.op!=='speak')return transmit(data);
      window.timerStart=message.startedAt;
      setTimeout(()=>transmit(data),2200);
    };
    ws.onmessage=event=>{
      const kind=JSON.parse(event.data).kind;
      if(kind!=='countdownAck'&&kind!=='speechAck')return receive(event);
      const before=clock.textContent;
      receive(event);
      window.timerConfirmation={before,after:clock.textContent,pending:!!pendingStart};
    };
  })()`);
  const seconds = text => text.split(':').reduce((total, value) => total * 60 + +value, 0);
  for (const [selector, duration, speaker] of [
    ['.speech-actions button', 60000, '0'],
    ['.speech-actions button:nth-child(2)', 30000, '0'],
    ['[data-countdown="20000"]', 20000, ''],
  ]) {
    const started = await page.run(`(() => {
      window.timerConfirmation=null;
      document.querySelector(${JSON.stringify(selector)}).click();
      return {clock:clock.textContent,startedAt:window.timerStart};
    })()`);
    assert.equal(seconds(started.clock), duration / 1000);
    assert.ok(Number.isSafeInteger(started.startedAt));
    assert.ok(await until(() => view(screen).timer.running && view(screen).timer.total === duration));
    const timer = view(screen).timer;
    assert.equal(timer.speaker, speaker);
    assert.ok(timer.sentAt - started.startedAt >= 2000);
    assert.equal(timer.endAt, started.startedAt + duration);
    const confirmation = await until(() => page.run('window.timerConfirmation'));
    assert.equal(confirmation.pending, false);
    assert.ok(seconds(confirmation.before) <= duration / 1000 - 2, JSON.stringify(confirmation));
    const change = seconds(confirmation.before) - seconds(confirmation.after);
    assert.ok(change >= 0 && change <= 1, JSON.stringify(confirmation));
  }
});

test('судья запускает короткий отсчёт, начисляет и снимает технические фолы с телефона', { skip }, async t => {
  const server = await startServer(t, SECRET);
  const { rooms, send } = await openGame(t, server);
  const screen = await joinScreen(t, server, rooms);
  const page = await openPage(t, `${server.http}/#${rooms.room}`);
  assert.ok(await until(() => page.run("!!document.querySelector('.player')"), 20000));
  await page.run("const f=document.createElement('iframe');f.id='phone';f.style.width='360px';f.src=location.href;document.body.append(f)");
  const doc = "document.getElementById('phone').contentDocument";
  const controls = `${doc}?.querySelector('.score-tech .tech-controls')`;
  assert.ok(await until(() => page.run(`!!${controls} && !${controls}.querySelector('button').disabled`), 20000));
  await page.run(`(() => {
    const frame=document.createElement('iframe');
    frame.id='countdown-hud'; frame.src=${JSON.stringify('/hud#' + rooms.hud)}; document.body.append(frame);
  })()`);
  const overlay = "document.getElementById('countdown-hud').contentDocument";
  assert.ok(await until(() => page.run(`!!${overlay}?.querySelector('.spk')`)));
  await page.run(`${doc}.querySelector('.speech-actions button').click()`);
  assert.ok(await until(() => page.run(`!!${overlay}.querySelector('.spk.on')`)));
  assert.equal(await page.run(`${doc}.getElementById('notes').nextElementSibling.textContent`), 'Результат игры');
  assert.equal(await page.run(`${doc}.querySelector('main').lastElementChild.id`), 'winner');
  assert.deepEqual(await page.run(`[...${doc}.querySelectorAll('#tReset ~ button')].map(b=>b.textContent)`), ['10 с', '20 с']);
  for (const ms of [10000, 20000]) {
    await page.run(`${doc}.querySelector('[data-countdown="${ms}"]').click()`);
    assert.ok(await until(() => view(screen)?.timer.total === ms && view(screen)?.timer.running));
    assert.equal(view(screen).timer.speaker, '');
    assert.ok(await until(() => page.run(`${doc}.getElementById('who').textContent==='Общий отсчёт'`)));
    assert.ok(await until(() => page.run(`!${overlay}.querySelector('.spk.on, .tile.speak')`)));
  }
  await page.run(`${doc}.getElementById('tPlay').click()`);
  assert.ok(await until(() => !view(screen).timer.running && view(screen).timer.remain === 0));
  assert.equal(await page.run(`(()=>{
    const judge=${doc};
    judge.getElementById('tReset').click();
    return judge.getElementById('clock').textContent;
  })()`), '0:20');
  assert.ok(await until(() => view(screen).timer.running && view(screen).timer.total === 20000 && view(screen).timer.speaker === ''));
  assert.equal(await page.run(`!${overlay}.querySelector('.spk.on, .tile.speak')`), true);
  send({ kind: 'patch', seq: 1, ops: [[['timer', 'endAt'], Date.now() + 200]] });
  assert.ok(await until(() => !view(screen).timer.running && view(screen).timer.remain === 0));
  assert.ok(await until(() => page.run(`${doc}.getElementById('clock').textContent==='0:00'`)));

  await page.run(`${doc}.querySelector('[data-mode="scores"]').click()`);
  assert.equal(await page.run(`[...${controls}.querySelectorAll('button')].every(b=>b.offsetWidth>0&&b.getBoundingClientRect().right<=${doc}.documentElement.clientWidth)`), true);
  assert.deepEqual(await page.run(`[...${controls}.querySelectorAll('button')].map(b=>[b.textContent,b.disabled])`),
    [['+', false], ['−', true], ['+', false], ['−', true]]);
  await page.run(`${controls}.querySelectorAll('.p')[0].click()`);
  assert.ok(await until(() => page.run(`${controls}.querySelector('output')?.textContent==='−0,30'`)));
  assert.equal(view(screen).seats[0].status, 'alive');
  await page.run(`${controls}.querySelectorAll('.p')[1].click()`);
  assert.ok(await until(() => page.run(`${controls}.querySelector('output')?.textContent==='−1,50' && [...${controls}.querySelectorAll('.p')].every(b=>b.disabled)`)));
  assert.ok(await until(() => view(screen).seats[0].status === 'removed'));
  await page.run(`${controls}.querySelectorAll('.m')[0].click()`);
  assert.ok(await until(() => page.run(`${controls}.querySelector('output')?.textContent==='−0,60'`)));
  assert.ok(await until(() => view(screen).seats[0].status === 'alive'));
  await page.run(`${controls}.querySelectorAll('.m')[1].click()`);
  assert.ok(await until(() => page.run(`${controls}.querySelector('input')?.value==='' && [...${controls}.querySelectorAll('.m')].every(b=>b.disabled)`)));
});

test('экран судьи раскладывает протоколы по ширине и позволяет записать мнение живого игрока', { skip }, async t => {
  const server = await startServer(t, SECRET);
  const { rooms, host } = await openGame(t, server);
  const page = await openPage(t, `${server.http}/#${rooms.room}`);
  assert.ok(await until(() => page.run("!!document.querySelector('.player')"), 20000));
  await page.run(`(()=>{
    for(const [id,width] of [['wide',1280],['narrow',360]]){
      const f=document.createElement('iframe');f.id=id;f.width=width;f.height=760;f.src=location.href;document.body.append(f);
    }
  })()`);
  const wide = "(document.getElementById('wide')?.contentDocument)";
  const narrow = "(document.getElementById('narrow')?.contentDocument)";
  for (const doc of [wide, narrow]) {
    assert.ok(await until(() => page.run(`!!${doc}?.querySelector('.player') && !${doc}.getElementById('reportOwner').disabled`), 20000));
  }
  assert.equal(await page.run(`(()=>{
    const doc=${wide},night=doc.getElementById('nightPanel'),reports=doc.getElementById('reportPanel');
    const table=doc.querySelector('.pr').getBoundingClientRect();
    return night.open && reports.open && night.getBoundingClientRect().right<=table.left
      && reports.getBoundingClientRect().left>=table.right;
  })()`), true);
  assert.equal(await page.run(`${narrow}.getElementById('nightPanel').open || ${narrow}.getElementById('reportPanel').open`), false);
  assert.deepEqual(await page.run(`[...${wide}.querySelectorAll('#reportTable th')].map(th=>th.textContent)`),
    ['Игрок', 'Красные', 'Чёрные', 'Шериф']);
  const sheriffCheck = `${wide}.querySelector('#nights select[aria-label="Шериф, ночь 1"]')`;
  await page.run(`const check=${sheriffCheck};check.value='1';check.dispatchEvent(new Event('change'))`);
  assert.ok(await until(() => page.run(`${sheriffCheck}.nextElementSibling.textContent==='красный'`)));
  await page.run(`const role=${wide}.querySelectorAll('.player .rcell select')[1];
    role.value='don';role.dispatchEvent(new Event('change'))`);
  assert.ok(await until(() => page.run(`${sheriffCheck}.nextElementSibling.textContent==='чёрный'
    && ${sheriffCheck}.nextElementSibling.classList.contains('black')`)));
  await page.run(`${narrow}.querySelector('#reportPanel summary').click();
    const owner=${narrow}.getElementById('reportOwner');
    owner.value='3';owner.dispatchEvent(new Event('change')); ${narrow}.getElementById('reportAdd').click()`);
  const stored = () => lastOf(host, 'game').S;
  assert.ok(await until(() => stored().deathReports.some(report => report.i === '3' && report.manual)));
  assert.equal(stored().seats[3].status, 'alive');
  const click = (doc, id) => page.run(`${doc}.querySelector('[data-report-control="${id}"]').click()`);
  assert.ok(await until(() => page.run(`!!${narrow}.querySelector('[data-report-control="input-3-red"]')
    && !!${wide}.querySelector('#reportRows .report-cell')`)));
  assert.deepEqual(await page.run(`[...${wide}.querySelectorAll('#reportRows tr:first-child .report-cell')]
    .map(cell=>cell.dataset.reportControl)`), ['cell-3-red', 'cell-3-black', 'cell-3-sheriff']);
  await click(narrow, 'cell-3-black');
  assert.ok(await until(() => page.run(`!!${narrow}.querySelector('[data-report-control="pick-3-black-1"]')`)));
  await click(narrow, 'pick-3-black-1');
  await click(narrow, 'pick-3-black-8');
  await click(narrow, 'cell-3-sheriff');
  await click(narrow, 'pick-3-sheriff-4');
  assert.ok(await until(() => page.run(`
    ${wide}.querySelector('[data-report-control="cell-3-black"]')?.textContent==='2, 9'
      && ${wide}.querySelector('[data-report-control="cell-3-sheriff"]')?.textContent==='5'`)));

  await click(narrow, 'cell-3-red');
  const enter = (field, numbers) => page.run(`(()=>{
    const input=${narrow}.querySelector('[data-report-control="input-3-${field}"]');
    input.value=${JSON.stringify(numbers)};
    input.dispatchEvent(new Event('input',{bubbles:true}));input.form.requestSubmit();
  })()`);
  await enter('red', '4710 / 3.6; 4');
  assert.ok(await until(() => page.run(
    `${wide}.querySelector('[data-report-control="cell-3-red"]')?.textContent==='3, 4, 6, 7, 10'`)));
  assert.equal(await page.run(`!!${narrow}.querySelector('[data-report-control="input-3-red"]')`), false);
  assert.equal(stored().deathReports[0].red.join(), '2,3,5,6,9');
  await click(narrow, 'cell-3-sheriff');
  await enter('sheriff', '10/8');
  assert.ok(await until(() => stored().deathReports[0].sheriff === '9'));

  await page.run(`const shot=${wide}.querySelector('#nights select[aria-label="Отстрел, ночь 1"]');
    shot.value='6';shot.dispatchEvent(new Event('change'))`);
  assert.ok(await until(() => page.run(`!!${wide}.querySelector('[data-report-control="cell-6-red"]')`)));
  assert.equal(stored().deathReports.length, 1, 'автоматическая строка появилась даже без записанных номеров');

  await page.run(`${wide}.defaultView.confirm=text=>{window.reportConfirmation=text;return false}`);
  await click(wide, 'delete-6');
  assert.match(await page.run('window.reportConfirmation'), /Удалить протокол игрока № 7/);
  assert.equal(await page.run(`!!${wide}.querySelector('[data-report-control="cell-6-red"]')`), true);
  await page.run(`${wide}.defaultView.confirm=()=>true`);
  await click(wide, 'delete-6');
  assert.ok(await until(() => page.run(`!${wide}.querySelector('[data-report-control="cell-6-red"]')`)));
  assert.equal(stored().nights[0].shot, '6');
  await click(wide, 'delete-3');
  assert.ok(await until(() => !stored().deathReports.some(report => report.i === '3')));
});

test('судья подтверждает повторное выставление в речи, последний кандидат получает оставшиеся голоса', { skip }, async t => {
  const server = await startServer(t, SECRET);
  const { rooms, host } = await openGame(t, server);
  const page = await openPage(t, `${server.http}/#${rooms.room}`);
  const stored = () => lastOf(host, 'game').S;
  assert.ok(await until(() => page.run("!!document.querySelector('.player')"), 20000));
  const click = (i, selector) => page.run(`document.querySelectorAll('.player')[${i}].querySelector(${JSON.stringify(selector)}).click()`);
  await page.run("window.prompts=[];window.acceptNomination=false;window.confirm=text=>{prompts.push(text);return acceptNomination}");
  await click(0, '.speech-actions button');
  await click(1, '.nomb');
  assert.ok(await until(() => stored().days[0].noms.length === 1));
  assert.ok(await until(() => page.run("document.querySelector('.cand .cnt')?.textContent==='10'")));
  await click(2, '.nomb');
  assert.ok(await until(() => page.run('prompts.length===1')));
  assert.match(await page.run('prompts[0]'), /Игрок 1 .*уже выставил игрока 2 .*Выставить игрока 3/);
  assert.equal(stored().days[0].noms.length, 1);
  await page.run('window.acceptNomination=true');
  await click(2, '.nomb');
  assert.ok(await until(() => stored().days[0].noms.map(n => n.i).join() === '1,2'));
  await click(3, '.speech-actions button');
  await click(4, '.nomb');
  assert.ok(await until(() => stored().days[0].noms.map(n => n.i).join() === '1,2,4'));
  assert.equal(await page.run('prompts.length'), 2);
  assert.ok(await until(() => page.run("document.querySelector('#vote .go')?.disabled")));
  assert.equal(await page.run("document.querySelectorAll('.cand')[2].querySelector('.v11')===null"), true);
  await page.run("document.querySelectorAll('.cand')[0].querySelectorAll('.v11 button')[3].click()");
  await page.run("document.querySelectorAll('.cand')[1].querySelectorAll('.v11 button')[2].click()");
  assert.ok(await until(() => page.run("document.querySelectorAll('.cand')[2]?.querySelector('.cnt').textContent==='5'")));
  await page.run("document.querySelector('#vote .go').click()");
  assert.ok(await until(() => stored().days[0].out?.[0] === '4'));
  assert.equal(stored().days[0].noms[2].v, 5);
});

test('поимённое голосование переносит голос между кандидатами и сохраняет список игроков', { skip }, async t => {
  const server = await startServer(t, SECRET);
  const { rooms, host } = await openGame(t, server);
  const page = await openPage(t, `${server.http}/#${rooms.room}`);
  const day = () => lastOf(host, 'game').S.days[0];
  assert.ok(await until(() => page.run("!!document.querySelector('.player')"), 20000));
  for (const i of [1, 3, 5]) await page.run(`document.querySelectorAll('.player')[${i}].querySelector('.nomb').click()`);
  const row = i => `document.querySelectorAll('.cand')[${i}]`;
  assert.ok(await until(() => page.run(`!!${row(2)}`)));
  await page.run("document.getElementById('namedVotes').click()");
  assert.ok(await until(() => page.run(`!!${row(0)}?.querySelector('[data-voter="0"]')`)));
  const vote = (i, voter) => page.run(`${row(i)}.querySelector('[data-voter="${voter}"]').click()`);
  await vote(0, 0);
  await vote(0, 2);
  await vote(1, 0);
  assert.ok(await until(() => day().noms[0].voters?.join() === '2' && day().noms[1].voters?.join() === '0'));
  assert.ok(await until(() => page.run(`${row(2)}.querySelector('.cnt').textContent==='8'
    && ${row(2)}.querySelector('.voters-note').textContent==='Голосовали: 2, 4, 5, 6, 7, 8, 9, 10'`)));
  await page.run(`${row(1)}.querySelector('[aria-label="Ноль голосов за 4"]').click()`);
  assert.ok(await until(() => day().noms[1].v === 0 && day().noms[1].voters?.length === 0));
  await page.run("document.getElementById('namedVotes').click()");
  assert.equal(await page.run(`${row(0)}.querySelector('.v11 .on').textContent`), '1');
  assert.equal(await page.run("document.querySelector('#vote .go').textContent"), 'Сохранить голосование');
  await page.run("document.getElementById('namedVotes').click()");
  assert.equal(await page.run(`${row(0)}.querySelector('[data-voter="2"]').getAttribute('aria-pressed')`), 'true');
  await page.run("document.querySelector('#vote .go').click()");
  assert.ok(await until(() => day().stage === 'done'));
  assert.deepEqual(day().noms.map(n => [n.v, n.voters]), [[1, ['2']], [0, []], [9, ['0', '1', '3', '4', '5', '6', '7', '8', '9']]]);
  const history = "#voteHistory .saved-ballot";
  assert.ok(await until(() => page.run(`!!document.querySelector('${history}')`)));
  assert.equal(await page.run(`document.querySelector('${history}').open`), false);
  await page.run(`document.querySelector('${history} summary').click()`);
  const historyValues = () => page.run(`[...document.querySelectorAll('${history} tbody tr:first-child td')].slice(1).map(cell=>cell.textContent)`);
  assert.deepEqual(await historyValues(), ['1', '3']);
  assert.match(await page.run(`document.querySelector('${history} summary').textContent`), /День 1.*Ушёл: 6/);
  await page.run("document.getElementById('namedVotes').click()");
  assert.equal(await page.run(`document.querySelector('${history}').open`), true);
  assert.deepEqual(await historyValues(), ['1']);
  assert.ok(await until(() => page.run("document.getElementById('dayTitle').textContent.endsWith('день 2')")));
  assert.deepEqual(await historyValues(), ['1']);
  assert.equal(await page.run(`(() => {
    const current=document.getElementById('vote'),history=document.querySelector('.vote-history');
    return document.querySelector('${history}').open
      && current.getBoundingClientRect().bottom<history.getBoundingClientRect().top
      && parseFloat(getComputedStyle(history).borderTopWidth)>0;
  })()`), true);
  await page.run("document.getElementById('namedVotes').click()");
  await page.run(`document.querySelector('${history} .edit-archive').click()`);
  const archivedVoter = ".archive-edit .cand:first-of-type [data-voter=\"5\"]";
  assert.ok(await until(() => page.run(`!!document.querySelector('${archivedVoter}')`)));
  await page.run(`document.querySelector('${archivedVoter}').click()`);
  assert.ok(await until(() => day().correction?.noms[0].voters.includes('5')));
  assert.ok(await until(() => page.run("!!document.querySelector('.archive-edit .go:not(:disabled)')")));
  await page.run("document.querySelector('.archive-edit .go').click()");
  assert.ok(await until(() => !day().correction && day().noms[0].voters.join() === '2,5'));
  assert.equal(lastOf(host, 'game').S.days.length, 2);
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
  cmd({ a: 'vote', i: 1, v: 6 }); cmd({ a: 'vote', i: 1, v: 11 }); // 11 голосов не бывает
  assert.ok(await until(() => day().noms.map(n => n.v).join() === '6,4'));
  assert.equal(state().days.length, 1);
  cmd({ a: 'voteEnd' });
  assert.ok(await until(() => state().days.length === 2 && state().days[0].out.join() === '1'), 'лидер не покинул стол');
  assert.equal(state().seats[1].st, 'voted');
  assert.ok(await until(() => lifted() === ''), 'после итога плашки опускаются');
  cmd({ a: 'voteReset', day: 0 });
  assert.ok(await until(() => state().days[0].correction?.stage === 'vote'));
  assert.equal(state().seats[1].st, 'voted');
  cmd({ a: 'cancelVoteEdit', day: 0 });
  assert.ok(await until(() => !state().days[0].correction));

  // день 2: поровну → переголосование → снова поровну → подняли
  cmd({ a: 'nom', i: 2 }); cmd({ a: 'nom', i: 5 }); cmd({ a: 'nom', i: 8 });
  cmd({ a: 'status', i: 1, v: 'alive' }); // судья вернул игрока, за столом снова 10 голосов
  cmd({ a: 'vote', i: 2, v: 4 }); cmd({ a: 'vote', i: 5, v: 4 });
  cmd({ a: 'voteEnd' });
  assert.ok(await until(() => day().stage === 'revote' && day().revote.map(n => n.i).join() === '2,5'), 'нет переголосования между равными');
  assert.ok(await until(() => lifted() === '2,5'), 'на худе приподняты не участники переголосования');
  cmd({ a: 'vote', i: 8, v: 9 }); // не участник переголосования
  cmd({ a: 'vote', i: 2, v: 5 });
  cmd({ a: 'voteEnd' });
  assert.ok(await until(() => day().stage === 'lift' && day().tied.join() === '2,5'), 'нет вопроса «подняли/оставили»');
  assert.equal(state().days.length, 2);
  cmd({ a: 'lift', v: 'up' });
  assert.ok(await until(() => state().days[1].out.join() === '2,5' && state().seats[2].st === 'voted' && state().seats[5].st === 'voted'), '«Подняли» не убрал обоих');
  assert.equal(state().days.length, 3);

  // день 3: снова поровну дважды → оставили
  cmd({ a: 'nom', i: 0 }); cmd({ a: 'nom', i: 9 });
  cmd({ a: 'vote', i: 0, v: 4 }); cmd({ a: 'voteEnd' });
  assert.ok(await until(() => day().stage === 'revote'));
  cmd({ a: 'vote', i: 0, v: 4 }); cmd({ a: 'voteEnd' });
  assert.ok(await until(() => day().stage === 'lift'));
  cmd({ a: 'lift', v: 'stay' });
  assert.ok(await until(() => state().days.length === 4 && state().days[2].out.length === 0), '«Оставили» должен оставить всех');
  assert.equal(state().seats[0].st, 'alive');
});

test('судья может исправить каждый раунд голосования после сохранения', { skip }, async t => {
  const server = await startServer(t, SECRET);
  const { rooms, host } = await openGame(t, server);
  const page = await openPage(t, `${server.http}/#${rooms.room}`);
  const stored = () => lastOf(host, 'game').S;
  const day = () => stored().days.at(-1);
  const click = selector => page.run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const vote = n => click(`.cand .v11 button[aria-label="Голосов за 1: ${n}"]`);
  const save = () => click('#vote .go');
  const edit = () => click('#vote .edit-vote');
  const marked = () => page.run("[...document.querySelectorAll('.player')].flatMap((row,i)=>row.querySelector('.nomb.on')?[i+1]:[])");
  const openRound = async index => {
    await edit();
    assert.ok(await page.run("!document.getElementById('voteRounds').hidden"));
    await click(`#voteRounds button:nth-child(${index})`);
  };
  const stage = name => until(() => day().stage === name &&
    page.run(`last.days.at(-1).stage===${JSON.stringify(name)}`));
  const original = () => stored().days[0], draft = () => original().correction;
  const editor = '.archive-edit[data-day="0"]';
  const editArchive = async round => {
    const detail = `details[data-round="0-${round}"]`;
    if (!await page.run(`document.querySelector('${detail}').open`)) await click(detail + ' summary');
    await click(detail + ' .edit-archive');
    assert.ok(await until(() => draft()?.stage === round && page.run(`!!document.querySelector('${editor} .go')`)));
  };
  const archivedVote = n => click(`${editor} .v11 button[aria-label="Голосов за 1: ${n}"]`);
  const saveArchive = () => click(editor + ' .go');
  assert.ok(await until(() => page.run("!!document.querySelector('#vote .edit-vote')"), 20000));
  await edit();
  assert.equal(await page.run("document.activeElement.classList.contains('nomb')"), true);
  await click('.player:nth-child(1) .nomb');
  await click('.player:nth-child(2) .nomb');
  await click('.player:nth-child(3) .nomb');
  assert.ok(await until(() => page.run("document.querySelectorAll('#vote .cand').length===3")));
  assert.deepEqual(await marked(), [1, 2, 3]);
  await edit();
  assert.equal(await page.run("document.activeElement.closest('.v11')!==null"), true);
  await vote(4);
  await click('.cand .v11 button[aria-label="Голосов за 2: 4"]');
  assert.ok(await until(() => page.run("!document.querySelector('#vote .go').disabled")));
  await save();
  assert.ok(await stage('revote'));
  assert.deepEqual(await marked(), [1, 2]);
  assert.deepEqual(await page.run("[...document.querySelectorAll('#voteHistory summary')].map(el=>el.textContent)"),
    ['День 1 · Основное голосование']);
  assert.equal(await page.run("[...document.querySelectorAll('.nomb.on')].every(button=>button.disabled)"), true);

  await openRound(2);
  assert.equal(await page.run("document.activeElement.closest('.v11')!==null"), true);
  await vote(5);
  assert.ok(await until(() => page.run("!document.querySelector('#vote .go').disabled")));
  await openRound(1);
  assert.ok(await stage('vote'));
  assert.equal(day().revote[0].v, 5);
  await save();
  assert.ok(await stage('revote'));
  assert.equal(day().revote[0].v, 5);
  await save();
  assert.ok(await stage('lift'));
  assert.deepEqual(await marked(), [1, 2]);
  await page.run("document.querySelectorAll('#voteHistory summary')[0].click()");
  assert.deepEqual(await page.run("[...document.querySelectorAll('#voteHistory details:first-child tbody tr')].map(row=>row.cells[1].textContent)"),
    ['5', '5']);
  await click('#vote .lift .up');
  assert.ok(await until(() => stored().days.length === 2 && original().stage === 'done'));
  assert.ok(await until(() => page.run("last.days.length===2")));
  assert.match(await page.run("document.querySelector('#voteHistory summary').textContent"), /Переголосование · Ушли: 1, 2/);
  await click('.player:nth-child(4) .nomb');
  assert.ok(await until(() => page.run("!!document.querySelector('#vote .go')")));
  await save();
  assert.ok(await until(() => page.run("last.days.length===3")));
  await click('.player:nth-child(5) .nomb');
  await click('.player:nth-child(6) .speech-actions button');
  assert.ok(await until(() => stored().timer.speaker === '5' && day().noms[0]?.i === '4'));
  const timer = structuredClone(stored().timer), later = structuredClone(stored().days.slice(1));

  await editArchive('revote');
  assert.equal(draft().revote[0].v, 5);
  await archivedVote(6);
  assert.ok(await until(() => draft()?.revote[0].v === 6));
  assert.equal(original().out.join(), '0,1');
  assert.equal(stored().seats[1].status, 'voted');
  await saveArchive();
  assert.ok(await until(() => !draft() && original().out.join() === '0'));
  assert.equal(stored().seats[1].status, 'alive');

  await editArchive('vote');
  assert.equal(draft().noms[0].v, 4);
  await saveArchive();
  assert.ok(await until(() => !draft()));
  assert.equal(original().revote[0].v, 6);

  await editArchive('vote');
  await archivedVote(5);
  assert.ok(await until(() => draft()?.noms[0].v === 5));
  await click(editor + ' .cancel-archive');
  assert.ok(await until(() => !draft()));
  assert.equal(original().noms[0].v, 4);
  await editArchive('vote');
  await archivedVote(5);
  assert.ok(await until(() => draft()?.noms[0].v === 5));
  await saveArchive();
  assert.ok(await until(() => !draft() && original().noms[0].v === 5));
  assert.equal(original().out.join(), '0');
  assert.deepEqual(original().revote, []);
  assert.deepEqual(stored().days.slice(1), later);
  assert.deepEqual(stored().timer, timer);
  assert.deepEqual(await marked(), [5]);
});

test('новый день открывается после итога, отстрел и выставление не перелистывают его ещё раз', { skip }, async t => {
  const server = await startServer(t, SECRET);
  const { rooms, host } = await openGame(t, server);
  const screen = await connect(t, server.url(rooms.hud, 'screen'));
  screen.ws.send(JSON.stringify({kind:'hello',mode:'overlay',timerUpdates:true}));
  assert.ok(await until(() => view(screen)?.day === 1));
  const page = await openPage(t, `${server.http}/#${rooms.room}`);
  const state = () => lastOf(host, 'game').S;
  const ready = () => until(() => page.run("!!document.querySelector('.player')"));
  const player = (i, selector) => page.run(`document.querySelectorAll('.player')[${i}].querySelector(${JSON.stringify(selector)}).click()`);
  const save = () => page.run("document.querySelector('#vote .go').click()");
  const night = (k, seat) => page.run(`(() => {
    const check=document.querySelector('[aria-label="Отстрел, ночь ${k}"]');
    check.value=${JSON.stringify(seat)};check.dispatchEvent(new Event('change'));
  })()`);
  const newDay = n => until(() => page.run(`last.days.length===${n} && last.days.at(-2).stage==='done'`));
  const opener = () => page.run("document.querySelector('.player.day-opener .no')?.textContent");
  assert.ok(await ready());
  assert.equal(await opener(), '1');
  assert.equal(await page.run("getComputedStyle(document.querySelector('.player.day-opener')).outlineWidth"), '2px');
  await player(0, '.nomb');
  assert.ok(await until(() => page.run("!!document.querySelector('#vote .go')")));
  assert.equal(state().days.length, 1);
  assert.ok(await until(() => view(screen).day === 1));
  await save();
  assert.ok(await newDay(2));
  assert.ok(await until(() => view(screen).day === 2));
  assert.equal(await opener(), '2');

  await player(0, '.speech-actions button');
  assert.ok(await until(() => state().timer.running && state().timer.speaker === '0'));
  assert.equal(state().days.length, 2);
  await night(1, '1');
  assert.ok(await until(() => state().nights[0].shot === '1' && page.run("last.opener===2")));
  assert.equal(await opener(), '3');
  await player(2, '.nomb');
  assert.ok(await until(() => page.run("last.days.length===2 && last.days[1].noms[0]?.i==='2'")));
  assert.deepEqual(state().days[0].out, ['0']);

  await save();
  assert.ok(await newDay(3));
  await player(3, '.speech-actions button');
  assert.ok(await until(() => page.run("last.days.length===3 && last.timer.speaker==='3'")));
  assert.equal(await opener(), '4');
  assert.ok(await until(() => view(screen).day === 3 && lastOf(screen, 'timer')?.timer.speaker === '3'));
  assert.deepEqual(state().days[1].out, ['2']);

  await night(2, '5');
  assert.ok(await until(() => state().nights[1].shot === '5'));
  await player(4, '.speech-actions button');
  assert.ok(await until(() => page.run("last.days.length===3 && last.timer.speaker==='4'")));
  assert.equal(await opener(), '4');
  assert.equal(state().days[2].noms.length, 0);
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
  cmd({ a: 'techFoul', i: 3, v: 6, count: 0 }); cmd({ a: 'techFoul', i: 3, v: 6, count: 1 });
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
  assert.equal(r.scores, '0,50/0,00/1,80 0,00/1,00/0,25', 'допы, минусы и тех. минусы в формате сайта');
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
