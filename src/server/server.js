const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { isIP } = require('node:net');
const { createGame, withTournamentRoster, withTournamentSeating } = require('./game');
const { readSnapshot } = require('./store');
const { openCatalog } = require('./catalog');
const { createChannel } = require('./channel');
const { createAccess, CLOSE_NO_ROOM } = require('./access');
const { attachTransport } = require('./transport');
const { createPlatform } = require('./platform');

const PORT = +process.env.PORT || 8787;
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const SECRET = process.env.JUDGE_SECRET || '';
const TRUST_PROXY = process.env.HUD_TRUST_CADDY === '1';
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const RULES = path.join(CLIENT_DIR, 'rules.js');
const GAME_ROUTE = /^\/games\/([a-f0-9]{32})(?:\/(panel|judge|hud|win-civilians|win-mafia))?$/;
const APP_ROUTE = /^\/(?:ratings(?:\/[a-f0-9]{32})?\/?|watch\/tournaments\/[a-f0-9]{32})$/;
const TOURNAMENT_ROUTE = /^\/tournaments(?:\/([a-f0-9]{32})(?:\/(?:games(?:\/([a-f0-9]{32}))?|standings|participants|admin|operator|design|streams))?)?\/?$/;
const WATCH_GAME_ROUTE = /^\/watch\/games\/([a-f0-9]{32})$/;
const STREAM_ROUTE = /^\/stream\/[a-f0-9]{32}\/\d{1,4}$/;
const ASSETS = new Set(['style.css', 'rules.js', 'client.js', 'operator-tools.js', 'state.js', 'timer.js', 'screen.js', 'panel.js',
  'app-theme.css', 'platform.css', 'platform.js', 'tournament-admin.js', 'platform-stream.js']);
const catalog = SECRET ? openCatalog(DATA_DIR) : null;
const access = createAccess(SECRET);
const channels = new Map();
const gameDir = id => path.join(DATA_DIR, 'games', id);
function tournamentPlacement(tournamentId, gameId, applied) {
  const placement = catalog.workflow.placement(gameId);
  if (!placement || placement.revision <= applied) return;
  const seated = new Set(placement.seats);
  return { ...placement, players: catalog.historicalRoster(tournamentId)
    .filter(player => seated.has(player.id)).map(({ id, nick, mu }) => ({ id, nick, mu })) };
}
function readState(id, tournamentId = null) {
  const live = channels.get(id);
  if (live) return live.game.state();
  const state = readSnapshot(gameDir(id));
  if (!state || !tournamentId) return state;
  const placement = tournamentPlacement(tournamentId, id, state.tournamentSeatingRevision ?? 0);
  const roster = withTournamentRoster(state, catalog.rosterChanges(tournamentId, state.tournamentRosterRevision ?? 0), placement);
  return withTournamentSeating(roster, placement);
}

function initialize(id, { title, roster = [], seating = [], number, tournamentRosterRevision }) {
  const game = createGame(gameDir(id), RULES, { fixedGameNumber: number });
  try { game.open({ title, roster, seating, tournamentRosterRevision }); }
  finally { game.close(); }
}

function channelFor({ id, tournamentId, ratingId, number }) {
  if (!channels.has(id)) {
    const tournament = tournamentId ? {
      design: () => catalog.design(tournamentId),
      photo: key => catalog.photo(tournamentId, key),
      rosterChanges: revision => catalog.rosterChanges(tournamentId, revision),
      placement: applied => tournamentPlacement(tournamentId, id, applied),
    } : undefined;
    const game = createGame(gameDir(id), RULES, { judgeSeating: !tournamentId, fixedGameNumber: number, tournament });
    try { game.syncTournamentRoster(); }
    catch (error) { game.close(); throw error; }
    channels.set(id, createChannel(game, access, { tournamentId, ratingId },
      (winner, started) => catalog.syncGameStatus(id, winner, started)));
  }
  const channel = channels.get(id);
  channel.touch();
  return channel;
}

function clientAddress(request) {
  const forwarded = request.headers['x-hud-client-ip'];
  return TRUST_PROXY && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : request.socket.remoteAddress;
}
const secure = request => Boolean(request.socket.encrypted || TRUST_PROXY && request.headers['x-forwarded-proto'] === 'https');
function refreshTournament(id, change) {
  for (const channel of channels.values()) {
    if (channel.scope.tournamentId === id) channel.refreshTournament(change);
  }
}
function closeGames(ids) {
  for (const id of ids) {
    channels.get(id)?.close();
    channels.delete(id);
  }
}
const platform = createPlatform({ catalog, access, clientAddress, secure, initialize, readState, refreshTournament, closeGames });

function connected(socket, request) {
  const url = new URL(request.url, 'http://local');
  const role = url.searchParams.get('role');
  const id = url.searchParams.get('game');
  if (!['host', 'judge', 'screen'].includes(role)) return socket.close(1008);
  const timer = setTimeout(() => socket.close(1008), 5000).unref();
  socket.once('close', () => clearTimeout(timer));
  socket.once('message', (data, binary) => {
    clearTimeout(timer);
    if (binary || data.length > 4096) return socket.close(1008);
    try {
      const message = JSON.parse(data.toString());
      if (message?.kind !== 'auth') return socket.close(1008);
      const auth = role === 'host' && message.key === undefined && message.session === undefined
        ? { session: access.requestSession(request) } : message;
      const room = /^[a-f0-9]{32}$/.test(id || '') && catalog?.game(id);
      if (role === 'screen' && !room?.tournamentId) return socket.close(CLOSE_NO_ROOM);
      const rooms = room && role !== 'host' ? readState(id)?.judge : null;
      const refused = access.refuse(role, auth, clientAddress(request), rooms ? { rooms: () => rooms } : null);
      if (refused || !room || (role === 'host' && !room.tournamentId)) return socket.close(refused || CLOSE_NO_ROOM);
      channelFor(room).connected(socket, role, auth);
    } catch (error) {
      console.error('Не удалось открыть игровое подключение:', error.message);
      socket.close(1011);
    }
  });
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];
  if (pathname.startsWith('/api/')) return void platform(req, res, pathname);
  if (req.method !== 'GET') return res.writeHead(404).end();
  const game = GAME_ROUTE.exec(pathname);
  const tournament = TOURNAMENT_ROUTE.exec(pathname);
  const watchGame = WATCH_GAME_ROUTE.exec(pathname);
  const asset = pathname.startsWith('/assets/') ? pathname.slice('/assets/'.length) : '';
  let name;
  if (ASSETS.has(asset)) name = asset;
  else if (pathname === '/' || APP_ROUTE.test(pathname)) name = 'platform.html';
  else if (tournament && (!tournament[2] || catalog?.game(tournament[2])?.tournamentId === tournament[1])) name = 'platform.html';
  else if (watchGame && catalog?.game(watchGame[1])?.tournamentId) name = 'platform.html';
  else if (catalog && STREAM_ROUTE.test(pathname)) name = 'platform-stream.html';
  else if (game) {
    const entry = catalog?.game(game[1]);
    if (entry) {
      if (game[2] === 'judge') name = 'judge.html';
      else if (entry.tournamentId) name = 'mafia-hud.html';
      else if (!game[2] || game[2] === 'panel') name = 'platform.html';
    }
  }
  if (!name) return res.writeHead(404).end();
  const mime = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html';
  res.writeHead(200, {
    'content-type': mime + '; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  fs.createReadStream(path.join(CLIENT_DIR, name)).on('error', error => res.destroy(error)).pipe(res);
});

attachTransport(server, clientAddress, connected);
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, channel] of channels) {
    if (channel.idle(now)) {
      channel.close();
      channels.delete(id);
    }
  }
}, 30000).unref();
server.on('close', () => {
  clearInterval(cleanup);
  for (const channel of channels.values()) channel.close();
  catalog?.close();
});
server.listen(PORT, BIND_HOST, () => console.log(`Сервер мафии запущен: http://${BIND_HOST}:${PORT}`));
