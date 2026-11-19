const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const { openStorage, PHOTO_ID, validPhoto } = require('./store');
const { applyEdits, validState, room, id } = require('./state');

const newRoom = () => crypto.randomBytes(16).toString('hex');
const MAX_PHOTOS = 64 * 1024 * 1024;
const photoSize = photos => Object.values(photos).reduce((size, photo) => size + photo.length, 0);

function createGame(dir, rulesFile) {
  const storage = openStorage(dir);
  const rules = vm.createContext({ S: null, photos: storage.photos() });
  vm.runInContext(fs.readFileSync(rulesFile, 'utf8'), rules, { filename: rulesFile });
  let size = photoSize(rules.photos);

  function makeState(value) {
    const state = rules.normalState(value);
    const { room: judge, hud } = value.judge || {};
    const judgeRoom = room(judge) ? judge : newRoom();
    state.judge = { room: judgeRoom, hud: room(hud) && hud !== judgeRoom ? hud : newRoom() };
    if (Array.isArray(state.seats)) {
      state.seats = state.seats.map(s => s && ({ ...rules.emptySeat(s.pid), ...s }));
    }
    if (Array.isArray(state.nights)) {
      state.nights = state.nights.map(n => n && ({ check: '', don: '', ...n, shot: n.shot === 'miss' ? '' : n.shot ?? '' }));
    }
    return state;
  }
  const stored = storage.game();
  if (stored) {
    rules.S = makeState(stored);
    if (!validState(rules.S)) throw new Error('Сохранённая игра не прошла проверку формата.');
  }

  function persist(state, receipt, deleted = []) {
    state.revision = rules.S.revision + 1;
    if (!validState(state)) return 'Некорректные данные игры.';
    storage.save(state, receipt, deleted);
    rules.S = state;
    for (const pid of deleted) {
      size -= rules.photos[pid]?.length || 0;
      delete rules.photos[pid];
    }
    return null;
  }

  function deletedPhotos(state) {
    const roster = new Set(state.roster.map(player => player.id));
    const removed = new Set(rules.S.roster.map(player => player.id).filter(pid => !roster.has(pid)));
    return Object.keys(rules.photos).filter(key => removed.has(key.split('.')[0]));
  }

  return {
    close: storage.close,
    rooms: () => rules.S?.judge || {},
    owns(role, key) { return !!rules.S && rules.S.judge[role === 'judge' ? 'room' : 'hud'] === key; },
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
    setPhoto(id, data) {
      if (typeof id !== 'string' || !PHOTO_ID.test(id) || (data !== null && !validPhoto(id, data))) return false;
      const nextSize = size - (rules.photos[id]?.length || 0) + (data?.length || 0);
      if (data !== null && nextSize > MAX_PHOTOS) return false;
      storage.setPhoto(id, data);
      size = nextSize;
      if (data === null) delete rules.photos[id];
      else rules.photos[id] = data;
      return true;
    },
    setShow(kind, data, display, resetPage) {
      const state = { ...rules.S, show: { ...rules.S.show, [kind]: data } };
      if (display) state.scene = kind === 'game' ? 'gameres' : 'standings';
      if (kind === 'results') {
        const lastPage = Math.max(0, Math.ceil(data.rows.length / 12) - 1);
        state.showPage = display && resetPage ? 0 : Math.min(state.showPage || 0, lastPage);
      }
      return persist(state);
    },
    command(message) {
      const previous = rules.S;
      const candidate = structuredClone(previous);
      rules.S = candidate;
      let handled;
      try {
        handled = rules.judgeCommand(message);
      } finally {
        rules.S = previous;
      }
      if (!handled || JSON.stringify(previous) === JSON.stringify(candidate)) return false;
      return persist(candidate) === null;
    },
    patch(ops, receipt, revision) {
      if (receipt && storage.receipt(receipt.client) >= receipt.seq) return { duplicate: true };
      if (receipt && (!Number.isSafeInteger(revision) || revision < 0 || revision > rules.S.revision)) {
        return { error: 'Исходная версия игры недоступна.' };
      }
      const candidate = structuredClone(rules.S);
      const error = applyEdits(candidate, ops);
      if (error) return { error };
      if (!validState(candidate)) return { error: 'Некорректные данные игры.' };
      const day = candidate.days.at(-1);
      if (day.changed) day.changed = day.changed.filter(i => candidate.seats[i].status === rules.S.seats[i].status);
      const deleted = deletedPhotos(candidate);
      return { error: persist(candidate, receipt, deleted), deleted };
    },
    deletePlayer(pid, receipt) {
      if (receipt && storage.receipt(receipt.client) >= receipt.seq) return { duplicate: true };
      if (!id(pid)) return { error: 'Некорректный игрок.' };
      const candidate = structuredClone(rules.S);
      rules.removePlayer(candidate, pid);
      const deleted = deletedPhotos(candidate);
      return { error: persist(candidate, receipt, deleted), deleted };
    },
    prepareImport(value) {
      if (!Array.isArray(value?.seats) || !Array.isArray(value.roster) ||
          !Array.isArray(value.nights) || !value.nights.length) return null;
      const state = makeState(value);
      return validState(state) ? { state, photos: Object.create(null), size: 0 } : null;
    },
    importPhoto(draft, pid, data) {
      if (!validPhoto(pid, data)) return false;
      const nextSize = draft.size - (draft.photos[pid]?.length || 0) + data.length;
      if (nextSize > MAX_PHOTOS) return false;
      draft.photos[pid] = data;
      draft.size = nextSize;
      return true;
    },
    replace(draft) {
      const { state, photos } = draft;
      state.revision = rules.S.revision + 1;
      storage.replace(state, photos);
      rules.S = state;
      rules.photos = photos;
      size = draft.size;
    },
  };
}

module.exports = { createGame };
