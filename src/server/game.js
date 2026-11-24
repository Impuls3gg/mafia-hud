const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const { openStorage, PHOTO_ID, validPhoto } = require('./store');
const { applyEdits, validState, room, id } = require('./state');

const newRoom = () => crypto.randomBytes(16).toString('hex');
const MAX_PHOTOS = 64 * 1024 * 1024;
const photoSize = photos => Object.values(photos).reduce((size, photo) => size + photo.length, 0);

function withTournamentRoster(state, changes, placement) {
  if (!changes.length) return state;
  const roster = new Map(state.roster.map(player => [player.id, player]));
  const seated = new Set(state.seats.map(seat => seat.pid));
  if (placement?.revision > (state.tournamentSeatingRevision ?? 0)) {
    for (const pid of placement.seats) seated.add(pid);
  }
  for (const { id, nick, mu, active } of changes) {
    if (!active && !seated.has(id)) roster.delete(id);
    else roster.set(id, { id, nick, mu });
  }
  // Сохраняем игроков за столом даже при достижении лимита списка игры.
  for (const pid of roster.keys()) {
    if (roster.size <= 5000) break;
    if (!seated.has(pid)) roster.delete(pid);
  }
  return { ...state, roster: [...roster.values()], tournamentRosterRevision: changes.at(-1).revision };
}

function withTournamentSeating(state, placement) {
  if (!placement || placement.revision <= (state.tournamentSeatingRevision ?? 0)) return state;
  const roster = new Map(state.roster.map(player => [player.id, player]));
  for (const player of placement.players ?? []) if (!roster.has(player.id)) roster.set(player.id, player);
  const reserved = new Set(placement.seats);
  for (const pid of roster.keys()) {
    if (roster.size <= 5000) break;
    if (!reserved.has(pid)) roster.delete(pid);
  }
  const seats = state.seats.map((seat, index) => {
    const pid = placement.seats[index];
    return roster.has(pid) ? { ...seat, pid } : { ...seat, pid: '' };
  });
  return { ...state, roster: [...roster.values()], seats, tournamentSeatingRevision: placement.revision };
}

function preserveSeatingProtocol(state, seats) {
  const previous = new Map(state.seats.flatMap(({ pid }, i) => pid ? [[pid, i]] : []));
  const sources = seats.map(pid => previous.get(pid));
  const used = new Set(sources.filter(i => i !== undefined));
  for (const [index, source] of sources.entries()) {
    if (source !== undefined || used.has(index)) continue;
    sources[index] = index;
    used.add(index);
  }
  const unused = state.seats.map((_, index) => index).filter(index => !used.has(index));
  const newIndex = [];
  state.seats = sources.map((source, index) => {
    const from = source ?? unused.shift();
    newIndex[from] = index;
    return { ...state.seats[from], pid: seats[index] };
  });
  if (newIndex.every((index, previous) => index === previous)) return;
  const position = index => index === '' ? '' : String(newIndex[+index]);
  const remap = (entry, keys) => {
    for (const key of keys) if (entry[key] !== undefined) entry[key] = position(entry[key]);
  };
  const remapLists = (entry, keys) => {
    for (const key of keys) if (entry[key]) entry[key] = entry[key].map(position);
  };
  const remapBallot = ballot => {
    for (const entry of ballot ?? []) {
      entry.i = position(entry.i);
      remapLists(entry, ['voters']);
    }
  };
  function remapDay(day) {
    remapBallot(day.noms);
    remapBallot(day.revote);
    remapBallot(day.mainReview?.noms);
    remapLists(day, ['tied', 'out', 'voteSeats', 'revoteSeats', 'changed']);
  }
  for (const day of state.days) {
    remapDay(day);
    if (day.correction) remapDay(day.correction);
    if (day.opener !== undefined) day.opener = newIndex[day.opener];
  }
  for (const night of state.nights) remap(night, ['shot', 'check', 'don']);
  remap(state.timer, ['speaker', 'restartSpeaker']);
  remapLists(state.timer, ['nominated']);
  remap(state, ['lhPu']);
  remapLists(state, ['lh']);
  if (state.lhExtra) {
    remap(state.lhExtra, ['pu']);
    remapLists(state.lhExtra, ['seats']);
  }
  for (const report of state.deathReports ?? []) {
    remap(report, ['i', 'sheriff']);
    remapLists(report, ['red', 'black']);
  }
}

function createGame(dir, rulesFile, { judgeSeating = false, fixedGameNumber = null, tournament } = {}) {
  const storage = openStorage(dir);
  const rules = vm.createContext({ S: null, photos: storage.photos() });
  vm.runInContext(fs.readFileSync(rulesFile, 'utf8'), rules, { filename: rulesFile });
  let size = photoSize(rules.photos);

  function makeState(value) {
    const state = rules.normalState(value);
    if (fixedGameNumber !== null) state.game = fixedGameNumber;
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
  function reconcileFinishedDay(state) {
    const previous = rules.S;
    rules.S = state;
    try {
      rules.resumeFinishedDay();
    } finally {
      rules.S = previous;
    }
  }
  const stored = storage.game();
  if (stored) {
    rules.S = makeState(stored);
    if (!validState(rules.S)) throw new Error('Сохранённая игра не прошла проверку формата.');
    reconcileFinishedDay(rules.S);
  }

  function persist(state, receipt, deleted = []) {
    if (fixedGameNumber !== null) state.game = fixedGameNumber;
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
  function syncTournamentRoster(state, placement) {
    return tournament ? withTournamentRoster(state, tournament.rosterChanges(state.tournamentRosterRevision ?? 0), placement) : state;
  }
  const sameSeating = state => state.seats.every((seat, index) => seat.pid === rules.S.seats[index].pid);
  function overlayPhoto(id) {
    return tournament?.photo(id) || rules.photos[id] || null;
  }

  function deletedPhotos(state) {
    const roster = new Set(state.roster.map(player => player.id));
    const removed = new Set(rules.S.roster.map(player => player.id).filter(pid => !roster.has(pid)));
    return Object.keys(rules.photos).filter(key => removed.has(key.split('.')[0]));
  }

  function hasActivity() {
    const state = rules.S;
    return Boolean(state.winner || state.timer.speaker || state.timer.restartSpeaker ||
      state.days.length > 1 || state.days.some(day => day.noms.length || day.out?.length) ||
      state.nights.some(night => night.shot || night.check || night.don) ||
      state.lh.some(Boolean) || state.lhExtra || state.deathReports?.length ||
      state.seats.some(seat => seat.role || seat.status !== 'alive' || seat.fouls || seat.bonus || seat.pen || rules.techPenalty(seat)));
  }

  function currentSeating() {
    const state = rules.S;
    const roster = new Map(state.roster.map(player => [player.id, player.nick]));
    const names = state.seats.map(seat => roster.get(seat.pid) ?? '');
    const version = crypto.createHash('sha256').update(JSON.stringify(state.seats.map((seat, i) => [seat.pid, names[i]]))).digest('hex');
    return { names, version };
  }

  function seatParticipants({ names, version, shuffle }) {
    if (!judgeSeating) return { error: 'Рассадку турнира задаёт организатор.' };
    const previous = currentSeating();
    if (version !== previous.version) return { error: 'Рассадка изменилась. Загрузите текущие места и повторите.' };
    if (typeof shuffle !== 'boolean' || !Array.isArray(names) || names.length !== previous.names.length ||
        names.some(name => typeof name !== 'string' || name.length > 256)) {
      return { error: 'Проверьте имена участников.' };
    }
    names = names.map(name => name.trim());
    if (shuffle && names.filter(Boolean).length < 2) return { error: 'Для перемешивания нужны хотя бы два участника.' };

    const candidate = structuredClone(rules.S);
    const active = hasActivity();
    // Сначала закрепляем игроков, которые остались на месте, затем ищем остальных по нику.
    const seats = names.map((name, i) => name && name === previous.names[i] ? candidate.seats[i].pid : '');
    const assigned = new Set(seats.filter(Boolean));
    const byName = new Map();
    const players = new Map(candidate.roster.map(player => [player.id, player]));
    const occupiedIds = new Set(candidate.seats.map(seat => seat.pid));
    for (const player of candidate.roster) {
      if (!byName.has(player.nick)) byName.set(player.nick, []);
      const list = byName.get(player.nick);
      if (occupiedIds.has(player.id)) list.unshift(player.id);
      else list.push(player.id);
    }
    names.forEach((nick, i) => {
      if (!nick || seats[i]) return;
      const pid = byName.get(nick)?.find(id => !assigned.has(id));
      if (!pid) return;
      assigned.add(pid);
      seats[i] = pid;
    });
    let renamed = false;
    names.forEach((nick, i) => {
      if (!nick || seats[i]) return;
      let pid = active && candidate.seats[i].pid;
      if (pid && !assigned.has(pid)) {
        players.get(pid).nick = nick;
        renamed = true;
      } else {
        pid = 'p' + newRoom();
        candidate.roster.push({ id: pid, nick });
      }
      assigned.add(pid);
      seats[i] = pid;
    });
    if (shuffle) {
      const occupied = seats.filter(Boolean);
      const original = [...occupied];
      do {
        for (let i = occupied.length - 1; i > 0; i--) {
          const j = crypto.randomInt(i + 1);
          [occupied[i], occupied[j]] = [occupied[j], occupied[i]];
        }
      } while (occupied.every((pid, i) => pid === original[i]));
      let next = 0;
      for (const [i, pid] of seats.entries()) if (pid) seats[i] = occupied[next++];
    }
    if (!renamed && seats.every((pid, i) => pid === rules.S.seats[i].pid)) return { changed: false };
    if (active) preserveSeatingProtocol(candidate, seats);
    else candidate.seats = seats.map(pid => rules.emptySeat(pid));
    const error = persist(candidate);
    return { error, changed: !error };
  }

  return {
    close: storage.close,
    rooms: () => rules.S?.judge || {},
    owns(role, key) { return !!rules.S && rules.S.judge[role === 'judge' ? 'room' : 'hud'] === key; },
    open({ title = '', roster, seating, tournamentRosterRevision } = {}) {
      if (rules.S) return;
      const state = makeState(rules.defaultState());
      state.title = title;
      if (tournamentRosterRevision !== undefined) state.tournamentRosterRevision = tournamentRosterRevision;
      if (roster) {
        state.roster = roster;
        state.seats = Array.from({ length: 10 }, (_, i) => rules.emptySeat(seating[i] || ''));
      }
      if (!validState(state)) throw new Error('Некорректная рассадка.');
      storage.save(state);
      rules.S = state;
    },
    state: () => rules.S,
    hasActivity,
    view() {
      const view = rules.buildView(overlayPhoto);
      const design = tournament?.design();
      if (!design) return view;
      return { ...view, ...design, title: design.title || view.title };
    },
    syncTournamentRoster() {
      const placement = tournament?.placement(rules.S.tournamentSeatingRevision ?? 0);
      const state = withTournamentSeating(syncTournamentRoster(rules.S, placement), placement);
      if (state !== rules.S) persist(state);
    },
    overlayPhoto,
    timer: () => rules.timerView(),
    exportProtocol: () => rules.muExportData(),
    judgeState: () => ({ ...rules.stateMsg(), ...(judgeSeating ? { seating: currentSeating() } : {}) }),
    seatParticipants,
    nominationConfirmation(message) {
      const warning = rules.nominationWarning(message);
      return warning && !rules.confirmedNomination(message, warning) ? warning : null;
    },
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
    expireSpeech() {
      const timer = rules.S?.timer;
      if (!timer?.running || timer.endAt > Date.now()) return false;
      return persist({ ...rules.S, timer: rules.finishSpeech(timer) }) === null;
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
      if (tournament && !sameSeating(candidate)) return { error: 'Рассадка меняется в админке турнира.' };
      for (const day of candidate.days) {
        if (day.changed) day.changed = day.changed.filter(i => candidate.seats[i].status === rules.S.seats[i].status);
      }
      const deleted = deletedPhotos(candidate);
      return { error: persist(candidate, receipt, deleted), deleted };
    },
    deletePlayer(pid, receipt) {
      if (receipt && storage.receipt(receipt.client) >= receipt.seq) return { duplicate: true };
      if (!id(pid)) return { error: 'Некорректный игрок.' };
      if (tournament && rules.S.seats.some(seat => seat.pid === pid)) return { error: 'Сначала измените рассадку в админке турнира.' };
      const candidate = structuredClone(rules.S);
      rules.removePlayer(candidate, pid);
      const deleted = deletedPhotos(candidate);
      return { error: persist(candidate, receipt, deleted), deleted };
    },
    prepareImport(value) {
      if (!Array.isArray(value?.seats) || !Array.isArray(value.roster) ||
          !Array.isArray(value.nights) || !value.nights.length) return null;
      const state = makeState(value);
      if (!validState(state)) return null;
      if (tournament && !sameSeating(state)) return null;
      reconcileFinishedDay(state);
      return { state, photos: Object.create(null), size: 0 };
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
      const { photos } = draft;
      let { state } = draft;
      if (tournament) {
        delete state.tournamentRosterRevision;
        state.tournamentSeatingRevision = rules.S.tournamentSeatingRevision;
        state = syncTournamentRoster(state);
      }
      state.revision = rules.S.revision + 1;
      storage.replace(state, photos);
      rules.S = state;
      rules.photos = photos;
      size = draft.size;
    },
  };
}

module.exports = { createGame, withTournamentRoster, withTournamentSeating };
