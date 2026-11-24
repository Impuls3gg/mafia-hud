const { CLOSE_NO_ROOM, CLOSE_SESSION_EXPIRED } = require('./access');
const { send: sendText } = require('./transport');
const { createResults } = require('./show-results');

const MAX_PER_ROOM = 8;
const CLOSE_RELOAD = 4000;
const FROM_SERVER = { app: 'mafiahud', from: 'server' };
const TIMER_START_ACK = { countdown: 'countdownAck', speak: 'speechAck', restart: 'restartAck' };
const encode = message => JSON.stringify({ ...FROM_SERVER, ...message });
const send = (socket, message) => sendText(socket, encode(message));

function createChannel(game, access, scope, onChange) {
  const roles = { host: new Set(), judge: new Set(), screen: new Set() };
  const results = createResults(game, publish, send);
  let speechEnd, scheduledDeadline;
  let closed = false;
  let used = Date.now();
  const judgeText = () => JSON.stringify({ ...game.judgeState(), scope });

  function scheduleSpeechEnd(retry = 0) {
    const timer = game?.state()?.timer;
    const deadline = timer?.running ? timer.endAt : undefined;
    if (speechEnd && scheduledDeadline === deadline) return;
    clearTimeout(speechEnd);
    speechEnd = null;
    if (deadline === undefined) return;
    scheduledDeadline = deadline;
    const delay = Math.min(2147483647, Math.max(retry, deadline - Date.now()));
    speechEnd = setTimeout(() => {
      speechEnd = null;
      try {
        if (game.expireSpeech()) publishTimer();
        else scheduleSpeechEnd();
      } catch (error) {
        console.error('Не удалось завершить речь:', error.message);
        scheduleSpeechEnd(1000);
      }
    }, delay).unref();
  }

  function sendPeers() {
    const judge = roles.judge.size;
    for (const host of roles.host) send(host, { kind: 'peers', judge });
  }

  function sendPhotos(socket, view) {
    const visible = new Set(view.seats.flatMap(seat => [seat.pid, seat.ph]).filter(Boolean));
    for (const id of socket.photos) if (!visible.has(id)) socket.photos.delete(id);
    for (const pid of visible) {
      if (socket.photos.has(pid)) continue;
      socket.photos.add(pid);
      send(socket, { kind: 'photo', pid, data: game.overlayPhoto(pid) });
    }
  }

  function sendView(socket, view, text) {
    sendPhotos(socket, view);
    sendText(socket, text);
  }

  function publish(timerUpdate) {
    scheduleSpeechEnd();
    onChange(game.state().winner, game.hasActivity());
    const timerText = timerUpdate && encode(timerUpdate);
    let view, viewText;
    for (const socket of roles.screen) {
      if (!socket.introduced) continue;
      if (timerText && socket.timerUpdates) {
        sendText(socket, timerText);
        continue;
      }
      if (!view) {
        view = game.view();
        viewText = encode({ kind: 'view', view });
      }
      sendView(socket, view, viewText);
    }
    let stateText;
    for (const socket of roles.judge) {
      if (timerText && socket.timerUpdates) sendText(socket, timerText);
      else sendText(socket, stateText ??= judgeText());
    }
    for (const socket of roles.host) send(socket, { kind: 'game', S: game.state(), ack: socket.seq });
  }

  function publishTimer(seat) {
    const foul = seat === undefined ? undefined : { seat, count: game.state().seats[seat].fouls };
    publish({ kind: 'timer', timer: game.timer(), foul });
  }

  function updateRooms() {
    for (const role of ['judge', 'screen']) {
      for (const socket of roles[role]) {
        if (game.owns(role, socket.room)) continue;
        roles[role].delete(socket);
        socket.close(CLOSE_NO_ROOM);
      }
    }
    sendPeers();
  }

  function photosChanged(ids) {
    for (const pid of ids) {
      for (const socket of roles.screen) socket.photos.delete(pid);
      const text = encode({ kind: 'photo', pid, data: game.photo(pid) });
      for (const socket of roles.host) sendText(socket, text);
    }
  }

  function hostChange(socket, message) {
    const { seq, client, revision } = message;
    if (!Number.isSafeInteger(seq) || seq < 1 || typeof client !== 'string' || !/^[a-f0-9]{32}$/.test(client)) return;
    const receipt = { client, seq };
    const reject = (error, retry) => send(socket, { kind: 'game', S: game.state(), ack: seq, error, retry });
    const before = game.rooms();
    let result;
    try {
      if (message.kind === 'deletePlayer') result = game.deletePlayer(message.pid, receipt);
      else if (!Array.isArray(message.ops) || !message.ops.every(op => Array.isArray(op) && op.length === 3)) {
        return reject('Некорректные данные правки.');
      } else result = game.patch(message.ops, receipt, revision);
    } catch (error) {
      console.error('Не удалось сохранить изменение:', error.message);
      return reject('Сервер пока не сохранил правку. Повторяем отправку…', true);
    }
    if (result.error) return reject(result.error);
    socket.seq = seq;
    if (result.duplicate) return send(socket, { kind: 'game', S: game.state(), ack: seq });
    if (before !== game.rooms() &&
        (before.room !== game.rooms().room || before.hud !== game.rooms().hud)) updateRooms();
    if (result.deleted?.length) photosChanged(result.deleted);
    if (message.kind === 'patch' && message.ops.every(([path]) => path[0] === 'timer')) publishTimer();
    else publish();
  }

  function fromHost(socket, message) {
    if (message.kind === 'patch' || message.kind === 'deletePlayer') {
      hostChange(socket, message);
    } else if (message.kind === 'photo') {
      const stored = socket.importing
        ? game.importPhoto(socket.importing, message.pid, message.data)
        : game.setPhoto(message.pid, message.data);
      if (!stored) return send(socket, { kind: 'error', error: 'Фото не принято. Проверьте размер и формат.' });
      if (!socket.importing) {
        photosChanged([message.pid]);
        publish();
      }
    } else if (message.kind === 'import') {
      socket.importing = game.prepareImport(message.S);
      if (!socket.importing) send(socket, { kind: 'error', error: 'Игра для переноса имеет неверный формат.' });
    } else if (message.kind === 'moved' && socket.importing) {
      game.replace(socket.importing);
      socket.importing = null;
      results.cancel();
      updateRooms();
      for (const other of roles.host) if (other !== socket) other.close(CLOSE_RELOAD);
      publish();
      send(socket, { kind: 'moved' });
    } else if (message.kind === 'muFetch' && scope.tournamentId) results.fetch(socket, message);
    else if (message.kind === 'muCancel') results.cancel();
    else if (message.kind === 'ping') for (const screen of roles.screen) send(screen, { kind: 'ping' });
  }

  function fromPlayer(socket, message) {
    if (!game.owns(socket.role, socket.room)) return;
    if (socket.role === 'judge') {
      if (message.kind === 'hello') {
        socket.timerUpdates = message.timerUpdates === true;
        sendText(socket, judgeText());
      }
      else if (message.kind === 'muExport') {
        if (!Number.isSafeInteger(message.request) || message.request < 1) return;
        send(socket, { kind: 'muExport', request: message.request, protocol: game.exportProtocol() });
      }
      else if (message.kind === 'seating') {
        if (!Number.isSafeInteger(message.request) || message.request < 1) return;
        const { error, changed } = game.seatParticipants(message);
        if (changed) publish();
        else if (error) sendText(socket, judgeText());
        send(socket, { kind: 'seatingResult', request: message.request, error });
      }
      else if (message.kind === 'cmd') {
        const warning = message.a === 'nom' && game.nominationConfirmation(message);
        if (warning) return send(socket, { kind: 'nominationConfirm', i: message.i, ...warning });
        const day = game.state().days.length;
        if (game.command(message)) {
          if (message.a === 'timer' && day === game.state().days.length) {
            publishTimer(message.op === 'extra' ? message.i : undefined);
          }
          else publish();
        }
        if (message.a === 'timer' && Number.isSafeInteger(message.request) && Object.hasOwn(TIMER_START_ACK, message.op)) {
          send(socket, { kind: TIMER_START_ACK[message.op], request: message.request });
        }
      }
      return;
    }
    if (message.kind === 'hello' && !socket.introduced) {
      socket.introduced = true;
      socket.timerUpdates = message.timerUpdates === true;
      const view = game.view();
      sendView(socket, view, encode({ kind: 'view', view }));
    }
    if ((message.kind === 'hello' || message.kind === 'pong') && socket.introduced &&
        ['overlay', 'red', 'black'].includes(message.mode)) {
      const presence = { kind: message.kind, mode: message.mode };
      for (const host of roles.host) send(host, presence);
    }
  }

  function initialPhotos(socket, ids) {
    let index = 0;
    function next(error) {
      if (error || index === ids.length) return;
      const pid = ids[index++];
      sendText(socket, encode({ kind: 'photo', pid, data: game.photo(pid) }), next);
    }
    next();
  }

  function connected(socket, role, auth) {
    if (roles[role].size >= MAX_PER_ROOM) return socket.close(1008);
    Object.assign(socket, { role, room: auth.room, seq: 0, photos: new Set() });
    roles[role].add(socket);
    let expiry;
    let budget = 240;
    let measuredAt = Date.now();
    socket.on('close', () => {
      clearTimeout(expiry);
      if (roles[role].delete(socket) && role === 'judge') sendPeers();
      if (role === 'host') results.cancel(socket);
    });
    socket.on('message', (data, binary) => {
      if (closed) return;
      const now = Date.now();
      budget = Math.min(240, budget + (now - measuredAt) * .12) - 1;
      measuredAt = now;
      if (budget < 0 || binary) return socket.close(1008);
      try {
        const message = JSON.parse(data.toString());
        if (!message || typeof message !== 'object' || Array.isArray(message)) return;
        if (role === 'host') fromHost(socket, message);
        else fromPlayer(socket, message);
      } catch (error) {
        console.error('Сообщение не обработано:', error.message);
        send(socket, { kind: 'error', error: 'Не удалось обработать изменение.' });
      }
    });
    if (role === 'host') {
      const credentials = access.credentials(typeof auth.session === 'string' ? auth.session : undefined);
      expiry = setTimeout(() => socket.close(CLOSE_SESSION_EXPIRED), credentials.sessionMs).unref();
      send(socket, { kind: 'ready', ...credentials });
      send(socket, { kind: 'game', S: game.state(), ack: 0, hello: true, scope });
      initialPhotos(socket, game.photoIds());
      send(socket, { kind: 'peers', judge: roles.judge.size });
    } else {
      send(socket, { kind: 'ready' });
      if (role === 'judge') {
        send(socket, { kind: 'peers', panel: 1 });
        sendPeers();
      }
    }
  }

  scheduleSpeechEnd();
  return {
    game,
    scope,
    refreshTournament({ roster, photo, seating }) {
      if (roster || seating) game.syncTournamentRoster();
      if (photo) for (const socket of roles.screen) socket.photos.delete(photo);
      publish();
    },
    touch() { used = Date.now(); },
    connected,
    idle(now) { return now - used > 60000 && !speechEnd && Object.values(roles).every(clients => !clients.size); },
    close() {
      closed = true;
      clearTimeout(speechEnd);
      results.cancel();
      for (const clients of Object.values(roles)) for (const socket of clients) socket.close(CLOSE_NO_ROOM);
      game.close();
    },
  };
}

module.exports = { createChannel };
