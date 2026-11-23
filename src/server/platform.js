const { InputError, isKey } = require('./catalog');
const { sameOrigin } = require('./transport');
const { pairStats } = require('./tournament');

const KEY = '([a-f0-9]{32})';
const routes = {
  game: new RegExp('^/api/games/' + KEY + '$'),
  rating: new RegExp('^/api/ratings/' + KEY + '$'),
  ratingGames: new RegExp('^/api/ratings/' + KEY + '/games$'),
  tournament: new RegExp('^/api/tournaments/' + KEY + '$'),
  tournamentInfo: new RegExp('^/api/tournaments/' + KEY + '/info$'),
  tournamentAdmin: new RegExp('^/api/tournaments/' + KEY + '/admin(?:/(stage|judge|pair|create|place|confirm|remove-unfinished|calculate|finalize|reopen))?$'),
  participants: new RegExp('^/api/tournaments/' + KEY + '/participants$'),
  participant: new RegExp('^/api/tournaments/' + KEY + '/participants/' + KEY + '$'),
  photo: new RegExp('^/api/tournaments/' + KEY + '/participants/' + KEY + '/photos/(default|civ|sheriff|mafia|don)$'),
  design: new RegExp('^/api/tournaments/' + KEY + '/design$'),
  stream: new RegExp('^/api/tournaments/' + KEY + '/streams/(\\d{1,4})$'),
  publicGame: new RegExp('^/api/public/games/' + KEY + '$'),
  publicTournament: new RegExp('^/api/public/tournaments/' + KEY + '$'),
  publicStream: new RegExp('^/api/streams/' + KEY + '/(\\d{1,4})$'),
};

function json(response, status, data, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', ...headers,
  }).end(JSON.stringify(data));
}

async function readJson(request, maxSize = 16384) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new InputError('Ожидается JSON.', 415);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxSize) throw new InputError('Слишком большой запрос.', 413);
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new InputError('Некорректные данные.');
  return data;
}

const roundPoints = points => Math.round(points * 100) / 100;
function scores(seat) {
  const [first = 0, second = 0] = seat.techFouls || [];
  return {
    bonus: seat.bonus, penalty: seat.pen,
    tech: first ? (first + second * 2) / 10 : seat.tech,
  };
}
function scoreResult(seat, winner, coefficient = 1) {
  const team = ['mafia', 'don'].includes(seat.role) ? 'black' : 'red';
  const won = team === winner;
  const components = scores(seat);
  return { won, total: roundPoints((Number(won) + components.bonus - components.penalty - components.tech) * coefficient) };
}
function standings(roster, games, readState) {
  const rows = new Map(roster.map(player => [player.id, { id: player.id, nick: player.nick, active: player.active, games: 0, wins: 0, points: 0 }]));
  for (const game of games) {
    if (game.status !== 'finished') continue;
    const state = readState(game.id);
    if (!state?.winner) continue;
    const counted = new Set();
    for (const seat of state.seats) {
      const row = rows.get(seat.pid);
      if (!row || counted.has(seat.pid)) continue;
      counted.add(seat.pid);
      const { won, total } = scoreResult(seat, state.winner, game.coefficient);
      row.games++;
      row.wins += Number(won);
      row.points = roundPoints(row.points + total);
    }
  }
  return [...rows.values()].filter(row => row.active || row.games).map(({ active, ...row }) => row)
    .sort((a, b) => b.points - a.points || b.wins - a.wins || a.nick.localeCompare(b.nick, 'ru'));
}
const judgeLink = (id, state) => '/games/' + id + '/judge#' + state.judge.room;
function gameSeats(state, protocol, result = '', coefficient = 1) {
  const names = new Map(state.roster.map(player => [player.id, player.nick]));
  return state.seats.flatMap((seat, i) => {
    if (!seat.pid) return [];
    const row = { no: i + 1, nick: names.get(seat.pid) || '' };
    if (!protocol) return [row];
    const details = { ...row, role: seat.role, fouls: seat.fouls, ...scores(seat) };
    if (result) details.total = scoreResult(seat, result, coefficient).total;
    return [details];
  });
}
function gameDetails(game, readState, internal) {
  const state = readState(game.id, game.tournamentId);
  if (!state) throw new InputError('Данные игры недоступны.', 404);
  const finished = game.status === 'finished' && Boolean(state.winner);
  const protocol = internal || finished && game.showProtocol;
  const killed = new Set(state.nights.map(night => night.shot));
  const alive = state.seats.filter((seat, i) => seat.pid && seat.status === 'alive' && seat.fouls < 4 &&
    seat.techFouls?.length !== 2 && !killed.has(String(i))).length;
  return {
    ...game, day: state.days.length, alive, winner: internal || finished ? state.winner : '',
    seats: gameSeats(state, protocol, finished ? state.winner : '', game.coefficient),
    ...(protocol ? {
      notes: state.notes, nights: state.nights, deathReports: state.deathReports,
      bestMoves: { first: { player: state.lhPu || state.nights.find(night => night.shot)?.shot || '', picks: state.lh }, second: state.lhExtra },
      days: state.days.map(({ noms, revote, out, stage }) => ({ noms, revote, out, stage })),
    } : {}),
    ...(internal ? { links: {
      judge: judgeLink(game.id, state),
      ...(game.tournamentId ? {
        panel: '/games/' + game.id, overlay: '/games/' + game.id + '/hud#' + state.judge.hud, watch: '/watch/games/' + game.id,
      } : {}),
    } } : {}),
  };
}

function createPlatform({ catalog, access, clientAddress, secure, initialize, readState, refreshTournament, closeGames }) {
  const decorateGame = game => game.tournamentId
    ? catalog.workflow.games(game.tournamentId, [game])[0] : game;
  function withJudge(game) {
    const state = game.status !== 'finished' && readState(game.id, game.tournamentId);
    return state ? { ...game, judge: judgeLink(game.id, state) } : game;
  }
  function ratingDetails(id) {
    const rating = catalog.requireRating(id);
    const games = catalog.ratingGames(id).map(game => {
      const state = readState(game.id);
      if (!state) throw new InputError('Данные игры недоступны.', 404);
      const winner = state.winner;
      return { ...game, status: winner ? 'finished' : game.status, winner,
        seats: gameSeats(state, Boolean(winner), winner), judge: judgeLink(game.id, state) };
    });
    return { ...rating, games };
  }
  function tournamentDetails(id, internal) {
    const tournament = catalog.requireTournament(id);
    const setup = catalog.workflow.plan(id);
    const all = catalog.workflow.games(id, catalog.tournamentGames(id), setup);
    const games = all.filter(game => internal || game.published);
    if (!internal && !games.length) throw new InputError('Публичные игры турнира пока недоступны.', 404);
    const snapshots = new Map();
    const lookup = id => {
      if (!snapshots.has(id)) snapshots.set(id, readState(id, tournament.id));
      return snapshots.get(id);
    };
    const published = !internal && new Set(games.flatMap(({ id }) => lookup(id)?.seats.map(seat => seat.pid) || []));
    const history = catalog.historicalRoster(id).filter(player => internal || published.has(player.id));
    const final = internal || games.length === all.length ? setup.final : null;
    const table = final?.rows ?? standings(history, games, lookup);
    if (!internal) return { ...tournament, games, finalizedAt: final?.at ?? null,
      standings: table.map(({ id, ...row }) => row) };
    const photos = catalog.photoSlots(id);
    return {
      ...tournament,
      games: games.map(game => {
        const state = lookup(game.id);
        if (!state) return { ...game, winner: '', seats: [] };
        const winner = game.status === 'finished' ? state.winner : '';
        return { ...game, winner, seats: gameSeats(state, Boolean(winner), winner, game.coefficient),
          seating: state.seats.map(seat => seat.pid),
          judge: judgeLink(game.id, state), overlay: '/games/' + game.id + '/hud#' + state.judge.hud };
      }),
      standings: table,
      roster: catalog.workflow.roster(id, catalog.roster(id)).map(player => ({ ...player, photos: photos.get(player.id) ?? [] })),
      streams: catalog.streams(id),
      design: catalog.design(id),
      info: catalog.info(id),
      stages: setup.stages,
      finalizedAt: final?.at ?? null,
    };
  }
  function tournamentAdmin(id, action, data) {
    catalog.requireTournament(id);
    const workflow = catalog.workflow;
    const setup = workflow.plan(id);
    const list = catalog.tournamentGames(id);
    const players = catalog.roster(id);
    const games = workflow.games(id, list, setup);
    const lookup = game => readState(game, id);
    if (!action) return { stages: setup.stages, judges: setup.judges, pairs: setup.pairs,
      finalizedAt: setup.final?.at ?? null, pairStats: pairStats(games, lookup) };
    if (['stage', 'judge', 'pair'].includes(action)) {
      workflow.updateSetup(id, action, data, list, players);
      return { ok: true };
    }
    if (action === 'create') return workflow.createGames(id, data.stageId, list, game => catalog.createGame(game, initialize));
    if (action === 'confirm') {
      workflow.openPlan(id);
      const registered = workflow.roster(id, players);
      workflow.transaction(() => {
        for (const player of registered) workflow.saveRegistration({ ...player, confirmed: true });
      });
      return { confirmed: registered.length };
    }
    if (action === 'remove-unfinished') {
      const removed = workflow.removeUnfinished(id, list, readState);
      closeGames(removed);
      return { removed: removed.length };
    }
    if (action === 'place') {
      const ranking = standings(catalog.historicalRoster(id), games, lookup).sort((a, b) => Number(!!b.games) - Number(!!a.games)).map(row => row.id);
      const result = workflow.place(id, data, list, players, readState, ranking,
        (game, state) => state?.seats.filter(seat => seat.pid).map(seat =>
          [seat.pid, scoreResult(seat, state.winner, game.coefficient).total]) ?? []);
      if (result.placed) refreshTournament(id, { seating: true });
      return result;
    }
    if (action === 'reopen') {
      workflow.save(id, { ...setup, final: null });
      return { ok: true };
    }
    const table = standings(catalog.historicalRoster(id), games, lookup);
    if (action === 'calculate') return { standings: table };
    workflow.openPlan(id);
    const finalStages = new Set(setup.stages.filter(stage => stage.final).map(stage => stage.id));
    const finalRound = standings(catalog.historicalRoster(id), games.filter(game => finalStages.has(game.stageId)), lookup);
    const finalists = new Map(finalRound.filter(row => row.games).map((row, i) => [row.id, i]));
    const rows = table.filter(row => row.games)
      .sort((a, b) => (finalists.get(a.id) ?? table.length) - (finalists.get(b.id) ?? table.length))
      .map((row, i) => ({ ...row, place: i + 1 }));
    if (!rows.length || games.some(game => game.status !== 'finished' || !lookup(game.id)?.winner)) {
      throw new InputError('Завершите игры или удалите незавершённые перед фиксацией мест.', 409);
    }
    workflow.save(id, { ...setup, final: { at: Date.now(), rows } });
    return { standings: rows };
  }
  return async function platform(request, response, pathname) {
    const method = request.method;
    const supplied = request.headers.origin;
    if (method !== 'GET' && supplied !== undefined && !sameOrigin(request)) {
      return json(response, 403, { error: 'Недопустимый источник запроса.' });
    }
    try {
      if (!catalog) throw new InputError('Укажите пароль организатора в настройках сервера.', 503);
      let match;
      let result;
      let status = 200;
      if (method === 'POST' && pathname === '/api/session') {
        const { key } = await readJson(request);
        const refused = access.refuse('host', { key }, clientAddress(request));
        if (refused === 4429) throw new InputError('Слишком много попыток. Повторите через минуту.', 429);
        if (refused) throw new InputError('Неверный пароль.', 401);
        const { session, sessionMs } = access.credentials();
        const cookie = 'mafia_session=' + session + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + Math.floor(sessionMs / 1000) +
          (secure(request) ? '; Secure' : '');
        return json(response, 200, { ok: true }, { 'set-cookie': cookie });
      }
      if (method === 'GET' && (match = routes.publicGame.exec(pathname))) {
        const game = catalog.requireGame(match[1]);
        if (!game.tournamentId || !game.published) throw new InputError('Игра не опубликована.', 404);
        result = gameDetails(decorateGame(game), readState, false);
      } else if (method === 'GET' && (match = routes.publicTournament.exec(pathname))) {
        result = tournamentDetails(match[1], false);
      } else if (method === 'GET' && (match = routes.publicStream.exec(pathname))) {
        const stream = catalog.stream(match[1], +match[2]);
        const token = request.headers.authorization?.slice(7);
        if (!stream || !isKey(token) || request.headers.authorization !== 'Bearer ' + stream.token) {
          throw new InputError('Ссылка на оверлей недействительна.', 404);
        }
        const state = stream.game_id && readState(stream.game_id);
        result = { source: state ? '/games/' + stream.game_id + '/hud#' + state.judge.hud : null };
      } else {
        if (!access.authorized(request)) throw new InputError('Войдите как организатор.', 401);
        if (method === 'DELETE' && pathname === '/api/session') {
          return json(response, 200, { ok: true }, { 'set-cookie': 'mafia_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
        }
        if (method === 'GET' && pathname === '/api/dashboard') {
          result = { games: catalog.games().map(withJudge), tournaments: catalog.tournaments(), ratings: catalog.ratings() };
        } else if (method === 'GET' && pathname === '/api/tournaments') {
          result = catalog.tournaments();
        } else if (method === 'GET' && pathname === '/api/ratings') {
          result = catalog.ratings();
        } else if (method === 'POST' && pathname === '/api/tournaments') {
          result = catalog.createTournament(await readJson(request));
          status = 201;
        } else if (method === 'POST' && pathname === '/api/ratings') {
          result = catalog.createRating(await readJson(request));
          status = 201;
        } else if (method === 'GET' && (match = routes.rating.exec(pathname))) {
          result = ratingDetails(match[1]);
        } else if (method === 'POST' && (match = routes.ratingGames.exec(pathname))) {
          result = catalog.createGame(await readJson(request), initialize, match[1]);
          status = 201;
        } else if ((match = routes.game.exec(pathname)) && ['GET', 'PATCH'].includes(method)) {
          const game = catalog.requireGame(match[1]);
          if (method === 'PATCH') {
            const data = await readJson(request);
            if (!game.tournamentId && ['published', 'showProtocol', 'video'].some(field => field in data)) {
              throw new InputError('Публикация эфира доступна для турнирных игр.');
            }
            catalog.updateGame(game.id, data, readState(game.id)?.winner);
          }
          result = gameDetails(decorateGame(catalog.requireGame(game.id)), readState, true);
        } else if (method === 'GET' && (match = routes.tournament.exec(pathname))) {
          result = tournamentDetails(match[1], true);
        } else if (method === 'PATCH' && (match = routes.tournamentInfo.exec(pathname))) {
          result = catalog.updateInfo(match[1], await readJson(request));
        } else if ((match = routes.tournamentAdmin.exec(pathname)) && method === (match[2] ? 'POST' : 'GET')) {
          result = tournamentAdmin(match[1], match[2], match[2] ? await readJson(request, match[2] === 'place' ? 2 * 1024 * 1024 : 16384) : {});
        } else if (method === 'POST' && (match = routes.participants.exec(pathname))) {
          result = catalog.addParticipant(match[1], await readJson(request, 512 * 1024));
          refreshTournament(match[1], { roster: true });
          status = 201;
        } else if (method === 'DELETE' && (match = routes.participants.exec(pathname))) {
          catalog.removeParticipants(match[1]);
          refreshTournament(match[1], { roster: true });
          result = { ok: true };
        } else if ((match = routes.participant.exec(pathname)) && ['PATCH', 'DELETE'].includes(method)) {
          const [, id, pid] = match;
          if (method === 'PATCH') result = catalog.updateParticipant(id, pid, await readJson(request));
          else {
            catalog.removeParticipants(id, pid);
            result = { ok: true };
          }
          refreshTournament(id, { roster: true });
        } else if ((match = routes.photo.exec(pathname)) && ['GET', 'PUT', 'DELETE'].includes(method)) {
          const [, id, pid, slot] = match;
          const key = pid + (slot === 'default' ? '' : '.' + slot);
          if (method === 'GET') {
            const photo = catalog.photo(id, key);
            if (!photo) throw new InputError('Фото не найдено.', 404);
            const separator = photo.indexOf(',');
            const type = photo.slice(5, separator - 7).toLowerCase();
            return response.writeHead(200, {
              'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
            }).end(Buffer.from(photo.slice(separator + 1), 'base64'));
          }
          const photo = method === 'PUT' ? (await readJson(request, 1024 * 1024 + 512)).data : null;
          catalog.setPhoto(id, pid, slot, photo);
          refreshTournament(id, { photo: key });
          result = { ok: true };
        } else if ((match = routes.design.exec(pathname)) && ['PUT', 'DELETE'].includes(method)) {
          const [, id] = match;
          catalog.setDesign(id, method === 'PUT' ? await readJson(request) : null);
          refreshTournament(id, {});
          result = { ok: true };
        } else if (method === 'PUT' && (match = routes.stream.exec(pathname))) {
          catalog.moveStream(match[1], +match[2], (await readJson(request)).gameId);
          result = { ok: true };
        } else {
          throw new InputError('Страница не найдена.', 404);
        }
      }
      return json(response, status, result);
    } catch (error) {
      if (error instanceof InputError) return json(response, error.status, { error: error.message });
      console.error('Ошибка приложения:', error.message);
      return json(response, 500, { error: 'Не удалось обработать запрос.' });
    }
  };
}

module.exports = { createPlatform };
