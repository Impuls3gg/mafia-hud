const { randomBytes } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { validPhoto } = require('./store');
const { validDesign } = require('./state');
const { tournamentWorkflow } = require('./tournament');

const key = () => randomBytes(16).toString('hex');
const isKey = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const stages = ['draft', 'live', 'finished'];
const infoFields = ['dates', 'club', 'organizer', 'chiefJudge', 'region', 'venue', 'fee'];

class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function title(value, label) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > 120) throw new InputError(label + ': от 1 до 120 символов.');
  return result;
}

function video(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 1024) throw new InputError('Укажите HTTPS-ссылку на YouTube, MP4 или WebM.');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
    const youtube = ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com'];
    let id;
    if (url.hostname === 'youtu.be') id = url.pathname.split('/')[1];
    if (youtube.includes(url.hostname)) id = url.searchParams.get('v') || url.pathname.split('/')[2];
    if (/^[\w-]{11}$/.test(id || '')) return 'https://www.youtube-nocookie.com/embed/' + id;
    if (/\.(mp4|webm)$/i.test(url.pathname)) return url.href;
  } catch {}
  throw new InputError('Укажите HTTPS-ссылку на YouTube, MP4 или WebM.');
}

const summarizeGame = row => ({
  id: row.id, title: row.title, tournamentId: row.tournament_id, round: row.round, table: row.table_no,
  ratingId: row.rating_id, number: row.number,
  status: row.status, published: Boolean(row.published), showProtocol: Boolean(row.show_protocol),
  video: row.video, createdAt: row.created_at,
});
const summarizeTournament = row => ({
  id: row.id, title: row.title, createdAt: row.created_at,
});
const summarizeRating = row => ({ id: row.id, title: row.title, createdAt: row.created_at });

function openCatalog(dir) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'platform.sqlite'));
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS tournaments (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY, tournament_id TEXT NOT NULL REFERENCES tournaments(id), nick TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS participant_profiles (
      id TEXT PRIMARY KEY REFERENCES participants(id), mu TEXT NOT NULL,
      active INTEGER NOT NULL, revision INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS tournament_photos (
      participant_id TEXT NOT NULL REFERENCES participants(id), slot TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (participant_id, slot)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS tournament_designs (
      id TEXT PRIMARY KEY REFERENCES tournaments(id), settings TEXT NOT NULL CHECK (json_valid(settings))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS tournament_info (
      id TEXT PRIMARY KEY REFERENCES tournaments(id), details TEXT NOT NULL CHECK (json_valid(details))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL,
      tournament_id TEXT REFERENCES tournaments(id), round INTEGER, table_no INTEGER,
      status TEXT NOT NULL DEFAULT 'draft', published INTEGER NOT NULL DEFAULT 0,
      show_protocol INTEGER NOT NULL DEFAULT 0, video TEXT NOT NULL DEFAULT '',
      UNIQUE (tournament_id, round, table_no)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS streams (
      tournament_id TEXT NOT NULL REFERENCES tournaments(id), table_no INTEGER NOT NULL,
      token TEXT NOT NULL, game_id TEXT REFERENCES games(id),
      PRIMARY KEY (tournament_id, table_no)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS ratings (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL,
      next_number INTEGER NOT NULL DEFAULT 1 CHECK (next_number > 0)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS rating_games (
      rating_id TEXT NOT NULL REFERENCES ratings(id),
      game_id TEXT NOT NULL UNIQUE REFERENCES games(id),
      number INTEGER NOT NULL CHECK (number > 0),
      PRIMARY KEY (rating_id, number)
    ) STRICT;
  `);
  const workflow = tournamentWorkflow(db, InputError);
  const allGames = 'SELECT games.*, rating_games.rating_id, rating_games.number FROM games LEFT JOIN rating_games ON games.id = rating_games.game_id';
  const query = Object.fromEntries(Object.entries({
    game: allGames + ' WHERE games.id = ?',
    games: allGames + ' ORDER BY games.created_at DESC, games.id',
    roundGames: allGames + ' WHERE games.tournament_id = ? ORDER BY games.round, games.table_no',
    ratingGames: allGames + ' WHERE rating_games.rating_id = ? ORDER BY rating_games.number DESC',
    occupiedTable: 'SELECT 1 FROM games WHERE tournament_id = ? AND round = ? AND table_no = ?',
    addGame: 'INSERT INTO games (id, title, created_at, tournament_id, round, table_no) VALUES (?, ?, ?, ?, ?, ?)',
    updateGame: 'UPDATE games SET status = ?, published = ?, show_protocol = ?, video = ? WHERE id = ?',
    finishGame: "UPDATE games SET status = 'finished' WHERE id = ? AND status <> 'finished'",
    startGame: "UPDATE games SET status = 'live' WHERE id = ? AND status <> 'live'",
    reopenGame: "UPDATE games SET status = 'live' WHERE id = ? AND status = 'finished'",
    tournament: 'SELECT * FROM tournaments WHERE id = ?',
    tournaments: 'SELECT * FROM tournaments ORDER BY created_at DESC, id',
    addTournament: 'INSERT INTO tournaments (id, title, created_at) VALUES (?, ?, ?)',
    rating: 'SELECT * FROM ratings WHERE id = ?',
    ratings: 'SELECT * FROM ratings ORDER BY created_at DESC, id',
    addRating: 'INSERT INTO ratings (id, title, created_at) VALUES (?, ?, ?)',
    nextRatingNumber: 'UPDATE ratings SET next_number = next_number + 1 WHERE id = ? RETURNING next_number - 1 AS number',
    addRatingGame: 'INSERT INTO rating_games (rating_id, game_id, number) VALUES (?, ?, ?)',
    roster: `SELECT p.id, p.nick, coalesce(f.mu, '') AS mu, coalesce(f.active, 1) AS active
      FROM participants p LEFT JOIN participant_profiles f ON f.id = p.id
      WHERE p.tournament_id = ? ORDER BY lower(p.nick), p.id`,
    rosterChanges: `SELECT p.id, p.nick, f.mu, f.active, f.revision
      FROM participant_profiles f JOIN participants p ON p.id = f.id
      WHERE p.tournament_id = ? AND f.revision > ? ORDER BY f.revision`,
    rosterRevision: `SELECT coalesce(max(f.revision), 0) AS revision FROM participant_profiles f
      JOIN participants p ON p.id = f.id WHERE p.tournament_id = ?`,
    addParticipant: 'INSERT INTO participants (id, tournament_id, nick) VALUES (?, ?, ?)',
    renameParticipant: 'UPDATE participants SET nick = ? WHERE id = ?',
    profile: `INSERT INTO participant_profiles (id, mu, active, revision) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET mu = excluded.mu, active = excluded.active, revision = excluded.revision`,
    photos: `SELECT p.id, f.slot FROM tournament_photos f JOIN participants p ON p.id = f.participant_id
      WHERE p.tournament_id = ?`,
    photo: `SELECT f.data FROM tournament_photos f JOIN participants p ON p.id = f.participant_id
      WHERE p.tournament_id = ? AND p.id = ? AND f.slot = ?`,
    photoSize: `SELECT coalesce(sum(length(f.data)), 0) AS size FROM tournament_photos f
      JOIN participants p ON p.id = f.participant_id WHERE p.tournament_id = ?`,
    setPhoto: `INSERT INTO tournament_photos (participant_id, slot, data) VALUES (?, ?, ?)
      ON CONFLICT(participant_id, slot) DO UPDATE SET data = excluded.data`,
    deletePhoto: 'DELETE FROM tournament_photos WHERE participant_id = ? AND slot = ?',
    design: 'SELECT settings FROM tournament_designs WHERE id = ?',
    setDesign: `INSERT INTO tournament_designs (id, settings) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET settings = excluded.settings`,
    deleteDesign: 'DELETE FROM tournament_designs WHERE id = ?',
    info: 'SELECT details FROM tournament_info WHERE id = ?',
    setInfo: `INSERT INTO tournament_info (id, details) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET details = excluded.details`,
    renameTournament: 'UPDATE tournaments SET title = ? WHERE id = ?',
    stream: 'SELECT table_no, token, game_id FROM streams WHERE tournament_id = ? AND table_no = ?',
    streams: 'SELECT table_no, token, game_id FROM streams WHERE tournament_id = ? ORDER BY table_no',
    addStream: 'INSERT INTO streams (tournament_id, table_no, token) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
    moveStream: 'UPDATE streams SET game_id = ? WHERE tournament_id = ? AND table_no = ?',
  }).map(([name, sql]) => [name, db.prepare(sql)]));
  const findGame = id => {
    const row = query.game.get(id);
    return row ? summarizeGame(row) : null;
  };
  const findTournament = id => {
    const row = query.tournament.get(id);
    return row ? summarizeTournament(row) : null;
  };
  const requireRating = id => {
    const row = query.rating.get(id);
    return row ? summarizeRating(row) : missing('Рейтинг не найден.');
  };
  const requireGame = id => findGame(id) || missing('Игра не найдена.');
  const requireTournament = id => findTournament(id) || missing('Турнир не найден.');
  function missing(message) { throw new InputError(message, 404); }
  function requirePosition(value) {
    if (!Number.isInteger(value) || value < 1 || value > 1000) throw new InputError('Номер тура и стола должен быть от 1 до 1000.');
    return value;
  }
  const activeRoster = id => query.roster.all(id).filter(player => player.active).map(({ id, nick, mu }) => ({ id, nick, mu }));
  function requireParticipant(id, pid) {
    requireTournament(id);
    return activeRoster(id).find(player => player.id === pid) || missing('Участник не найден.');
  }
  function checkNick(roster, nick, pid) {
    if (roster.some(player => player.id !== pid && player.nick.toLocaleLowerCase('ru') === nick.toLocaleLowerCase('ru'))) {
      throw new InputError('Участник с таким ником уже добавлен: ' + nick, 409);
    }
  }
  function checkAlias(mu = '') {
    if (typeof mu !== 'string' || mu.length > 120) throw new InputError('Ник MafiaUniverse должен быть не длиннее 120 символов.');
    return mu.trim();
  }
  function writeRoster(id, players, save, active = 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      let { revision } = query.rosterRevision.get(id);
      for (const player of players) {
        save(player);
        query.profile.run(player.id, player.mu, active, ++revision);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function photo(id, key) {
    const [pid, slot = 'default'] = key.split('.');
    return query.photo.get(id, pid, slot)?.data ?? null;
  }
  function design(id) {
    const row = query.design.get(id);
    return row ? JSON.parse(row.settings) : null;
  }
  function info(id) {
    return JSON.parse(query.info.get(id)?.details ?? '{}');
  }
  return {
    close: () => db.close(),
    workflow,
    game: findGame, requireGame, tournament: findTournament, requireTournament,
    games: () => query.games.all().map(summarizeGame),
    tournaments: () => query.tournaments.all().map(summarizeTournament),
    ratings: () => query.ratings.all().map(summarizeRating),
    requireRating,
    tournamentGames: id => query.roundGames.all(id).map(summarizeGame),
    ratingGames: id => query.ratingGames.all(id).map(summarizeGame),
    roster: activeRoster,
    historicalRoster: id => query.roster.all(id),
    rosterChanges: (id, revision) => query.rosterChanges.all(id, revision),
    photo, design, info,
    updateInfo(id, data) {
      const tournament = requireTournament(id);
      const details = { ...info(id) };
      const name = data.title === undefined ? tournament.title : title(data.title, 'Название турнира');
      for (const [field, value] of Object.entries(data)) {
        if (field === 'title') continue;
        if (!infoFields.includes(field) || typeof value !== 'string' || value.length > 240) {
          throw new InputError('Проверьте поля общей информации.');
        }
        details[field] = value.trim();
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        query.renameTournament.run(name, id);
        query.setInfo.run(id, JSON.stringify(details));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { title: name, info: details };
    },
    photoSlots(id) {
      const byPlayer = new Map();
      for (const { id: pid, slot } of query.photos.all(id)) {
        if (!byPlayer.has(pid)) byPlayer.set(pid, []);
        byPlayer.get(pid).push(slot);
      }
      return byPlayer;
    },
    setPhoto(id, pid, slot, data) {
      requireParticipant(id, pid);
      const key = pid + (slot === 'default' ? '' : '.' + slot);
      if (data === null) return query.deletePhoto.run(pid, slot);
      if (!validPhoto(key, data)) throw new InputError('Не удалось сохранить фото. Загрузите изображение до 1 МБ.');
      if (query.photoSize.get(id).size - (photo(id, key)?.length ?? 0) + data.length > 64 * 1024 * 1024) {
        throw new InputError('Достигнут лимит фотографий турнира.');
      }
      query.setPhoto.run(pid, slot, data);
    },
    setDesign(id, settings) {
      requireTournament(id);
      if (settings === null) query.deleteDesign.run(id);
      else {
        if (!validDesign(settings)) throw new InputError('Проверьте параметры оформления OBS.');
        query.setDesign.run(id, JSON.stringify(settings));
      }
    },
    streams: id => query.streams.all(id).map(row => ({ table: row.table_no, gameId: row.game_id, token: row.token })),
    stream: (id, table) => query.stream.get(id, table),
    syncGameStatus(id, winner, started) {
      if (winner) query.finishGame.run(id);
      else if (started) query.startGame.run(id);
      else query.reopenGame.run(id);
    },
    createGame(data, initialize, ratingId = null) {
      const name = ratingId ? null : title(data.title, 'Название игры');
      const tournamentId = data.tournamentId ?? null;
      if (!ratingId && tournamentId === null) throw new InputError('Создайте игру внутри рейтинга или турнира.');
      if (ratingId && tournamentId !== null) throw new InputError('Игра в рейтинге создаётся отдельно от турнира.');
      const id = key();
      let round = null, table = null, roster;
      if (tournamentId !== null) {
        if (!isKey(tournamentId)) throw new InputError('Некорректный турнир.');
        requireTournament(tournamentId);
        workflow.openPlan(tournamentId);
        round = requirePosition(data.round);
        table = requirePosition(data.table);
        roster = activeRoster(tournamentId);
        if (query.occupiedTable.get(tournamentId, round, table)) {
          throw new InputError('За этим столом в выбранном туре уже есть игра.', 409);
        }
      }
      const nested = db.isTransaction;
      if (!nested) db.exec('BEGIN IMMEDIATE');
      try {
        const rating = ratingId ? requireRating(ratingId) : null;
        const number = rating ? query.nextRatingNumber.get(ratingId).number : null;
        const tournamentRosterRevision = tournamentId ? query.rosterRevision.get(tournamentId).revision : undefined;
        initialize(id, { title: rating?.title ?? name, roster, number, tournamentRosterRevision });
        query.addGame.run(id, rating ? 'Игра ' + number : name, Date.now(), tournamentId, round, table);
        if (rating) query.addRatingGame.run(ratingId, id, number);
        if (tournamentId) query.addStream.run(tournamentId, table, key());
        if (!nested) db.exec('COMMIT');
      } catch (error) {
        if (!nested) db.exec('ROLLBACK');
        throw error;
      }
      return requireGame(id);
    },
    updateGame(id, data, winner) {
      const previous = requireGame(id);
      const { status = previous.status, published = previous.published, showProtocol = previous.showProtocol } = data;
      if (!stages.includes(status) || typeof published !== 'boolean' || typeof showProtocol !== 'boolean') {
        throw new InputError('Некорректный статус или параметры публикации.');
      }
      if (status === 'finished' && !winner) throw new InputError('Сначала укажите результат в протоколе судьи.', 409);
      query.updateGame.run(status, +published, +showProtocol, data.video === undefined ? previous.video : video(data.video), id);
      return requireGame(id);
    },
    createTournament(data) {
      const id = key();
      query.addTournament.run(id, title(data.title, 'Название турнира'), Date.now());
      return requireTournament(id);
    },
    createRating(data) {
      const id = key();
      query.addRating.run(id, title(data.title, 'Название рейтинга'), Date.now());
      return requireRating(id);
    },
    addParticipant(id, data) {
      requireTournament(id);
      const roster = activeRoster(id);
      const items = data.players ?? [data];
      if (!Array.isArray(items) || items.length < 1 || items.length > 500) {
        throw new InputError('Добавляйте от 1 до 500 участников за раз.');
      }
      if (roster.length + items.length > 5000) throw new InputError('Достигнут лимит участников.');
      const players = items.map(item => {
        const nick = title(item?.nick, 'Ник');
        checkNick(roster, nick);
        const pid = key();
        const player = { nick, mu: checkAlias(item.mu), ...workflow.registration(pid, item) };
        roster.push(player);
        return player;
      });
      writeRoster(id, players, player => {
        query.addParticipant.run(player.id, id, player.nick);
        workflow.saveRegistration(player);
      });
      return data.players === undefined ? players[0] : players;
    },
    updateParticipant(id, pid, data) {
      const previous = requireParticipant(id, pid);
      const nick = title(data.nick ?? previous.nick, 'Ник');
      checkNick(activeRoster(id), nick, pid);
      const [registered] = workflow.roster(id, [previous]);
      const player = { nick, mu: checkAlias(data.mu ?? previous.mu), ...workflow.registration(pid, data, registered) };
      if (player.nick !== previous.nick || player.mu !== previous.mu) {
        writeRoster(id, [player], () => {
          query.renameParticipant.run(nick, pid);
          workflow.saveRegistration(player);
        });
      } else workflow.saveRegistration(player);
      return player;
    },
    removeParticipants(id, pid) {
      requireTournament(id);
      const players = pid ? [requireParticipant(id, pid)] : activeRoster(id);
      writeRoster(id, players, () => {}, 0);
    },
    moveStream(id, number, gameId) {
      requireTournament(id);
      const table = requirePosition(number);
      if (!query.stream.get(id, table)) missing('Стол не найден.');
      if (gameId !== null) {
        if (!isKey(gameId)) throw new InputError('Некорректная игра.');
        const game = requireGame(gameId);
        if (game.tournamentId !== id || game.table !== table) throw new InputError('Выберите игру этого стола.');
      }
      query.moveStream.run(gameId, id, table);
    },
  };
}

module.exports = { openCatalog, InputError, isKey };
