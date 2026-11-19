const ROOM = /^[a-f0-9]{32}$/;
const roles = ['', 'civ', 'sheriff', 'mafia', 'don'];
const statuses = ['alive', 'voted', 'removed'];
const scenes = ['game', 'red', 'black', 'gameres', 'standings'];
const winners = ['', 'red', 'black', 'draw'];
const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const number = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const text = (value, max = 2000) => typeof value === 'string' && value.length <= max;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value, max, check) => Array.isArray(value) && value.length <= max && value.every(check);
const id = value => text(value, 64) && /^[\w-]+$/.test(value);
const seat = value => typeof value === 'string' && /^[0-9]$/.test(value);
const maybeSeat = value => value === '' || seat(value);
const room = value => typeof value === 'string' && ROOM.test(value);
const fields = (value, checks) => record(value) &&
  Object.keys(value).every(key => Object.hasOwn(checks, key)) &&
  Object.entries(checks).every(([key, check]) => check(value[key]));
const optional = check => value => value === undefined || check(value);
const keysAre = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const validBallot = value => list(value, 10, item => fields(item, { i: seat, v: v => v === '' || integer(v, 10) }));
const validSeats = value => list(value, 10, seat);
const editable = new Set(['title', 'roster', 'seats', 'nights', 'ui', 'accent', 'game', 'mu', 'showFouls',
  'scene', 'judge', 'wait', 'days', 'timer', 'lh', 'lhPu', 'lhExtra', 'notes', 'winner', 'showPage']);

function timer(value, speech) {
  return fields(value, {
    running: v => typeof v === 'boolean',
    endAt: integer,
    total: v => integer(v, speech ? 600000 : 86400000) && v > 0,
    left: v => integer(v, 86400000),
    [speech ? 'speaker' : 'show']: speech ? maybeSeat : v => typeof v === 'boolean',
  });
}

function tournament(value) {
  if (value === null) return true;
  return fields(value, {
    id: v => typeof v === 'string' && /^\d{0,12}$/.test(v),
    title: v => text(v, 120),
    url: v => v === '' || (text(v, 300) && /^https:\/\/(?:mafiauniverse\.org|mafiaworld\.org)\//.test(v)),
    table: v => integer(v),
    cur: v => text(v, 64),
    at: v => integer(v),
    games: v => list(v, 500, g => fields(g, {
      key: v => text(v, 64) && v.length > 0, title: v => text(v, 80), round: v => text(v, 80),
      table: v => integer(v), judge: v => text(v, 60), date: v => text(v, 30),
      ready: v => typeof v === 'boolean', ended: v => typeof v === 'boolean',
      seats: v => list(v, 10, n => text(n, 40)) && v.length === 10,
    })),
  });
}

function results(value, game) {
  const columns = game
    ? ['n', 'nick', 'role', 'pu', 'ci', 'plus', 'minus', 'tech', 'sum']
    : ['place', 'nick', 'sum', 'plus', 'lh', 'dop', 'ci', 'pen', 'games', 'first'];
  return fields(value, {
    id: v => text(v, 36),
    at: integer,
    title: v => text(v, 80),
    rows: v => list(v, game ? 10 : 200, row => record(row) && columns.every(key => text(row[key], 80))),
    ...(game ? { winner: v => winners.includes(v) } : {}),
  });
}

function validState(state) {
  if (!fields(state, {
    v: optional(integer), photoVer: optional(integer),
    revision: integer, title: text, game: integer, accent: v => typeof v === 'string' && /^#[a-f0-9]{6}$/i.test(v),
    scene: v => scenes.includes(v), showFouls: v => typeof v === 'boolean',
    judge: v => fields(v, { room, hud: room }) && v.room !== v.hud,
    roster: v => list(v, 5000, r => fields(r, { id, nick: n => text(n, 256), mu: optional(n => text(n, 256)) })),
    seats: v => list(v, 10, s => fields(s, {
      pid: p => p === '' || id(p), role: r => roles.includes(r), status: st => statuses.includes(st),
      fouls: f => integer(f, 4), bonus: n => number(n, 0, 1.5), pen: n => number(n, 0, 1.5), tech: n => number(n, 0, 1.5),
    })) && v.length === 10,
    nights: v => list(v, 1000, n => fields(n, { shot: maybeSeat, check: maybeSeat, don: maybeSeat })) && v.length > 0,
    days: v => list(v, 1000, d => fields(d, {
      noms: validBallot, revote: optional(validBallot), stage: optional(s => ['vote', 'revote', 'lift', 'done'].includes(s)),
      tied: optional(validSeats), out: optional(validSeats), changed: optional(validSeats),
    })) && v.length > 0,
    timer: v => timer(v, true), wait: v => timer(v, false),
    lh: v => list(v, 3, maybeSeat) && v.length === 3, lhPu: maybeSeat,
    lhExtra: optional(v => v === null || fields(v, {
      pu: seat, seats: picks => list(picks, 3, seat) && picks.length > 0 && new Set(picks).size === picks.length,
    })),
    notes: text, winner: v => winners.includes(v), mu: tournament, showPage: optional(v => integer(v, 200)),
    ui: v => fields(v, {
      th: x => number(x, 120, 400), ts: x => number(x, .6, 1.8), gap: x => number(x, 0, 40),
      mb: x => number(x, 0, 200), side: x => number(x, 0, 200), ns: x => number(x, .5, 1.6),
      is: x => number(x, .5, 1.6), ot: x => number(x, 0, 100),
    }),
    show: optional(v => fields(v, { game: optional(g => results(g, true)), results: optional(r => results(r, false)) })),
  })) return false;
  const players = new Set(state.roster.map(player => player.id));
  const occupied = state.seats.map(s => s.pid).filter(Boolean);
  return players.size === state.roster.length && occupied.every(pid => players.has(pid)) &&
    occupied.length === new Set(occupied).size;
}

function applyEdits(state, ops) {
  if (!Array.isArray(ops) || !ops.length || ops.length > 5000) return 'Некорректный список правок.';
  const owners = { roster: state.roster.map(player => player.id), seats: state.seats.map(seat => seat.pid) };
  for (const op of ops) {
    if (!Array.isArray(op) || ![2, 3].includes(op.length)) return 'Некорректная правка.';
    const [path, value, expected] = op;
    if (!Array.isArray(path) || !editable.has(path[0]) || path.length > 8 ||
        path.some(key => !text(key, 64) || ['__proto__', 'constructor', 'prototype'].includes(key))) return 'Недопустимое поле.';
    let target = state;
    for (const key of path.slice(0, -1)) {
      if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) return 'Путь к полю изменился.';
      target = target[key];
    }
    const key = path.at(-1);
    if (!target || typeof target !== 'object' ||
        (Array.isArray(target) && (!/^\d+$/.test(key) || !Object.hasOwn(target, key)))) return 'Путь к полю изменился.';
    if (op.length === 3) {
      if (!keysAre(expected, ['value', 'owner'])) return 'Некорректное исходное значение.';
      if (expected.owner !== undefined &&
          (!Object.hasOwn(owners, path[0]) || owners[path[0]][path[1]] !== expected.owner)) {
        return 'Игрок на этом месте изменился. Проверьте рассадку.';
      }
      const before = JSON.stringify(expected.value);
      const actual = JSON.stringify(target[key]);
      if (actual !== before && actual !== JSON.stringify(value)) return 'Поле уже изменилось на другом устройстве.';
    }
    target[key] = value;
  }
  return null;
}

module.exports = { validState, applyEdits, room, id };
