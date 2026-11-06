// Игра на сервере: состояние и фото лежат на диске, а команды выполняют те же правила, что и в пульте.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOM = /^[a-f0-9]{32}$/;
const PHOTO_ID = /^[\w-]+(\.\w+)?$/;
const PHOTO_DATA = /^data:image\/[\w.+-]+;base64,/;
const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];
const newRoom = () => crypto.randomBytes(16).toString('hex');

function createGame(dir, page) {
  const code = fs.readFileSync(page, 'utf8').match(/<script id="rules">([\s\S]*?)<\/script>/)[1];
  const rules = vm.createContext({ S: null, photos: {} });
  vm.runInContext(code, rules, { filename: 'rules' });

  const stateFile = path.join(dir, 'game.json');
  const photoDir = path.join(dir, 'photos');
  fs.mkdirSync(photoDir, { recursive: true });

  function save() {
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(rules.S));
    fs.renameSync(stateFile + '.tmp', stateFile); // файл заменяется целиком, поэтому обрыв записи не испортит игру
  }

  // Пароль на сервере не хранится в игре, а ссылки судьи и экранов остаются прежними, если они уже есть.
  function adopt(value) {
    const state = rules.normalState(value);
    const { room, hud } = value.judge || {};
    state.judge = { url: '', room: ROOM.test(room) ? room : newRoom(), hud: ROOM.test(hud) ? hud : newRoom(), key: '' };
    rules.S = state;
    save();
  }

  function setPhoto(id, data) {
    if (typeof id !== 'string' || !PHOTO_ID.test(id)) return false;
    if (data && !PHOTO_DATA.test(data)) return false;
    if (data) {
      fs.writeFileSync(path.join(photoDir, id), data);
      rules.photos[id] = data;
    } else {
      fs.rmSync(path.join(photoDir, id), { force: true });
      delete rules.photos[id];
    }
    return true;
  }

  if (fs.existsSync(stateFile)) rules.S = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  for (const id of fs.readdirSync(photoDir)) rules.photos[id] = fs.readFileSync(path.join(photoDir, id), 'utf8');

  return {
    rooms: () => rules.S?.judge || {},
    owns(room) { return !!rules.S && (room === rules.S.judge.room || room === rules.S.judge.hud); },
    // Первый вход в пульт создаёт пустую игру.
    open() { if (!rules.S) adopt(rules.defaultState()); },
    state: () => rules.S,
    view: () => rules.buildView(),
    judgeState: () => rules.stateMsg(),
    seatedPhotos: () => [...rules.seatedPhotos()],
    photo: id => rules.photos[id] || null,
    photoIds: () => Object.keys(rules.photos),
    setPhoto,
    command(message) {
      const changed = rules.judgeCommand(message);
      if (changed) save();
      return changed;
    },
    patch(ops) {
      const safe = ops.filter(([keys]) => Array.isArray(keys) && keys.length
        && keys.every(key => typeof key === 'string' && !UNSAFE_KEYS.includes(key)));
      rules.applyOps(rules.S, safe);
      save();
    },
    // Перенос с устройства заменяет игру целиком, вместе с фото.
    replace(value) {
      if (!Array.isArray(value?.seats) || !Array.isArray(value.roster) || !Array.isArray(value.nights) || !value.nights.length) return false;
      fs.readdirSync(photoDir).forEach(id => fs.rmSync(path.join(photoDir, id)));
      rules.photos = {};
      adopt(value);
      return true;
    }
  };
}

module.exports = { createGame };
