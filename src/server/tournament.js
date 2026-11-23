const { randomBytes, randomInt } = require('node:crypto');

const id = () => randomBytes(16).toString('hex');
const initialPlan = () => ({ stages: [], judges: [], pairs: [], final: null });
const normalized = nick => nick.trim().toLocaleLowerCase('ru');
const pairKey = (a, b) => a < b ? a + '/' + b : b + '/' + a;

function tournamentWorkflow(db, InputError) {
  const fail = (message, code = 400) => { throw new InputError(message, code); };
  db.exec(`
    CREATE TABLE IF NOT EXISTS tournament_plans (
      tournament_id TEXT PRIMARY KEY REFERENCES tournaments(id), data TEXT NOT NULL CHECK (json_valid(data))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS tournament_fixtures (
      game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
      stage_id TEXT NOT NULL, stage_round INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS tournament_placements (
      game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, seats TEXT NOT NULL CHECK (json_valid(seats))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS participant_registration (
      participant_id TEXT PRIMARY KEY REFERENCES participants(id),
      confirmed INTEGER NOT NULL, paid INTEGER NOT NULL
    ) STRICT;
  `);
  const prepare = sql => db.prepare(sql);
  const planRow = prepare('SELECT data FROM tournament_plans WHERE tournament_id = ?');
  const savePlan = prepare(`INSERT INTO tournament_plans VALUES (?, ?)
    ON CONFLICT(tournament_id) DO UPDATE SET data = excluded.data`);
  const fixtures = prepare(`SELECT f.game_id, f.stage_id, f.stage_round
    FROM tournament_fixtures f JOIN games g ON g.id = f.game_id WHERE g.tournament_id = ?`);
  const addFixture = prepare('INSERT INTO tournament_fixtures VALUES (?, ?, ?)');
  const placementRow = prepare('SELECT revision, seats FROM tournament_placements WHERE game_id = ?');
  const savePlacement = prepare(`INSERT INTO tournament_placements VALUES (?, 1, ?)
    ON CONFLICT(game_id) DO UPDATE SET revision = revision + 1, seats = excluded.seats`);
  const registrations = prepare(`SELECT p.id, coalesce(r.confirmed, 1) AS confirmed, coalesce(r.paid, 0) AS paid
    FROM participants p LEFT JOIN participant_registration r ON p.id = r.participant_id WHERE p.tournament_id = ?`);
  const saveRegistration = prepare(`INSERT INTO participant_registration VALUES (?, ?, ?)
    ON CONFLICT(participant_id) DO UPDATE SET confirmed = excluded.confirmed, paid = excluded.paid`);
  const detachStream = prepare('UPDATE streams SET game_id = NULL WHERE game_id = ?');
  const deleteGame = prepare('DELETE FROM games WHERE id = ?');
  const plan = tid => JSON.parse(planRow.get(tid)?.data ?? JSON.stringify(initialPlan()));
  const roster = (tid, players) => {
    const flags = new Map(registrations.all(tid).map(row => [row.id, { confirmed: !!row.confirmed, paid: !!row.paid }]));
    return players.map(player => ({ ...player, ...flags.get(player.id) }));
  };
  const placement = game => {
    const row = placementRow.get(game);
    return row && { revision: row.revision, seats: JSON.parse(row.seats) };
  };
  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = action();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function games(tid, list, setup = plan(tid)) {
    const byGame = new Map(fixtures.all(tid).map(row => [row.game_id, row]));
    const byStage = new Map(setup.stages.map(stage => [stage.id, stage]));
    const judgesByTable = new Map(setup.judges.map(judge => [judge.table, judge.nick]));
    return list.map(game => {
      const row = byGame.get(game.id);
      const stage = row && byStage.get(row.stage_id);
      return { ...game, stageId: stage?.id ?? null, stageTitle: stage?.name ?? '',
        stageRound: row?.stage_round ?? game.round, coefficient: stage?.coefficient ?? 1,
        judgeName: judgesByTable.get(game.table) ?? '' };
    });
  }
  function requireStage(setup, key) {
    return setup.stages.find(stage => stage.id === key) ?? fail('Стадия не найдена.', 404);
  }
  function text(value, message) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) fail(message);
    return value.trim();
  }
  function range(value, min, max, message) {
    if (!Number.isInteger(value) || value < min || value > max) fail(message);
    return value;
  }
  function openPlan(tid) {
    const setup = plan(tid);
    if (setup.final) fail('Сначала откройте турнир для изменений на странице админки.', 409);
    return setup;
  }
  return {
    plan, roster, games, placement, transaction, openPlan,
    save(tid, setup) { savePlan.run(tid, JSON.stringify(setup)); },
    registration(pid, data, old = { confirmed: true, paid: false }) {
      const { confirmed = old.confirmed, paid = old.paid } = data;
      if (typeof confirmed !== 'boolean' || typeof paid !== 'boolean') fail('Проверьте подтверждение и статус оплаты.');
      return { id: pid, confirmed, paid };
    },
    saveRegistration: ({ id, confirmed, paid }) => saveRegistration.run(id, +confirmed, +paid),
    updateSetup(tid, action, data, list, players) {
      const setup = openPlan(tid);
      if (action === 'stage') {
        const key = data.id ?? id();
        if (data.id) requireStage(setup, key);
        const scheduled = games(tid, list, setup).filter(game => game.stageId === key);
        if (data.remove === true) {
          if (scheduled.length) fail('Удалите игры стадии перед удалением стадии.', 409);
          setup.stages = setup.stages.filter(stage => stage.id !== key);
        } else {
          const name = text(data.name, 'Укажите название стадии.');
          const rounds = range(data.rounds, 1, 50, 'Укажите от 1 до 50 игр на игрока.');
          const players = range(data.players, 10, 500, 'Укажите от 10 до 500 игроков.');
          if (players % 10) fail('Количество игроков должно быть кратно 10.');
          if (rounds * players / 10 > 500) fail('На стадии может быть до 500 игр.');
          if (!Number.isFinite(data.coefficient) || data.coefficient <= 0 || data.coefficient > 10 ||
              typeof data.swiss !== 'boolean' || typeof data.final !== 'boolean') fail('Проверьте параметры стадии.');
          if (scheduled.some(game => game.stageRound > rounds || game.table > players / 10)) {
            fail('Сначала удалите лишние незавершённые игры.', 409);
          }
          if (setup.stages.some(stage => stage.id !== key && normalized(stage.name) === normalized(name))) fail('Стадия с таким названием уже есть.', 409);
          const stage = { id: key, name, rounds, players, coefficient: data.coefficient, swiss: data.swiss, final: data.final };
          const index = setup.stages.findIndex(previous => previous.id === key);
          if (index < 0) setup.stages.push(stage);
          else setup.stages[index] = stage;
        }
      } else if (action === 'judge') {
        if (data.remove === true) {
          setup.judges = setup.judges.filter(judge => judge.id !== data.id);
          setup.pairs = setup.pairs.filter(pair => pair.judge !== data.id);
        } else {
          const nick = text(data.nick, 'Укажите имя судьи.');
          const table = range(data.table, 1, 1000, 'Укажите номер стола судьи.');
          if (setup.judges.some(judge => judge.table === table)) fail('На этот стол уже назначен судья.', 409);
          setup.judges.push({ id: id(), nick, table });
        }
      } else if (action === 'pair') {
        if (data.remove === true) setup.pairs = setup.pairs.filter(pair => pair.id !== data.id);
        else {
          const pids = new Set(players.map(player => player.id));
          if (!pids.has(data.player) || (data.opponent ? !pids.has(data.opponent) || data.player === data.opponent
            : !setup.judges.some(judge => judge.id === data.judge)) || !['separate', 'minimize', 'together'].includes(data.rule)) {
            fail('Выберите участников или судью и правило для пары.');
          }
          if (data.opponent && data.judge) fail('Выберите второго игрока или судью.');
          const duplicate = setup.pairs.some(pair => data.opponent
            ? pair.opponent && pairKey(pair.player, pair.opponent) === pairKey(data.player, data.opponent)
            : pair.player === data.player && pair.judge === data.judge);
          if (duplicate) fail('Для этой пары правило уже задано.', 409);
          setup.pairs.push({ id: id(), player: data.player, opponent: data.opponent || '', judge: data.judge || '', rule: data.rule });
        }
      }
      savePlan.run(tid, JSON.stringify(setup));
      return setup;
    },
    createGames(tid, stageId, list, create) {
      const setup = openPlan(tid);
      const stage = requireStage(setup, stageId);
      const scheduled = games(tid, list, setup).filter(game => game.stageId === stageId);
      const existing = new Map(scheduled.map(game => [game.stageRound + ':' + game.table, game]));
      let lastRound = Math.max(0, ...list.map(game => game.round));
      return transaction(() => {
        let created = 0;
        for (let round = 1; round <= stage.rounds; round++) {
          const globalRound = scheduled.find(game => game.stageRound === round)?.round ?? ++lastRound;
          for (let table = 1; table <= stage.players / 10; table++) {
            if (existing.has(round + ':' + table)) continue;
            const game = create({ title: stage.name.slice(0, 90) + ' · тур ' + round + ' · стол ' + table, tournamentId: tid, round: globalRound, table });
            addFixture.run(game.id, stage.id, round);
            created++;
          }
        }
        return { created };
      });
    },
    place(tid, data, list, players, readState, ranking, scoreRound) {
      const setup = openPlan(tid);
      if (data.overwrite !== undefined && typeof data.overwrite !== 'boolean') fail('Проверьте параметр перезаписи.');
      const tournamentGames = games(tid, list, setup);
      const states = new Map(tournamentGames.map(game => [game.id, readState(game.id, tid)]));
      const group = tournamentGames.filter(game => game.stageId === data.stageId);
      const confirmed = new Map(roster(tid, players).filter(player => player.confirmed).map(player => [player.id, player]));
      const targets = new Map();
      let skipped = 0;
      let waitingForResults = false;
      function assignable(game) {
        const state = states.get(game.id);
        return state && game.status === 'draft' && !state.winner &&
          (data.overwrite || !state.seats.some(seat => seat.pid));
      }
      if (data.gameId !== undefined) {
        const game = tournamentGames.find(game => game.id === data.gameId);
        if (!game) fail('Игра этого турнира не найдена.', 404);
        if (!assignable(game)) fail('Рассадку можно менять только до начала игры.', 409);
        const seats = data.seating;
        const previous = states.get(game.id).seats;
        if (!Array.isArray(seats) || seats.length !== 10 ||
            seats.some((pid, index) => pid !== '' && !confirmed.has(pid) && previous[index].pid !== pid) ||
            new Set(seats.filter(Boolean)).size !== seats.filter(Boolean).length) {
          fail('Проверьте места. Подтверждённый участник может занять только одно место.');
        }
        targets.set(game.id, seats);
      } else if (data.rows !== undefined) {
        const stage = data.stageId ? requireStage(setup, data.stageId) : null;
        const list = stage ? group : tournamentGames;
        if (!Array.isArray(data.rows) || !data.rows.length || data.rows.length > 10000) fail('В CSV должно быть от 1 до 10 000 записей.');
        const byPosition = new Map(list.map(game => [(stage ? game.stageRound : game.round) + ':' + game.table, game]));
        const nicks = new Map([...confirmed.values()].map(player => [normalized(player.nick), player.id]));
        for (const [index, row] of data.rows.entries()) {
          if (!Array.isArray(row) || row.length !== 4) fail('В строке CSV должно быть четыре колонки.');
          const [round, table, seat, nick] = row;
          const game = Number.isInteger(round) && Number.isInteger(table) && byPosition.get(round + ':' + table);
          const pid = typeof nick === 'string' && nicks.get(normalized(nick));
          if (!game || !Number.isInteger(seat) || seat < 1 || seat > 10 || !pid) {
            fail('Проверьте тур, стол, место и ник подтверждённого игрока в строке ' + (index + 1) + '.');
          }
          if (!targets.has(game.id)) targets.set(game.id, Array(10).fill(''));
          const seating = targets.get(game.id);
          if (seating[seat - 1]) fail('В CSV повторяется место в туре ' + round + ' за столом ' + table + '.');
          seating[seat - 1] = pid;
        }
        for (const [game, seats] of targets) {
          if (seats.some(pid => !pid) || new Set(seats).size !== 10) fail('В каждой игре CSV должно быть 10 разных игроков.');
          if (!assignable(tournamentGames.find(item => item.id === game))) {
            targets.delete(game);
            skipped++;
          }
        }
      } else {
        const stage = requireStage(setup, data.stageId);
        if (!group.length) fail('Сначала создайте игры этой стадии.', 409);
        const prior = new Map();
        const seatsUsed = new Map();
        const selected = ranking.filter(pid => confirmed.has(pid));
        if (selected.length < stage.players) fail('Для стадии нужно больше подтверждённых участников.', 409);
        const rounds = Map.groupBy(group.sort((a, b) => a.stageRound - b.stageRound || a.table - b.table), game => game.stageRound);
        for (const game of tournamentGames) {
          if (game.stageId === stage.id || game.round >= group[0].round) continue;
          remember(states.get(game.id)?.seats.map(seat => seat.pid) ?? [], prior, seatsUsed);
        }
        const pool = selected.slice(0, stage.players);
        const stagePoints = new Map(pool.map(pid => [pid, 0]));
        for (const [round, games] of rounds) {
          const openGames = games.filter(assignable);
          skipped += games.length - openGames.length;
          const fixed = new Map(games.filter(game => !openGames.includes(game)).flatMap(game =>
            states.get(game.id)?.seats.filter(seat => seat.pid).map(seat => [seat.pid, game.table]) ?? []));
          if (stage.swiss && games.some(game => game.status !== 'finished') && round > 1 &&
              [...rounds].some(([previous, earlier]) => previous < round && earlier.some(game => game.status !== 'finished'))) {
            waitingForResults = true;
            break;
          }
          if (openGames.length) {
            const available = [...new Set([...fixed.keys(), ...pool, ...selected])].slice(0, stage.players).filter(pid => !fixed.has(pid));
            if (available.length !== openGames.length * 10) fail('Проверьте состав уже рассаженных столов в туре ' + round + '.', 409);
            if (stage.swiss) available.sort((a, b) => (stagePoints.get(b) || 0) - (stagePoints.get(a) || 0));
            const seating = arrange(openGames, available, setup, prior, seatsUsed, stage.swiss, fixed);
            if (!seating) fail('Не удалось выполнить ограничения для тура ' + round + '. Проверьте правила пар или загрузите CSV.', 409);
            seating.forEach((seats, i) => targets.set(openGames[i].id, seats));
          }
          for (const game of games) {
            const snapshot = states.get(game.id);
            remember(targets.get(game.id) ?? snapshot?.seats.map(seat => seat.pid) ?? [], prior, seatsUsed);
            if (stage.swiss && game.status === 'finished') {
              for (const [pid, points] of scoreRound(game, snapshot)) stagePoints.set(pid, (stagePoints.get(pid) || 0) + points);
            }
          }
        }
      }
      // Одна заявка на рассадку записывается целиком, а игровые базы подхватывают её по ревизии.
      const occupied = new Map();
      for (const game of tournamentGames) {
        const seats = targets.get(game.id) ?? states.get(game.id)?.seats.map(seat => seat.pid) ?? [];
        const round = occupied.get(game.round) ?? new Map();
        for (const pid of seats.filter(Boolean)) {
          const other = round.get(pid);
          if (other && (targets.has(game.id) || targets.has(other))) fail('Игрок указан за несколькими столами тура ' + game.stageRound + '.');
          round.set(pid, game.id);
        }
        occupied.set(game.round, round);
      }
      transaction(() => {
        for (const [game, seats] of targets) savePlacement.run(game, JSON.stringify(seats));
      });
      return { placed: targets.size, skipped, ...(waitingForResults ? { waitingForResults } : {}) };
    },
    removeUnfinished(tid, list, readState) {
      openPlan(tid);
      const drafts = list.filter(game => game.status !== 'finished' && !readState(game.id, tid)?.winner);
      if (drafts.some(game => {
        const state = readState(game.id, tid);
        return [state?.timer, state?.wait].some(timer => timer?.running && timer.endAt > Date.now());
      })) fail('Сначала остановите таймеры в незавершённых играх.', 409);
      transaction(() => {
        for (const game of drafts) {
          detachStream.run(game.id);
          deleteGame.run(game.id);
        }
      });
      return drafts.map(game => game.id);
    },
  };
}

function remember(seats, pairs, places) {
  seats.forEach((pid, index) => {
    if (!pid) return;
    const seatKey = pid + ':' + index;
    places.set(seatKey, (places.get(seatKey) ?? 0) + 1);
    for (const other of seats.slice(0, index).filter(Boolean)) {
      const key = pairKey(pid, other);
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
  });
}

function shuffle(order) {
  for (let i = order.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function arrange(games, players, setup, history, seatsUsed, swiss, fixed) {
  const index = new Map(players.map((pid, i) => [pid, i]));
  const judges = new Map(setup.judges.map(judge => [judge.id, judge.table]));
  const included = pid => index.has(pid) || fixed.has(pid);
  const rules = setup.pairs.filter(pair => included(pair.player) && (!pair.opponent || included(pair.opponent)) &&
    (index.has(pair.player) || index.has(pair.opponent)));
  const hardRules = rules.filter(pair => pair.rule !== 'minimize');
  const byMember = new Map(players.map(pid => [pid, hardRules.filter(pair => pair.player === pid || pair.opponent === pid)]));
  const table = i => games[Math.floor(i / 10)].table;
  const repeats = (pid, i) => seatsUsed.get(pid + ':' + i) ?? 0;
  const positionCost = order => order.reduce((cost, pid, i) => cost + repeats(pid, i), 0);
  let best = null;
  let bestCost = Infinity;
  const attempts = swiss && !rules.length ? 1 : 48;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const order = [...players];
    if (attempt > 0 || !swiss) {
      shuffle(order);
      if (swiss) {
        const offsets = new Map(order.map((pid, i) => [pid, i]));
        order.sort((a, b) => (index.get(a) + offsets.get(a) / 2) - (index.get(b) + offsets.get(b) / 2));
      }
    }
    const slots = new Map(order.map((pid, i) => [pid, i]));
    const tableOf = pid => fixed.get(pid) ?? table(slots.get(pid));
    const together = pair => tableOf(pair.player) === (pair.opponent ? tableOf(pair.opponent) : judges.get(pair.judge));
    const broken = pair => together(pair) !== (pair.rule === 'together');
    const swap = (a, b) => {
      const i = slots.get(a), j = slots.get(b);
      [order[i], order[j]] = [b, a];
      slots.set(a, j);
      slots.set(b, i);
    };
    // Меняем по два места за раз, чтобы исправление одного ограничения не создавало цепочку новых нарушений.
    for (let step = 0; step < Math.min(48, hardRules.length * 2); step++) {
      const violation = hardRules.find(broken);
      if (!violation) break;
      const members = [violation.player, violation.opponent].filter(pid => index.has(pid));
      let fix;
      for (const a of members) {
        for (const b of shuffle([...players])) {
          if (tableOf(a) === tableOf(b)) continue;
          const affected = [...new Set([...byMember.get(a), ...byMember.get(b)])];
          const before = affected.filter(broken).length;
          swap(a, b);
          const improved = affected.filter(broken).length < before;
          swap(a, b);
          if (improved) { fix = [a, b]; break; }
        }
        if (fix) break;
      }
      if (!fix) break;
      swap(...fix);
    }
    if (hardRules.some(broken)) continue;
    let cost = rules.filter(pair => pair.rule === 'minimize' && together(pair)).length * 200;
    order.forEach((pid, i) => {
      const tableStart = i - i % 10;
      cost += repeats(pid, i % 10) * 2;
      if (swiss) cost += Math.abs(Math.floor(index.get(pid) / 10) - Math.floor(i / 10)) * 25;
      for (const other of order.slice(tableStart, i)) cost += history.get(pairKey(pid, other)) ?? 0;
    });
    if (cost < bestCost) {
      bestCost = cost;
      best = games.map((game, i) => order.slice(i * 10, i * 10 + 10));
    }
  }
  return best?.map(seats => {
    let order = seats;
    let cost = positionCost(order);
    for (let attempt = 0; attempt < 16 && cost > 0; attempt++) {
      const candidate = shuffle([...seats]);
      const value = positionCost(candidate);
      if (value < cost) { order = candidate; cost = value; }
    }
    return order;
  });
}

function pairStats(games, readState) {
  const pairs = new Map();
  const places = new Map();
  for (const game of games) remember(readState(game.id)?.seats.map(seat => seat.pid) ?? [], pairs, places);
  const counts = new Map();
  for (const meetings of pairs.values()) counts.set(meetings, (counts.get(meetings) ?? 0) + 1);
  return [...counts].sort((a, b) => b[0] - a[0]);
}

module.exports = { tournamentWorkflow, pairStats };
