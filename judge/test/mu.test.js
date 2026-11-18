// Итоги с MafiaUniverse: разбор страниц игры и турнира и показ их на худе через сервер.
// Вместо настоящего сайта поднимается его подделка: страницы повторяют разметку MafiaUniverse, ники выдуманные.
const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { parseGame, parseResults } = require('../mu');
const { startServer, connect, until, findChrome, openPage } = require('./helpers');

// сайт отдаёт кириллицу HTML-сущностями
const enc = s => [...s].map(c => c.charCodeAt(0) > 127 ? `&#x${c.charCodeAt(0).toString(16).toUpperCase()};` : c).join('');
const GAME_ID = '11111111-2222-3333-4444-555555555555';
const GAME_PAGE = `<html><head><title>${enc('Информация об игре Тур 3 стол 1')} (${GAME_ID}) - MafiaUniverse</title></head><body>
  <dl><dt>${enc('Турнир')}</dt><dd>Test</dd><dt>${enc('Победитель')}</dt><dd>${enc('Мафия')}</dd></dl>
  <table class="table"><thead><tr><th> # </th><th>${enc('Игрок')}</th><th>${enc('Роль')}</th><th><span> ${enc('ПУ')} </span></th><th> Ci </th><th><span> + </span></th><th><span> - </span></th><th><span> ${enc('тех')} </span></th><th><span> ∑ </span></th></tr></thead>
  <tbody>${['Мирный', 'Дон', 'Шериф', 'Мафия', 'Мирный', 'Мирный', 'Мафия', 'Мирный', 'Мирный', 'Мирный'].map((role, i) =>
    `<tr><td> ${i + 1} </td><td> ${enc('Игрок ' + (i + 1))} &amp; Co </td><td> ${enc(role)} </td><td>${i === 4 ? '1,2,3' : ''}</td><td></td><td>${i === 1 ? '0,5' : ''}</td><td>${i === 2 ? '0,3' : ''}</td><td></td><td> ${i === 1 ? '1,5' : '0'} </td></tr>`).join('')}</tbody></table></body></html>`;
const RESULTS_PAGE = `<html><head><title>${enc('Результаты Кубок теста')} - MafiaUniverse</title></head><body>
  <table id="TournResultsTable"><thead><tr><th> # </th><th> ${enc('Игрок')} </th><th><span title="${enc('Сумма баллов')}">∑</span></th><th><span title="${enc('Сумма доп баллов')}">∑ +</span></th>
  <th> 1 <i title="${enc('Количество первых отстрелов')}"></i></th><th><span>${enc('ЛХ')}</span></th><th><span>${enc('Допы')}</span></th><th><span>Ci</span></th>
  <th><i title="${enc('Сумма штрафов')}"></i></th><th><i title="${enc('Игр')}"></i></th><th>μ</th><th>P</th></tr></thead>
  <tbody>${Array.from({ length: 30 }, (_, i) => `<tr><td> ${i + 1} </td><td><a href="/Player/${i}"> ${enc('Ник ' + (i + 1))} </a></td><td> ${30 - i},5 </td><td> ${i % 3},1 </td><td> 1 </td><td> 0,4 </td><td> 2,2 </td><td> 0,1 </td><td> 0,3 </td><td> 8 </td><td> 1,1 </td><td> 0 </td></tr>`).join('')}</tbody></table></body></html>`;

test('разбор страницы игры MafiaUniverse', () => {
  const g = parseGame(GAME_PAGE);
  assert.equal(g.title, 'Тур 3 стол 1');
  assert.equal(g.winner, 'black');
  assert.equal(g.rows.length, 10);
  assert.deepEqual(g.rows[1], { n: '2', nick: 'Игрок 2 & Co', role: 'Дон', pu: '', ci: '', plus: '0,5', minus: '', tech: '', sum: '1,5' });
  assert.equal(g.rows[4].pu, '1,2,3');
  assert.throws(() => parseGame('<html><table><tr><th>x</th></tr></table></html>'), /нет таблицы/);
});

test('разбор итоговой таблицы турнира MafiaUniverse', () => {
  const r = parseResults(RESULTS_PAGE);
  assert.equal(r.title, 'Кубок теста');
  assert.equal(r.rows.length, 30);
  assert.deepEqual(r.rows[0], { place: '1', nick: 'Ник 1', sum: '30,5', plus: '0,1', lh: '0,4', dop: '2,2', ci: '0,1', pen: '0,3', games: '8', first: '1' });
  assert.throws(() => parseResults(`<p>${enc('Результаты скрыты организатором')}</p>`), /скрыл/);
});

test('пульт загружает итоги с MafiaUniverse, и худ их получает', async t => {
  const fake = http.createServer((req, res) => {
    if (req.url === `/Games/Details/${GAME_ID}`) return res.end(GAME_PAGE);
    if (req.url === '/Tournaments/Results/777') return res.end(RESULTS_PAGE);
    res.writeHead(404).end();
  });
  await new Promise(resolve => fake.listen(0, resolve));
  t.after(() => fake.close());
  process.env.MU_ORIGIN = `http://localhost:${fake.address().port}`;
  t.after(() => { delete process.env.MU_ORIGIN; });

  const server = await startServer(t, 'pw');
  const host = await connect(t, `ws://localhost:${server.port}/ws?role=host&key=pw`);
  const messages = () => host.texts().map(x => JSON.parse(x));
  const S = await until(() => messages().find(m => m.kind === 'game')?.S);
  const screen = await connect(t, server.url(S.judge.hud, 'screen'));
  screen.ws.send(JSON.stringify({ app: 'mafiahud', kind: 'hello', mode: 'overlay' }));
  const view = () => screen.texts().map(x => JSON.parse(x)).filter(m => m.kind === 'view').at(-1)?.view;
  assert.ok(await until(() => view()));
  const send = m => host.ws.send(JSON.stringify(m));
  const fetched = what => messages().filter(m => m.kind === 'muFetched' && m.what === what).at(-1);

  send({ kind: 'muFetch', what: 'game', id: GAME_ID });
  assert.ok(await until(() => fetched('game')?.ok), 'итоги игры не загрузились');
  assert.equal(fetched('game').rows, 10);
  send({ kind: 'patch', seq: 1, ops: [[['scene'], 'gameres']] });
  assert.ok(await until(() => view().scene === 'gameres' && view().show?.title === 'Тур 3 стол 1'), 'худ не получил итоги игры');

  send({ kind: 'muFetch', what: 'results', id: '777' });
  assert.ok(await until(() => fetched('results')?.ok));
  send({ kind: 'patch', seq: 2, ops: [[['scene'], 'standings'], [['showPage'], 1]] });
  assert.ok(await until(() => view().scene === 'standings' && view().show?.rows.length === 30 && view().showPage === 1), 'худ не получил таблицу турнира');

  send({ kind: 'patch', seq: 3, ops: [[['scene'], 'game']] });
  assert.ok(await until(() => view().scene === 'game' && view().show === null), 'итоги не нужны экрану игры');

  send({ kind: 'muFetch', what: 'results', id: '../etc' });
  assert.ok(await until(() => fetched('results')?.ok === false), 'неверный номер турнира не отклонён');
  assert.match(fetched('results').error, /Неверный/);
  send({ kind: 'muFetch', what: 'game', id: '99999999-2222-3333-4444-555555555555' });
  assert.ok(await until(() => fetched('game')?.ok === false));
  assert.match(fetched('game').error, /не нашёл/);
});

test('пульт: вывести таблицу по id турнира, обновить её и выгрузить результаты игры по ссылке', { skip: findChrome() ? false : 'нужен Chrome: укажите путь в CHROME_PATH' }, async t => {
  const hits = { game: 0, results: 0 };
  const fake = http.createServer((req, res) => {
    if (req.url === `/Games/Details/${GAME_ID}`) { hits.game++; return res.end(GAME_PAGE); }
    if (req.url === '/Tournaments/Results/777') { hits.results++; return res.end(RESULTS_PAGE); }
    res.writeHead(404).end();
  });
  await new Promise(resolve => fake.listen(0, resolve));
  t.after(() => fake.close());
  process.env.MU_ORIGIN = `http://localhost:${fake.address().port}`;
  t.after(() => { delete process.env.MU_ORIGIN; });

  const server = await startServer(t, 'pw');
  const page = await openPage(t, `${server.http}/panel`);
  await until(() => page.run("!!document.getElementById('login')"), 20000);
  await page.run("document.getElementById('lKey').value='pw';document.getElementById('login').requestSubmit()");
  assert.ok(await until(() => page.run("!!document.getElementById('shGameUrl')"), 20000), 'пульт не открылся');
  assert.match(await page.run("document.getElementById('shGamesHint').textContent"), /закладкой «Отправить в HUD»/, 'нет подсказки, откуда берётся список игр');

  // «Вывести итоговую таблицу»: скачать по id и сразу показать на худе
  await page.run("document.getElementById('shTour').value='https://mafiauniverse.org/Tournament/777';document.querySelector('[data-a=showRes]').click()");
  assert.ok(await until(() => page.run("((S.show||{}).results?.rows||[]).length===30&&S.scene==='standings'")), 'таблица не выведена');
  assert.equal(await page.run("document.querySelector('[data-a=showRes]').classList.contains('on')"), true);
  await page.run("document.querySelector('[data-a=pgNext]').click()");
  assert.ok(await until(() => page.run('S.showPage===1')));

  await page.run("document.querySelector('[data-a=refRes]').click()");
  assert.ok(await until(() => hits.results === 2), '«Обновить итоговую таблицу» не скачала её заново');
  assert.equal(await page.run('S.scene'), 'standings', 'обновление не переключает экран');
  assert.ok(await until(() => page.run("document.getElementById('shResSt').textContent.startsWith('Загружено')")));
  assert.equal(await page.run('S.showPage'), 1, 'обновление не сбрасывает страницу таблицы');

  // «Выгрузить результаты игры» по ссылке на её страницу
  await page.run(`document.getElementById('shGameUrl').value='https://mafiauniverse.org/Games/Edit/${GAME_ID}';document.querySelector('[data-a=showGame]').click()`);
  assert.ok(await until(() => page.run("(S.show||{}).game?.title==='Тур 3 стол 1'&&S.scene==='gameres'")), 'результаты игры не выгружены');
  assert.equal(hits.game, 1);
  await page.run("document.querySelector('#scenes [data-s=game]').click()");
  assert.ok(await until(() => page.run("S.scene==='game'")));

  // уже загруженная таблица выводится сразу, а свежая догружается следом
  await page.run("document.querySelector('[data-a=showRes]').click()");
  assert.equal(await page.run("S.scene"), 'standings', 'загруженная таблица не показана сразу');
  assert.ok(await until(() => hits.results === 3), 'свежая таблица не догрузилась');

  await page.run("document.getElementById('shGameUrl').value='https://example.com/abc';document.querySelector('[data-a=showGame]').click()");
  assert.ok(await until(() => page.run("document.getElementById('shGameSt').textContent.includes('нет кода игры')")));
});
