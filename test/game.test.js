const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createGame } = require('../src/server/game');
const rules = path.join(__dirname, '../src/client/rules.js');
const photo = 'data:image/jpeg;base64,QUJD';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-storage-'));
  const connections = [];
  const track = resource => (connections.push(resource), resource);
  t.after(() => {
    for (const connection of connections.reverse()) connection.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { game: options => track(createGame(dir, rules, options)), db: () => track(new DatabaseSync(path.join(dir, 'hud.sqlite'))) };
}

test('ошибка SQLite оставляет снимок, ревизию и фотографии на месте', t => {
  const files = fixture(t);
  const game = files.game();
  game.open();
  const pid = game.state().seats[0].pid;
  game.setPhoto(pid, photo);
  const db = files.db();
  db.exec("CREATE TRIGGER fail_save BEFORE UPDATE ON game BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.throws(() => game.command({ a: 'foul', i: 0, d: 1 }), /test failure/);
  assert.throws(() => game.deletePlayer(pid), /test failure/);
  assert.equal(game.state().seats[0].fouls, 0);
  assert.equal(game.state().seats[0].pid, pid);
  assert.equal(game.state().revision, 0);
  assert.equal(game.photo(pid), photo);
  assert.equal(db.prepare('SELECT data FROM photos WHERE id = ?').get(pid).data, photo);
});

test('повторная отправка после перезапуска не применяет правку ещё раз', t => {
  const files = fixture(t);
  const first = files.game();
  first.open();
  const who = 'a'.repeat(32);
  assert.equal(first.patch([[['title'], 'Первая', { value: '' }]], { client: who, seq: 1 }, 0).error, null);
  assert.equal(first.patch([[['title'], 'Другая', { value: 'Первая' }]], { client: 'b'.repeat(32), seq: 1 }, 1).error, null);
  const second = files.game();
  assert.equal(second.patch([[['title'], 'Первая', { value: '' }]], { client: who, seq: 1 }, 0).duplicate, true);
  assert.equal(second.state().title, 'Другая');
  assert.equal(second.state().revision, 2);
});

test('неверное поле или конфликт отклоняет весь патч', t => {
  const game = fixture(t).game();
  game.open();
  const edit = [['title'], 'Финал', { value: '' }];
  assert.ok(game.patch([edit, [['seats', '0', 'role'], 'unknown']]).error);
  assert.ok(game.patch([edit, [['seats', '0', 'role'], 'don', { value: 'sheriff' }]]).error);
  assert.equal(game.state().title, '');
  assert.equal(game.state().revision, 0);
  const owner = game.state().seats[1].pid;
  assert.ok(game.patch([[['seats', '0', 'role'], 'don', { value: '', owner }]]).error);
  assert.equal(game.state().seats[0].role, '');
});

test('после перестановки в рейтинговой игре протокол и таймер остаются у своих игроков', t => {
  const files = fixture(t);
  const game = files.game({ judgeSeating: true });
  game.open();
  const player = game.state().seats[0].pid;
  const endAt = Date.now() + 60000;
  assert.equal(game.patch([
    [['seats', '0', 'role'], 'don'],
    [['seats', '0', 'fouls'], 2],
    [['seats', '0', 'bonus'], .5],
    [['nights'], [{ shot: '1', check: '0', don: '2' }]],
    [['days'], [{ opener: 0, noms: [{ i: '1', v: 1, voters: ['0'] }], revote: [{ i: '1', v: 1, voters: ['2'] }],
      out: ['1'], stage: 'done' }, { opener: 2, noms: [], correction: { noms: [{ i: '0', v: 1, voters: ['2'] }] } }]],
    [['timer'], { running: true, endAt, left: 60000, total: 60000, speaker: '0', restartSpeaker: '2', nominated: ['1'] }],
    [['lh'], ['0', '2', '']],
    [['lhPu'], '1'],
    [['lhExtra'], { pu: '2', seats: ['0', '1'] }],
    [['deathReports'], [{ i: '1', manual: false, red: ['2'], black: ['0'], sheriff: '2' }]],
    [['winner'], 'red'],
  ]).error, null);
  const { names, version } = game.judgeState().seating;
  names.splice(0, 3, names[1], names[2], names[0]);
  assert.deepEqual(game.seatParticipants({ names, version, shuffle: false }), { error: null, changed: true });
  const state = files.game({ judgeSeating: true }).state();
  assert.equal(state.seats[2].pid, player);
  assert.equal(state.seats[2].role, 'don');
  assert.equal(state.seats[2].fouls, 2);
  assert.equal(state.seats[2].bonus, .5);
  assert.deepEqual(state.nights, [{ shot: '0', check: '2', don: '1' }]);
  assert.deepEqual(state.days[0].noms, [{ i: '0', v: 1, voters: ['2'] }]);
  assert.deepEqual(state.days[0].revote, [{ i: '0', v: 1, voters: ['1'] }]);
  assert.deepEqual(state.days[0].out, ['0']);
  assert.equal(state.days[0].opener, 2);
  assert.deepEqual(state.days[1].correction.noms, [{ i: '2', v: 1, voters: ['1'] }]);
  assert.deepEqual(state.lh, ['2', '1', '']);
  assert.equal(state.lhPu, '0');
  assert.deepEqual(state.lhExtra, { pu: '1', seats: ['2', '0'] });
  assert.deepEqual(state.deathReports, [{ i: '0', manual: false, red: ['1'], black: ['2'], sheriff: '1' }]);
  assert.deepEqual(state.timer, { running: true, endAt, left: 60000, total: 60000, speaker: '2', restartSpeaker: '1', nominated: ['0'] });
  assert.equal(state.winner, 'red');

  const current = game.judgeState().seating;
  current.names[2] = 'Исправленный ник';
  assert.deepEqual(game.seatParticipants({ ...current, shuffle: false }), { error: null, changed: true });
  assert.equal(game.state().seats[2].pid, player);
  assert.equal(game.judgeState().seats[2].nick, 'Исправленный ник');
  assert.equal(game.judgeState().timer.speaker, '2');
});

test('исправление голосования возвращает только игроков, выбывших по этому результату', t => {
  const game = fixture(t).game();
  game.open();
  game.command({ a: 'shot', i: 2 });
  for (const [i, manual] of [[0, true], [1, false]]) {
    game.command({ a: 'nom', i });
    if (manual) game.command({ a: 'status', i, v: 'voted' });
  }
  game.command({ a: 'vote', i: 0, v: 4 });
  game.command({ a: 'voteEnd' });
  game.command({ a: 'vote', i: 0, v: 4 });
  game.command({ a: 'voteEnd' });
  game.command({ a: 'lift', v: 'up' });
  assert.equal(game.state().seats[1].status, 'voted');
  game.command({ a: 'voteReset', day: 0, round: 'revote' });
  assert.equal(game.state().seats[1].status, 'voted');
  game.command({ a: 'voteEnd', day: 0 });
  game.command({ a: 'lift', day: 0, v: 'stay' });
  assert.equal(game.state().seats[0].status, 'voted');
  assert.equal(game.state().seats[1].status, 'alive');
  assert.equal(game.state().days.length, 2);
});

test('числовой ввод и поимённые голоса работают вместе в основном раунде и переголосовании', t => {
  const files = fixture(t), game = files.game();
  game.open();
  const cmd = (a, fields = {}) => game.command({ a, ...fields });
  const day = () => game.judgeState().days[0];
  cmd('shot', { i: 9 });
  for (const i of [1, 3, 5]) cmd('nom', { i });
  cmd('vote', { i: 1, v: 2 });
  assert.equal(cmd('voteVoter', { i: 3, voter: '9' }), false);
  for (const voter of ['0', '2', '4']) cmd('voteVoter', { i: 3, voter });
  assert.equal(day().noms[2].v, 4);
  assert.equal(day().noms[2].voters, undefined);
  cmd('voteVoter', { i: 1, voter: '0' });
  assert.equal(day().noms[2].v, 6);
  assert.equal(day().noms[2].voters.join(), '1,3,5,6,7,8');
  for (const voter of ['1', '3']) cmd('voteVoter', { i: 1, voter });
  cmd('voteVoter', { i: 3, voter: '6' });
  assert.equal(cmd('voteEnd'), true);
  assert.equal(day().stage, 'revote');
  assert.equal(day().revote.map(n => n.i).join(), '1,3,5');
  for (const voter of ['0', '1', '2', '3', '4']) cmd('voteVoter', { i: 1, voter });
  cmd('voteVoter', { i: 3, voter: '' });
  assert.equal(cmd('voteEnd'), true);
  const restored = files.game().judgeState().days[0];
  assert.equal(restored.revote[0].voters.join(), '0,1,2,3,4');
  assert.equal(restored.revote[2].voters.join(), '5,6,7,8');
  assert.equal(restored.out.join(), '1');
});

test('старое сохранение с законченным голосованием открывает следующий день и сохраняет исторический подсчёт', t => {
  const files = fixture(t), game = files.game();
  game.open();
  const legacy = structuredClone(game.state());
  legacy.days = [{
    stage: 'done', noms: [{ i: '0', v: 5 }, { i: '1', v: 4 }], out: ['0'], changed: ['0'],
  }];
  legacy.seats[0].status = 'voted';
  legacy.seats[9].status = 'removed';
  files.db().prepare('UPDATE game SET state=? WHERE id=1').run(JSON.stringify(legacy));

  const restored = files.game();
  assert.equal(restored.view().day, 2);
  assert.equal(restored.judgeState().opener, 1);
  assert.ok(restored.command({ a: 'voteReset', day: 0 }));
  const draft = restored.judgeState().days[0].correction;
  assert.equal(draft.voters, 9);
  assert.equal(draft.eligibleVoters, null);
  assert.ok(restored.command({ a: 'vote', day: 0, i: 0, v: 4 }));
  assert.ok(restored.command({ a: 'voteEnd', day: 0 }));
  assert.equal(restored.state().days[0].out.join(), '1');
  assert.equal(restored.state().seats[0].status, 'alive');
  assert.equal(restored.state().seats[9].status, 'removed');
  assert.equal(files.game().view().day, 2);
});

test('открывающий стол меняется по кругу среди оставшихся игроков', t => {
  const files = fixture(t), game = files.game();
  game.open();
  assert.equal(game.judgeState().opener, 0);
  for (let i = 1; i < 8; i++) game.command({ a: 'status', i, v: 'removed' });
  game.command({ a: 'nom', i: 9 });
  game.command({ a: 'voteEnd' });
  assert.equal(game.judgeState().opener, 8);
  const restored = files.game();
  assert.equal(restored.judgeState().opener, 8);
  restored.command({ a: 'nom', i: 8 });
  restored.command({ a: 'voteEnd' });
  assert.equal(restored.judgeState().opener, 0);
  restored.command({ a: 'timer', op: 'speak', v: '0' });
  restored.command({ a: 'shot', i: 0 });
  assert.equal(restored.judgeState().opener, 0, 'открывающий уже начавшегося дня сохраняется');
});

test('удаление игрока убирает обычное и ролевое фото из SQLite', t => {
  const files = fixture(t);
  const game = files.game();
  game.open();
  const pid = game.state().seats[0].pid;
  game.setPhoto(pid, photo);
  game.setPhoto(pid + '.sheriff', photo);
  assert.equal(game.deletePlayer(pid).error, null);
  const restored = files.game();
  assert.equal(restored.state().seats[0].pid, '');
  assert.equal(restored.state().roster.some(p => p.id === pid), false);
  assert.deepEqual(restored.photoIds(), []);
});

test('дополнительное время и два фола записываются вместе только для говорящего', t => {
  const files = fixture(t);
  const game = files.game();
  game.open();
  const command = (op, fields = {}) => game.command({ a: 'timer', op, ...fields });
  assert.equal(command('speak', { v: '0', ms: 60000 }), true);
  assert.equal(command('extra', { i: 1 }), false);
  game.command({ a: 'foul', i: 0, d: 1 });
  command('pause');
  const remaining = game.judgeState().timer.remain;
  assert.equal(command('extra', { i: 0 }), true);
  assert.equal(command('extra', { i: 0 }), false);
  assert.equal(game.judgeState().timer.remain, remaining + 30000);
  assert.equal(game.judgeState().timer.running, false);
  assert.equal(game.judgeState().timer.total, 60000);
  assert.equal(game.state().seats[0].fouls, 3);
  assert.equal(files.game().state().seats[0].fouls, 3);
});

test('технические фолы удваивают второй штраф, удаляют игрока и пересчитываются при снятии', t => {
  const files = fixture(t);
  const game = files.game();
  game.open();
  const techFoul = (i, v, count, d = 1) => game.command({ a: 'techFoul', i, v, count, d });
  assert.equal(game.command({ a: 'score', i: 0, f: 't', v: 0.2 }), true);
  assert.equal(game.judgeState().seats[0].t, 0.2);
  assert.equal(techFoul(0, 1, 0), false);
  for (const [i, first, second, total] of [[0, 3, 3, 0.9], [1, 3, 6, 1.5], [2, 6, 3, 1.2], [3, 6, 6, 1.8]]) {
    assert.equal(techFoul(i, first, 0), true);
    assert.equal(techFoul(i, first, 0), false);
    assert.equal(game.judgeState().seats[i].t, first / 10);
    assert.equal(game.judgeState().seats[i].st, 'alive');
    assert.equal(techFoul(i, second, 1), true);
    assert.equal(game.judgeState().seats[i].t, total);
    assert.equal(game.judgeState().seats[i].techFoulCount, 2);
    assert.equal(game.judgeState().seats[i].fouls, 0);
    assert.equal(game.judgeState().seats[i].st, 'removed');
    assert.equal(game.view().seats[i].status, 'removed');
    assert.equal(techFoul(i, 6, 2), false);
    assert.equal(game.command({ a: 'score', i, f: 't', v: 0 }), false);
  }
  const restored = files.game();
  assert.equal(restored.judgeState().seats[3].t, 1.8);
  assert.equal(restored.view().seats[3].status, 'removed');

  assert.equal(techFoul(1, 3, 2, -1), true);
  assert.equal(game.judgeState().seats[1].t, 0.6);
  assert.equal(game.view().seats[1].status, 'alive');
  assert.equal(techFoul(1, 3, 1, -1), false);
  assert.equal(techFoul(1, 6, 2, -1), false);
  assert.equal(techFoul(1, 6, 1, -1), true);
  assert.equal(game.judgeState().seats[1].t, 0);

  game.command({ a: 'status', i: 3, v: 'removed' });
  assert.equal(techFoul(3, 6, 2, -1), true);
  assert.equal(game.judgeState().seats[3].t, 0.6);
  assert.equal(game.view().seats[3].status, 'removed');
});

test('общий таймер запускается на 10, 20 или 60 секунд и снимает выделение говорящего', t => {
  const game = fixture(t).game();
  game.open();
  const timer = (op, fields = {}) => game.command({ a: 'timer', op, ...fields });
  assert.equal(game.judgeState().timer.countdown, false);
  assert.equal(timer('speak', { v: '0', ms: 60000 }), true);
  assert.equal(game.judgeState().timer.countdown, false);
  assert.equal(timer('countdown', { ms: 15000 }), false);
  for (const ms of [10000, 20000, 60000]) {
    assert.equal(timer('countdown', { ms }), true);
    const running = game.judgeState().timer;
    assert.equal(running.running, true);
    assert.equal(running.total, ms);
    assert.equal(running.speaker, '');
    assert.equal(running.countdown, true);
    assert.ok(running.remain > 0 && running.remain <= ms);
    assert.equal(timer('pause'), true);
    assert.equal(timer('stop'), true);
    assert.equal(game.judgeState().timer.remain, 0);
    assert.equal(timer('reset'), true);
    assert.equal(game.judgeState().timer.remain, ms);
    assert.equal(timer('restart'), true);
    assert.equal(game.judgeState().timer.countdown, true);
  }
});

test('перезапуск речи возвращает исходное время и последнего говорящего после остановки', t => {
  const files = fixture(t);
  const game = files.game();
  game.open();
  const timer = (op, fields = {}) => game.command({ a: 'timer', op, ...fields });
  assert.equal(timer('speak', { v: '4', ms: 30000 }), true);
  assert.equal(timer('extra', { i: 4 }), true);
  assert.ok(game.judgeState().timer.remain > 30000);
  assert.equal(timer('restart'), true);
  assert.ok(game.judgeState().timer.remain <= 30000);
  assert.equal(game.state().seats[4].fouls, 2);
  assert.equal(timer('stop'), true);
  assert.equal(game.judgeState().timer.remain, 0);
  assert.equal(game.judgeState().timer.speaker, '');

  const restored = files.game();
  assert.equal(restored.command({ a: 'timer', op: 'restart' }), true);
  assert.equal(restored.judgeState().timer.speaker, '4');
  assert.equal(restored.judgeState().timer.total, 30000);
  assert.equal(restored.judgeState().timer.running, true);
  assert.equal(restored.state().seats[4].fouls, 2);
});

test('два лучших хода сохраняются независимо и переживают перезапуск', t => {
  const files = fixture(t);
  const game = files.game();
  game.open();
  const set = (i, v) => game.command({ a: 'lhset', i, v });
  assert.equal(set(0, ['1', '2', '3']), true);
  assert.equal(set(1, ['0', '2', '4']), true);
  assert.equal(set(2, ['0', '1', '4']), false);
  assert.equal(set(1, ['0', '4']), true);
  const restored = files.game();
  const state = () => restored.judgeState();
  assert.equal(state().lh.join(), '1,2,3');
  assert.equal(state().lhExtra.pu, '1');
  assert.equal(state().lhExtra.seats.join(), '0,4');
  assert.equal(restored.command({ a: 'lhset', i: 0, v: [] }), true);
  assert.equal(state().pu, '1');
  assert.equal(state().lh.join(), '0,4,');
  assert.equal(state().lhExtra, null);
});

test('протокол можно записать живому игроку, а исправление отстрела сохраняет заполненную запись', t => {
  const files = fixture(t);
  const game = files.game();
  game.open();
  const command = (op, i, fields = {}) => game.command({ a: 'deathReport', op, i, ...fields });
  const shot = v => game.command({ a: 'night', f: 'shot', k: 0, v });
  const reports = () => game.judgeState().deathReports;

  assert.equal(command('add', 2), true);
  assert.equal(game.judgeState().seats[2].st, 'alive');
  assert.equal(reports()[0].manual, true);
  assert.equal(reports()[0].night, 0);
  assert.equal(command('add', 2), false);
  assert.equal(command('pick', 2, { field: 'black', n: 10 }), false);
  command('pick', 2, { field: 'black', n: 8 });
  command('pick', 2, { field: 'red', n: 8 });
  command('pick', 2, { field: 'sheriff', n: 1 });
  command('pick', 2, { field: 'sheriff', n: 8 });
  assert.equal(reports()[0].black.length, 0);
  assert.equal(reports()[0].red.join(), '8');
  assert.equal(reports()[0].sheriff, '8');

  shot('5');
  assert.equal(reports()[0].i, '5');
  assert.equal(reports()[0].night, 1);
  assert.equal(game.state().deathReports.length, 1, 'пустая строка из отстрела вычисляется по ночи');
  shot('6');
  assert.equal(reports().some(report => report.i === '5'), false);
  command('pick', 6, { field: 'black', n: 0 });
  shot('');
  const stored = files.game().judgeState().deathReports;
  const savedShot = stored.find(report => report.i === '6');
  assert.equal(savedShot.night, 0);
  assert.equal(savedShot.manual, false);
  assert.equal(savedShot.black.join(), '0');
  assert.equal(stored.some(report => report.i === '2' && report.manual), true);
  assert.equal(Object.hasOwn(game.view(), 'deathReports'), false);
});

test('удалённый протокол отстрела не возвращается при перезапуске и может быть добавлен вручную', t => {
  const files = fixture(t);
  const game = files.game();
  game.open();
  game.command({ a: 'night', f: 'shot', k: 0, v: '5' });
  const report = (op, fields = {}) => game.command({ a: 'deathReport', i: 5, op, ...fields });
  assert.equal(report('set', { field: 'black', picks: [9, 2, 9] }), true);
  assert.equal(game.judgeState().deathReports[0].black.join(), '2,9');
  assert.equal(report('set', { field: 'sheriff', picks: [2, 3] }), false);
  assert.equal(report('set', { field: 'red', picks: [2, 10] }), false);
  assert.equal(report('delete'), true);
  assert.equal(report('pick', { field: 'red', n: 1 }), false);

  const restored = files.game();
  assert.equal(restored.judgeState().seats[5].st, 'killed');
  assert.equal(restored.judgeState().deathReports.length, 0);
  assert.equal(restored.command({ a: 'deathReport', op: 'add', i: 5 }), true);
  assert.equal(restored.judgeState().deathReports[0].manual, true);
  assert.equal(restored.judgeState().deathReports[0].black.length, 0);
});
