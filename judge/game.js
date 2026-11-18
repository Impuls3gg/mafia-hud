// Сервер выполняет общие правила игры, а состояние сохраняет в SQLite.
const crypto = require('crypto');
const fs = require('fs');
const vm = require('vm');
const { openStorage, PHOTO_ID, validPhoto } = require('./store');

const ROOM = /^[a-f0-9]{32}$/;
const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];
const newRoom = () => crypto.randomBytes(16).toString('hex');

function createGame(dir, rulesFile) {
  const storage = openStorage(dir);
  const rules = vm.createContext({ S: null, photos: storage.photos() });
  vm.runInContext(fs.readFileSync(rulesFile, 'utf8'), rules, { filename: rulesFile });

  const makeState = value => {
    const state = rules.normalState(value);
    const { room, hud } = value.judge || {};
    state.judge = { room: ROOM.test(room) ? room : newRoom(), hud: ROOM.test(hud) ? hud : newRoom() };
    return state;
  };
  const stored = storage.game();
  if (stored) rules.S = makeState(stored);

  function setPhoto(id, data) {
    if (typeof id !== 'string' || !PHOTO_ID.test(id) || (data !== null && !validPhoto(id, data))) return false;
    storage.setPhoto(id, data);
    if (data === null) delete rules.photos[id];
    else rules.photos[id] = data;
    return true;
  }

  return {
    rooms: () => rules.S?.judge || {},
    owns(room) { return !!rules.S && (room === rules.S.judge.room || room === rules.S.judge.hud); },
    // Первый вход в пульт создаёт пустую игру.
    open() {
      if (rules.S) return;
      const state = makeState(rules.defaultState());
      storage.save(state);
      rules.S = state;
    },
    state: () => rules.S,
    view: () => rules.buildView(),
    judgeState: () => rules.stateMsg(),
    seatedPhotos: () => [...rules.seatedPhotos()],
    photo: id => rules.photos[id] || null,
    photoIds: () => Object.keys(rules.photos),
    setPhoto,
    // итоги с MafiaUniverse для экранов худа: kind — 'game' или 'results'
    setShow(kind, data) {
      if (!rules.S || !['game', 'results'].includes(kind)) return;
      rules.S.show = { ...(rules.S.show || {}), [kind]: data };
      storage.save(rules.S);
    },
    command(message) {
      const changed = rules.judgeCommand(message);
      if (changed) storage.save(rules.S);
      return changed;
    },
    patch(ops) {
      const safe = ops.filter(op => {
        if (!Array.isArray(op) || op.length !== 2) return false;
        const [keys] = op;
        return Array.isArray(keys) && keys.length > 0
          && keys.every(key => typeof key === 'string' && !UNSAFE_KEYS.includes(key));
      });
      rules.applyOps(rules.S, safe);
      storage.save(rules.S);
    },
    // Перенос с устройства заменяет игру целиком, вместе с фото.
    replace(value) {
      if (!Array.isArray(value?.seats) || !Array.isArray(value.roster) || !Array.isArray(value.nights) || !value.nights.length) return false;
      const state = makeState(value);
      storage.replace(state);
      rules.S = state;
      rules.photos = Object.create(null);
      return true;
    }
  };
}

module.exports = { createGame };
