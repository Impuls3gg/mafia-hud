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
  return { game: () => track(createGame(dir, rules)), db: () => track(new DatabaseSync(path.join(dir, 'hud.sqlite'))) };
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

test('отмена голосования откатывает только изменения голосования', t => {
  const game = fixture(t).game();
  game.open();
  for (const [i, manual] of [[0, true], [1, false]]) {
    game.command({ a: 'nom', i });
    if (manual) game.command({ a: 'status', i, v: 'voted' });
    game.command({ a: 'vote', i, v: 7 });
  }
  game.command({ a: 'voteEnd' });
  for (const i of [0, 1]) game.command({ a: 'vote', i, v: 5 });
  game.command({ a: 'voteEnd' });
  game.command({ a: 'lift', v: 'up' });
  game.command({ a: 'voteReset' });
  assert.equal(game.state().seats[0].status, 'voted');
  assert.equal(game.state().seats[1].status, 'alive');
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
