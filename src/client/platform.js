const main = document.querySelector('#main');
const content = document.querySelector('#content');
const notice = document.querySelector('#notice');
const logout = document.querySelector('#logout');
const siteNav = document.querySelector('#siteNav');
const parts = location.pathname.split('/').filter(Boolean);
const statusText = { draft: 'Подготовка', live: 'Идёт игра', finished: 'Завершена' };
const winners = { red: 'Победа мирных', black: 'Победа мафии', draw: 'Ничья' };
const roles = { civ: 'Мирный', sheriff: 'Шериф', don: 'Дон', mafia: 'Мафия' };

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
const paragraph = (text, className = 'muted') => el('p', { className }, text);
const h2 = text => el('h2', {}, text);
const link = (text, href, className = '') => el('a', { href, className }, text);
const button = (text, onclick, className = '') => el('button', { type: 'button', className, onclick }, text);
const card = (...children) => el('section', { className: 'card stack' }, ...children);
const intro = (title, ...actions) => el('div', { className: 'intro' }, el('h1', {}, title), el('div', { className: 'row' }, ...actions));
const gamePath = id => '/games/' + id;
const tournamentPath = id => '/tournaments/' + id;
const tournamentResult = (id, gameId) => tournamentPath(id) + '/games/' + gameId;
const operatorPath = (id, gameId) => tournamentPath(id) + '/operator' + (gameId ? '?game=' + gameId : '');
const ratingPath = id => '/ratings/' + id;
const gameDate = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
const formatRatingPoints = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
const watchGame = id => '/watch/games/' + id;
const watchTournament = id => '/watch/tournaments/' + id;
const value = (form, field) => form.elements.namedItem(field).value;
const label = (name, input) => el('label', {}, el('span', {}, name), input);
const field = (name, type = 'text', attributes = {}) => el('input', { name, type, ...attributes });
const status = game => el('span', { className: 'status status-pill ' + game.status }, statusText[game.status]);
const dateCell = value => el('time', { className: 'row-meta', dateTime: new Date(value).toISOString() }, gameDate.format(value));

async function api(path, method = 'GET', data) {
  const options = data === undefined ? { method } : {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  };
  const response = await fetch('/api' + path, options);
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error || 'Запрос не выполнен.'), { status: response.status });
  return body;
}
function announce(text = '', error = false) {
  notice.textContent = text;
  notice.className = error ? 'error' : '';
}
function form(fields, submitLabel, action, secondary) {
  const error = el('p', { className: 'error', role: 'alert', hidden: true });
  const submit = el('button', { type: 'submit', className: 'primary' }, submitLabel);
  const node = el('form', { className: 'stack' }, ...fields, error, el('div', { className: 'row' }, submit, ...(secondary ? [secondary] : [])));
  node.onsubmit = async event => {
    event.preventDefault();
    submit.disabled = true;
    error.hidden = true;
    try { await action(node); }
    catch (err) { error.textContent = err.message; error.hidden = false; }
    finally { submit.disabled = false; }
  };
  return node;
}
function modal(title, fields, action) {
  const dialog = el('dialog');
  const heading = el('h2', { id: 'dialog-title' }, title);
  dialog.setAttribute('aria-labelledby', heading.id);
  dialog.append(form([heading, ...fields], 'Создать', action, button('Отмена', () => dialog.close())));
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}
function select(name, options, selected) {
  const node = el('select', { name }, ...options.map(([id, text]) => el('option', { value: id }, text)));
  if (selected !== undefined && selected !== null) node.value = selected;
  return node;
}
function copyField(title, url) {
  const input = el('input', { readOnly: true, value: new URL(url, location.origin).href });
  input.setAttribute('aria-label', title);
  const copy = button('Копировать', async () => {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(input.value);
      else {
        input.select();
        if (!document.execCommand('copy')) throw new Error();
      }
      announce('Ссылка скопирована.');
    } catch {
      input.select();
      announce('Ссылка выделена для копирования.');
    }
  });
  copy.setAttribute('aria-label', 'Копировать ' + title.toLowerCase());
  return el('div', {}, paragraph(title), el('div', { className: 'copy-row' }, input, copy));
}
function makeTable(headers, rows, className = '') {
  const header = el('tr', {}, ...headers.map(name => el('th', { scope: 'col' }, name)));
  const body = rows.map(cells => el('tr', {}, ...cells.map(cell => el('td', {}, cell instanceof Node ? cell : String(cell ?? '')))));
  return el('div', { className: 'table-wrap' }, el('table', { className }, el('thead', {}, header), el('tbody', {}, ...body)));
}
function createTournament() {
  modal('Создать турнир', [label('Название турнира', field('title', 'text', { required: true, maxLength: 120 }))], async node => {
    const tournament = await api('/tournaments', 'POST', { title: value(node, 'title') });
    location.href = tournamentPath(tournament.id);
  });
}
function createRating() {
  modal('Создать рейтинг', [label('Название рейтинга', field('title', 'text', { required: true, maxLength: 120 }))], async node => {
    const rating = await api('/ratings', 'POST', { title: value(node, 'title') });
    location.href = ratingPath(rating.id);
  });
}
function resultCard(game, href, editHref) {
  const heading = el('h3', {}, link(game.title, href, 'record-title'));
  const result = game.winner
    ? el('span', { className: 'rating-result ' + game.winner }, winners[game.winner])
    : status(game);
  const summary = el('div', { className: 'row between' }, result, dateCell(game.createdAt));
  const header = el('header', { className: 'rating-head' }, el('div', { className: 'card-title' }, heading));
  if (editHref) {
    const edit = link('✎', editHref, 'game-edit');
    edit.setAttribute('aria-label', 'Редактировать игру «' + game.title + '»');
    edit.title = 'Редактировать игру';
    header.firstChild.append(edit);
    header.append(paragraph('Стол ' + game.table + (game.judgeName ? ' · ' + game.judgeName : ''), 'row-meta'));
  }
  header.append(summary);
  let seats;
  if (!game.seats.length) seats = paragraph('Рассадка пока пуста.');
  else if (game.winner) seats = makeTable(['№', 'Игрок', 'Роль', 'Баллы'], game.seats.map(seat => [
    seat.no, seat.nick, seat.role ? el('span', { className: 'role-label ' + seat.role }, roles[seat.role]) : '—',
    el('span', { className: seat.total < 0 ? 'negative' : '' }, formatRatingPoints.format(seat.total)),
  ]), 'rating-table scored');
  else seats = makeTable(['№', 'Игрок'], game.seats.map(seat => [seat.no, seat.nick]), 'rating-table');
  const gameCard = el('article', { className: 'rating-game' }, header, seats);
  gameCard.dataset.result = game.winner;
  return gameCard;
}
function ratingCard(rating) {
  const create = button('Создать игру', async () => {
    create.disabled = true;
    announce();
    try {
      const game = await api(ratingPath(rating.id) + '/games', 'POST', {});
      location.href = gamePath(game.id);
    } catch (error) {
      announce(error.message, true);
      create.disabled = false;
    }
  }, 'primary');
  return [
    intro(rating.title, create),
    h2('Игры рейтинга'),
    rating.games.length ? el('div', { className: 'rating-grid' }, ...rating.games.map(game => resultCard(game, game.judge)))
      : card(paragraph('Игр пока нет.')),
  ];
}
function gameRow(game, viewer = false, atTournament = false) {
  const target = viewer ? watchGame(game.id) : game.tournamentId ? tournamentResult(game.tournamentId, game.id) : gamePath(game.id);
  const summary = el('div', {}, link(game.title, target, 'record-title'), el('div', { className: 'row' },
    status(game), ...(atTournament ? [paragraph('Стол ' + game.table, 'row-meta')] : []),
    ...(game.ratingTitle ? [link(game.ratingTitle, ratingPath(game.ratingId), 'row-meta')] : []), dateCell(game.createdAt)));
  const actions = el('div', { className: 'row' });
  if (!viewer && game.tournamentId && game.status !== 'finished') {
    actions.append(link('Судить', game.judge || target, 'button'));
    if (!atTournament) actions.append(link('Эфир', tournamentPath(game.tournamentId) + '/streams', 'button'));
  }
  return el('div', { className: 'record' }, summary, ...(actions.children.length ? [actions] : []));
}
function gameList(games, viewer = false, atTournament = false) {
  return games.length ? el('div', { className: 'records' }, ...games.map(game => gameRow(game, viewer, atTournament))) : paragraph('Игр пока нет.');
}
function catalogPage(entries, { heading, entryPath, empty, createLabel, create }) {
  const listing = entries.length ? el('div', { className: 'records' }, ...entries.map(entry =>
    el('div', { className: 'record' }, link(entry.title, entryPath(entry.id), 'record-title'), dateCell(entry.createdAt)))) : paragraph(empty);
  return [intro(heading, button(createLabel, create, 'primary')), card(listing)];
}
function dashboard({ games, ratings }) {
  const ratingTitles = new Map(ratings.map(({ id, title }) => [id, title]));
  const labeledGames = games.map(game => ({ ...game, ratingTitle: ratingTitles.get(game.ratingId) }));
  const current = labeledGames.filter(game => game.status !== 'finished');
  const archive = labeledGames.filter(game => game.status === 'finished');
  return [
    intro('Игры'),
    card(h2('Текущие игры'), gameList(current)),
    card(h2('Завершённые игры'), gameList(archive)),
  ];
}
function players(game) {
  const withResult = game.seats.some(seat => 'total' in seat);
  const heading = h2(withResult ? 'Результаты игроков' : 'Рассадка');
  if (!game.seats.length) return card(heading, paragraph('Места пока свободны.'));
  const visible = game.seats.some(seat => 'role' in seat);
  const headers = ['№', 'Игрок'];
  if (visible) headers.push('Роль', 'Фолы', 'Допы');
  if (withResult) headers.push('Минусы', 'Тех. фолы', 'Итого');
  else if (visible) headers.push('Штраф');
  const rows = game.seats.map(seat => [
    seat.no, seat.nick, ...(visible ? [roles[seat.role] || '—', seat.fouls, seat.bonus] : []),
    ...(withResult ? [seat.penalty, seat.tech, formatRatingPoints.format(seat.total)]
      : visible ? [+(seat.penalty + seat.tech).toFixed(2)] : []),
  ]);
  return card(heading, makeTable(headers, rows));
}
const playerNums = list => list?.length ? list.map(seat => +seat + 1).join(', ') : '—';
const playerNum = seat => seat === '' || seat === undefined ? '—' : +seat + 1;
function protocol(game) {
  const sections = [];
  for (const [i, day] of game.days.entries()) {
    if (!day.noms.length && !day.revote?.length) continue;
    const ballot = list => makeTable(['Кандидат', 'Голосов', 'Кто голосовал'], list.map(row => [
      playerNum(row.i), row.v === '' ? '—' : row.v, playerNums(row.voters),
    ]));
    sections.push(el('details', {}, el('summary', {}, 'День ' + (i + 1)),
      ...(day.noms.length ? [paragraph('Основное голосование'), ballot(day.noms)] : []),
      ...(day.revote?.length ? [paragraph('Переголосование'), ballot(day.revote)] : []),
      ...(day.stage === 'done' ? [paragraph(day.out?.length ? 'Покинули стол: ' + playerNums(day.out) : 'Никто не ушёл')] : [])));
  }
  const nights = game.nights.filter(night => night.shot !== '' || night.check !== '' || night.don !== '');
  if (nights.length) sections.push(el('details', {}, el('summary', {}, 'Ночные действия'),
    makeTable(['Ночь', 'Отстрел', 'Шериф', 'Дон'], nights.map((night, i) => [
      i + 1, playerNum(night.shot), playerNum(night.check), playerNum(night.don),
    ]))));
  const best = [game.bestMoves.first, game.bestMoves.second && { player: game.bestMoves.second.pu, picks: game.bestMoves.second.seats }]
    .filter(move => move && move.picks.some(Boolean));
  if (best.length) sections.push(el('details', {}, el('summary', {}, 'Лучшие ходы'),
    makeTable(['Игрок', 'Выбор'], best.map(move => [playerNum(move.player), playerNums(move.picks.filter(Boolean))]))));
  const reports = game.deathReports?.filter(report => !report.dismissedNight);
  if (reports?.length) sections.push(el('details', {}, el('summary', {}, 'Протоколы убитых'),
    makeTable(['Игрок', 'Красные', 'Чёрные', 'Шериф'], reports.map(report => [
      playerNum(report.i), playerNums(report.red), playerNums(report.black), playerNum(report.sheriff),
    ]))));
  if (game.notes) sections.push(el('details', {}, el('summary', {}, 'Заметки судьи'), paragraph(game.notes)));
  return card(h2('Протокол'), ...(sections.length ? sections : [paragraph('Записей пока нет.')]));
}
function standingsTable(tournament) {
  const rows = tournament.standings.map((row, i) => [row.place ?? i + 1, row.nick, row.games, row.wins, row.points]);
  return rows.length ? makeTable(['№', 'Игрок', 'Игр', 'Побед', 'Баллы'], rows) : paragraph('Таблица пока пуста.');
}
function rounds(tournament, viewer) {
  const byRound = new Map();
  for (const game of tournament.games) {
    if (!byRound.has(game.round)) byRound.set(game.round, []);
    byRound.get(game.round).push(game);
  }
  return Array.from(byRound, ([round, games]) => card(h2('Тур ' + round), gameList(games, viewer, true)));
}
const photoRoles = [['default', 'Основное'], ['civ', 'Мирный'], ['sheriff', 'Шериф'], ['mafia', 'Мафия'], ['don', 'Дон']];
function participantPhoto(path, slot, name, player) {
  const endpoint = path + '/photos/' + slot;
  const exists = player.photos.includes(slot);
  const preview = el('img', { alt: 'Фото · ' + name, hidden: !exists });
  if (exists) preview.src = '/api' + endpoint;
  const input = field(slot, 'file', { accept: 'image/*' });
  const remove = button('Удалить фото', () => update('DELETE'));
  remove.hidden = !exists;
  const error = paragraph('', 'error');
  async function update(method, file) {
    input.disabled = remove.disabled = true;
    error.textContent = '';
    try {
      await api(endpoint, method, file ? { data: await processImage(file) } : undefined);
      const visible = method === 'PUT';
      player.photos = player.photos.filter(value => value !== slot);
      if (visible) {
        player.photos.push(slot);
        preview.src = '/api' + endpoint + '?v=' + Date.now();
      } else preview.removeAttribute('src');
      preview.hidden = remove.hidden = !visible;
    } catch (err) { error.textContent = err.message; }
    finally {
      input.value = '';
      input.disabled = remove.disabled = false;
    }
  }
  input.onchange = () => { if (input.files[0]) void update('PUT', input.files[0]); };
  return el('div', { className: 'photo-slot' }, preview, label(name, input), remove, error);
}
function tournamentPlayers(tournament) {
  const path = tournamentPath(tournament.id) + '/participants';
  const list = el('div', { className: 'stack' });
  const search = field('playerSearch', 'search', { placeholder: 'Поиск по нику' });
  search.setAttribute('aria-label', 'Поиск участников');
  const nick = (name, initial = '', required = false) => field(name, 'text', { value: initial, maxLength: 120, required });
  function renderPlayers() {
    const filter = search.value.trim().toLocaleLowerCase('ru');
    const players = tournament.roster.filter(player => [player.nick, player.mu].some(name => name.toLocaleLowerCase('ru').includes(filter)));
    list.replaceChildren(...(players.length ? players.map(playerRow) : [paragraph(filter ? 'Участники не найдены.' : 'Список участников пуст.')]));
    removeAll.hidden = !tournament.roster.length;
  }
  function addPlayers(players) {
    tournament.roster.push(...players.map(player => ({ ...player, photos: [] })));
    tournament.roster.sort((a, b) => a.nick.localeCompare(b.nick, 'ru'));
    search.value = '';
    renderPlayers();
  }
  function playerRow(player) {
    const title = el('span', { className: 'chip' }, player.nick);
    const registration = el('span', { className: 'row-meta' });
    const updateRegistration = () => { registration.textContent = ' ' + (player.confirmed ? 'Подтверждён' : 'Ожидает подтверждения') + (player.paid ? ' · Оплачено' : ''); };
    updateRegistration();
    const row = el('details', { className: 'player-details' }, el('summary', {}, title, registration));
    row.ontoggle = () => {
      if (!row.open || row.children.length > 1) return;
      const endpoint = path + '/' + player.id;
      const remove = button('Удалить участника', async () => {
        if (!confirm('Убрать «' + player.nick + '» из списка участников? Его рассадка и результаты сохранятся.')) return;
        remove.disabled = true;
        try {
          await api(endpoint, 'DELETE');
          tournament.roster = tournament.roster.filter(other => other.id !== player.id);
          renderPlayers();
          announce('Участник убран из списка.');
        } catch (error) { announce(error.message, true); remove.disabled = false; }
      });
      const edit = form([el('div', { className: 'fields' },
        label('Ник участника', nick('playerNick', player.nick, true)), label('Ник на MafiaUniverse', nick('playerMu', player.mu))),
      el('div', { className: 'row' }, checkbox('confirmed', 'Подтверждён', player.confirmed), checkbox('paid', 'Участие оплачено', player.paid))],
      'Сохранить участника', async node => {
        Object.assign(player, await api(endpoint, 'PATCH', { nick: value(node, 'playerNick'), mu: value(node, 'playerMu'),
          confirmed: checked(node, 'confirmed'), paid: checked(node, 'paid') }));
        title.textContent = player.nick;
        updateRegistration();
        announce('Участник сохранён.');
      }, remove);
      row.append(edit, el('div', { className: 'photo-grid' }, ...photoRoles.map(([slot, name]) =>
        participantPhoto(endpoint, slot, name, player))));
    };
    return row;
  }
  const add = form([el('div', { className: 'fields' },
    label('Ник участника', nick('nick', '', true)), label('Ник на MafiaUniverse', nick('mu'))),
  el('div', { className: 'row' }, checkbox('confirmed', 'Подтверждён', true), checkbox('paid', 'Участие оплачено'))],
  'Добавить участника', async node => {
    addPlayers([await api(path, 'POST', { nick: value(node, 'nick'), mu: value(node, 'mu'),
      confirmed: checked(node, 'confirmed'), paid: checked(node, 'paid') })]);
    node.reset();
    announce('Участник добавлен.');
  });
  const bulk = form([label('По одному нику на строку', el('textarea', { name: 'players', rows: 5, required: true }))],
    'Добавить список', async node => {
      const players = value(node, 'players').split(/\r?\n/).map(nick => nick.trim()).filter(Boolean).map(nick => ({ nick }));
      addPlayers(await api(path, 'POST', { players }));
      node.reset();
      announce('Добавлено участников: ' + players.length + '.');
    });
  const importPlayers = form([label('CSV или TXT', field('rosterFile', 'file', { required: true, accept: '.csv,.txt,text/csv,text/plain' })),
    paragraph('Один ник на строку. В CSV второй столбец может содержать ник на MafiaUniverse.'),
    checkbox('confirmed', 'Подтвердить импортированных участников', true)], 'Загрузить список', async node => {
    const file = node.elements.namedItem('rosterFile').files[0];
    if (file.size > 512 * 1024) throw new Error('Размер файла должен быть до 512 КБ.');
    const text = await file.text();
    const rows = /\.txt$/i.test(file.name) ? text.split(/\r?\n/).map(line => [line.trim()]).filter(([line]) => line) : csvRows(text);
    if (/^(ник|игрок|nick|player)$/i.test(rows[0]?.[0] ?? '')) rows.shift();
    const players = rows.map(([nick, mu]) => ({ nick, mu, confirmed: checked(node, 'confirmed') }));
    addPlayers(await api(path, 'POST', { players }));
    node.reset();
    announce('Загружено участников: ' + players.length + '.');
  });
  const confirmAll = button('Утвердить всех', async () => {
    confirmAll.disabled = true;
    try {
      await api(tournamentPath(tournament.id) + '/admin/confirm', 'POST', {});
      for (const player of tournament.roster) player.confirmed = true;
      renderPlayers();
      announce('Все участники подтверждены.');
    } catch (error) { announce(error.message, true); }
    finally { confirmAll.disabled = false; }
  });
  const removeAll = button('Удалить всех участников', async () => {
    if (!confirm('Убрать всех участников из списка турнира? Рассадка и результаты созданных игр сохранятся.')) return;
    removeAll.disabled = true;
    try {
      await api(path, 'DELETE');
      tournament.roster = [];
      renderPlayers();
      announce('Список участников очищен.');
    } catch (error) { announce(error.message, true); }
    finally { removeAll.disabled = false; }
  });
  search.oninput = renderPlayers;
  renderPlayers();
  const section = card(h2('Участники'), add, el('details', {}, el('summary', {}, 'Добавить списком'), bulk),
    el('details', {}, el('summary', {}, 'Загрузить из файла'), importPlayers),
    search, list, el('div', { className: 'row' }, confirmAll, removeAll));
  section.id = 'players';
  return section;
}
const tournamentGameLabel = game => game.stageId ? game.title : 'Тур ' + game.round + ' · стол ' + game.table + ' · ' + game.title;
function tournamentDesign(tournament) {
  const design = tournament.design ?? { title: '', accent: ACCENT_DEF, showFouls: true, ui: UI_DEF };
  const path = tournamentPath(tournament.id) + '/design';
  const accent = field('accent', 'color', { value: design.accent });
  const colorList = el('datalist', { id: 'obs-colors' }, ...ACCENTS.map(value => el('option', { value })));
  accent.setAttribute('list', colorList.id);
  const sliders = UI_FIELDS.map(([key, name, min, max, step, unit]) => {
    const input = field(key, 'range', { min, max, step, value: design.ui[key], id: 'obs-' + key });
    const output = el('output');
    output.setAttribute('for', input.id);
    input.oninput = () => { output.value = (unit === '×' ? Number(input.value).toFixed(2) : input.value) + ' ' + unit; };
    input.oninput();
    return el('label', {}, el('span', {}, name), el('div', { className: 'slider' }, input, output));
  });
  const title = field('overlayTitle', 'text', { maxLength: 120, value: design.title, placeholder: 'Название текущей игры' });
  const fouls = field('showFouls', 'checkbox', { checked: design.showFouls });
  const designForm = form([label('Заголовок худа', title),
    el('div', { className: 'row' }, label('Цвет акцента', accent), el('label', { className: 'row' }, fouls, 'Показывать фолы')),
    colorList, ...sliders], 'Применить ко всем столам', async node => {
    const ui = Object.fromEntries(UI_FIELDS.map(([key]) => [key, +value(node, key)]));
    await api(path, 'PUT', { title: title.value.trim(), accent: accent.value, showFouls: fouls.checked, ui });
    resetShared.hidden = false;
    announce('Настройки OBS применены ко всем столам турнира.');
  }, button('Значения по умолчанию', () => {
    title.value = '';
    accent.value = ACCENT_DEF;
    fouls.checked = true;
    for (const [key] of UI_FIELDS) {
      const input = designForm.elements.namedItem(key);
      input.value = UI_DEF[key];
      input.oninput();
    }
  }));
  const resetShared = button('Отключить общее оформление', async () => {
    if (!confirm('Вернуть оформление, заданное в пульте каждой игры?')) return;
    resetShared.disabled = true;
    try {
      await api(path, 'DELETE');
      resetShared.hidden = true;
      announce('Для игр восстановлены индивидуальные настройки оформления.');
    } catch (error) { announce(error.message, true); }
    finally { resetShared.disabled = false; }
  });
  resetShared.hidden = !tournament.design;
  const previewBox = el('div', { className: 'stack' }, h2('Предпросмотр худа'));
  const games = tournament.games.filter(game => game.overlay);
  if (games.length) {
    const picker = select('previewGame', [['', 'Выберите игру'], ...games.map(game => [game.id, tournamentGameLabel(game)])]);
    const preview = el('iframe', { className: 'hud-preview', title: 'Предпросмотр худа', hidden: true });
    picker.onchange = async () => {
      const id = picker.value;
      preview.hidden = true;
      preview.removeAttribute('src');
      if (!id) return;
      try {
        const game = await api(gamePath(id));
        if (picker.value !== id) return;
        preview.src = game.links.overlay;
        preview.hidden = false;
      } catch (error) { announce(error.message, true); }
    };
    previewBox.append(label('Игра', picker), preview);
  } else previewBox.append(paragraph('Предпросмотр появится после создания первой игры.'));
  const section = card(h2('Дизайн OBS'), el('div', { className: 'operator-layout' },
    el('div', { className: 'stack' }, designForm, resetShared), previewBox));
  section.id = 'design';
  return section;
}
function tournamentOperator(tournament) {
  const section = card(h2('Пульт оператора'));
  if (!tournament.games.length) {
    section.append(paragraph('Создайте игру, чтобы открыть пульт.'));
    return section;
  }
  const frame = el('iframe', { className: 'operator-frame', title: 'Пульт оператора игры', hidden: true });
  const standalone = link('Открыть пульт отдельно', '#', 'button');
  standalone.target = '_blank';
  standalone.rel = 'noopener';
  standalone.hidden = true;
  const requested = new URLSearchParams(location.search).get('game');
  const picker = select('operatorGame', [['', 'Выберите игру'], ...tournament.games.map(game => [game.id, tournamentGameLabel(game)])],
    tournament.games.some(game => game.id === requested) ? requested : '');
  function showOperator() {
    if (picker.value) {
      const path = gamePath(picker.value);
      frame.src = path;
      standalone.href = path;
    } else frame.removeAttribute('src');
    frame.hidden = standalone.hidden = !picker.value;
  }
  picker.onchange = () => {
    history.replaceState(null, '', operatorPath(tournament.id, picker.value));
    showOperator();
  };
  if (picker.value) showOperator();
  section.append(el('div', { className: 'row operator-picker' }, label('Игра', picker), standalone), frame);
  return section;
}
const tournamentInfoFields = [
  ['dates', 'Даты проведения'], ['club', 'Клуб-организатор'], ['organizer', 'Организатор'],
  ['chiefJudge', 'Главный судья'], ['region', 'Регион'],
  ['venue', 'Адрес проведения'], ['fee', 'Стоимость участия'],
];
function tournamentOverview(tournament) {
  const metadata = el('dl', { className: 'tournament-facts' });
  function renderMetadata() {
    metadata.replaceChildren(...[['Участники', tournament.roster.length], ['Игры', tournament.games.length],
      ...tournamentInfoFields.filter(([key]) => tournament.info[key]).map(([key, name]) => [name, tournament.info[key]])]
      .flatMap(([name, description]) => [el('dt', {}, name), el('dd', {}, String(description))]));
  }
  renderMetadata();
  const fields = tournamentInfoFields.map(([key, name]) =>
    label(name, field(key, 'text', { value: tournament.info[key] || '', maxLength: 240 })));
  const editor = el('details', {}, el('summary', {}, 'Редактировать информацию'),
    form([label('Название турнира', field('tournamentTitle', 'text', { value: tournament.title, required: true, maxLength: 120 })),
      el('div', { className: 'fields' }, ...fields)], 'Сохранить', async node => {
      const updates = Object.fromEntries(tournamentInfoFields.map(([key]) => [key, value(node, key)]));
      Object.assign(tournament, await api(tournamentPath(tournament.id) + '/info', 'PATCH', { ...updates, title: value(node, 'tournamentTitle') }));
      content.querySelector('h1').textContent = tournament.title;
      document.title = tournament.title + ' · Мафия';
      renderMetadata();
      editor.open = false;
      announce('Информация сохранена.');
    }));
  const results = tournament.games.filter(game => game.winner);
  const counts = Map.groupBy(results, game => game.winner);
  const segments = Object.entries(winners).flatMap(([key, title]) => {
    const count = counts.get(key)?.length ?? 0;
    return count ? [{ key, title, count, share: count / results.length }] : [];
  });
  const summary = segments.length
    ? el('div', { className: 'stack' },
      el('div', { className: 'win-bar', ariaHidden: 'true' }, ...segments.map(({ key, share }) => {
        const bar = el('span', { className: key });
        bar.style.flexGrow = share;
        return bar;
      })),
      el('ul', { className: 'win-summary' }, ...segments.map(({ key, title, count, share }) =>
        el('li', { className: 'rating-result ' + key }, title + ' · ' + count + ' (' +
          new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 1 }).format(share) + ')'))))
    : paragraph('Завершённых игр пока нет.');
  return el('div', { className: 'layout' },
    card(h2('Общая информация'), metadata, editor), card(h2('Статистика побед'), summary));
}
function tournamentStandings(tournament) {
  return card(h2('Турнирная таблица'), paragraph(tournament.finalizedAt ? 'Итоговые места зафиксированы.' : 'Предварительные результаты.'), standingsTable(tournament));
}
function tournamentGames(tournament) {
  if (!tournament.games.length) return card(h2('Игры'), paragraph('Игры создаются по стадиям в админке турнира.'),
    el('div', { className: 'row' }, link('Открыть админку', tournamentPath(tournament.id) + '/admin', 'button')));
  const search = field('gamePlayer', 'search', { placeholder: 'Поиск по нику' });
  const flat = field('flatGames', 'checkbox');
  const listing = el('div', { className: 'stack' });
  const grid = games => el('div', { className: 'rating-grid' }, ...games.map(game =>
    resultCard(game, tournamentResult(tournament.id, game.id), game.judge || operatorPath(tournament.id, game.id))));
  function renderGames() {
    const query = search.value.trim().toLocaleLowerCase('ru');
    const games = tournament.games.filter(game => !query || game.seats.some(seat => seat.nick.toLocaleLowerCase('ru').includes(query)));
    if (!games.length) {
      listing.replaceChildren(card(paragraph('Игры с таким игроком не найдены.')));
      return;
    }
    if (flat.checked) {
      listing.replaceChildren(grid(games.sort((a, b) => b.createdAt - a.createdAt)));
      return;
    }
    const byStage = Map.groupBy(games, game => game.stageId);
    listing.replaceChildren(...Array.from(byStage, ([stage, fixtures]) => {
      const byRound = Map.groupBy(fixtures.toReversed(), game => game.stageRound);
      return el('section', { className: 'stack' },
        ...(stage ? [h2(fixtures[0].stageTitle)] : []),
        ...Array.from(byRound, ([round, tables]) => el('section', { className: 'stack' },
          el(stage ? 'h3' : 'h2', {}, 'Тур ' + round), grid(tables.toReversed()))));
    }));
  }
  search.oninput = flat.onchange = renderGames;
  renderGames();
  return el('div', { className: 'stack' }, card(h2('Игры'),
    el('div', { className: 'row games-filters' }, label('Игрок', search), el('label', { className: 'row' }, flat, 'Без группировки по турам'))),
  listing);
}
function tournamentGameResult(tournament, game) {
  return el('div', { className: 'stack' },
    card(el('div', { className: 'row between' }, h2(game.title), el('div', { className: 'row' },
      link('Редактировать протокол', game.links.judge, 'button'),
      link('Открыть пульт', operatorPath(tournament.id, game.id), 'button'))),
    el('div', { className: 'row' }, status(game), paragraph('Тур ' + game.stageRound + ' · стол ' + game.table),
      ...(game.judgeName ? [paragraph('Судья · ' + game.judgeName)] : []),
      ...(game.coefficient !== 1 ? [paragraph('Коэффициент · ' + formatRatingPoints.format(game.coefficient))] : []), dateCell(game.createdAt)),
    ...(game.winner ? [el('strong', { className: 'rating-result ' + game.winner }, winners[game.winner])] : [])),
    players(game), protocol(game));
}
function tournamentStreams(tournament) {
  const streams = tournament.streams.map(stream => {
    const url = '/stream/' + tournament.id + '/' + stream.table + '#' + stream.token;
    const options = [['', 'Не выбрана'], ...tournament.games.filter(game => game.table === stream.table)
      .map(game => [game.id, 'Тур ' + game.round + ' · ' + game.title])];
    const switcher = form([label('Игра в эфире', select('game', options, stream.gameId || ''))],
      'Переключить эфир', async node => {
        await api('/tournaments/' + tournament.id + '/streams/' + stream.table, 'PUT', { gameId: value(node, 'game') || null });
        announce('Источник OBS переключён.');
      });
    return card(h2('Эфир · стол ' + stream.table), switcher, copyField('Постоянная ссылка для OBS', url));
  });
  return el('div', { className: 'stack' }, ...(streams.length ? streams : [card(h2('Эфир'), paragraph('Источники OBS появятся после создания игр.'))]));
}
const tournamentSections = [
  ['', 'Общая информация', tournamentOverview],
  ['standings', 'Турнирная таблица', tournamentStandings],
  ['games', 'Игры', tournamentGames],
  ['participants', 'Участники', tournamentPlayers],
  ['admin', 'Админка', tournamentAdminPage],
  ['operator', 'Пульт оператора', tournamentOperator],
  ['design', 'Дизайн OBS', tournamentDesign],
  ['streams', 'Эфир', tournamentStreams],
];
async function tournamentPage(id) {
  const tournament = await api(tournamentPath(id));
  const current = parts[2] || '';
  const gameId = parts[3];
  const tabs = tournamentSections.map(([key, name]) => {
    const tab = link(name, tournamentPath(id) + (key ? '/' + key : ''), 'button');
    if (current === key) tab.setAttribute('aria-current', gameId ? 'location' : 'page');
    return tab;
  });
  const section = gameId
    ? tournamentGameResult(tournament, await api(gamePath(gameId)))
    : tournamentSections.find(([key]) => key === current)[2](tournament, current === 'admin' ? await api(tournamentPath(id) + '/admin') : undefined);
  return [
    intro(tournament.title,
      ...(tournament.games.some(game => game.published) ? [link('Страница зрителя', watchTournament(id), 'button')] : [])),
    el('nav', { className: 'row tournament-nav', ariaLabel: 'Разделы турнира' }, ...tabs),
    section,
  ];
}
function renderLogin(message) {
  logout.hidden = true;
  siteNav.hidden = true;
  const login = form([el('h1', {}, 'Вход организатора'), label('Пароль', field('key', 'password', { required: true, autocomplete: 'current-password' }))],
    'Войти', async node => {
      await api('/session', 'POST', { key: value(node, 'key') });
      await renderPrivate();
    });
  content.replaceChildren(el('section', { className: 'card login' }, login));
  if (message) announce(message, true);
  login.elements.key.focus();
}
function showSection() {
  const current = parts[0] || 'games';
  for (const link of siteNav.querySelectorAll('a')) {
    if (link.dataset.section === current) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
async function renderPrivate() {
  main.setAttribute('aria-busy', 'true');
  announce();
  try {
    if (parts[0] === 'games') {
      const game = await api(gamePath(parts[1]));
      location.replace(game.links.judge);
      return;
    }
    let cards;
    if (parts[0] === 'tournaments') {
      cards = parts[1] ? await tournamentPage(parts[1]) : catalogPage(await api('/tournaments'), {
        heading: 'Турниры', entryPath: tournamentPath, empty: 'Турниров пока нет.', createLabel: 'Создать турнир', create: createTournament,
      });
    } else if (parts[0] === 'ratings') {
      cards = parts[1] ? ratingCard(await api(ratingPath(parts[1]))) : catalogPage(await api('/ratings'), {
        heading: 'Рейтинги', entryPath: ratingPath, empty: 'Рейтингов пока нет.', createLabel: 'Создать рейтинг', create: createRating,
      });
    } else cards = dashboard(await api('/dashboard'));
    content.replaceChildren(...cards);
    document.title = content.querySelector('h1').textContent + ' · Мафия';
    logout.hidden = false;
    siteNav.hidden = false;
    showSection();
  } catch (error) {
    if (error.status === 401) renderLogin();
    else announce(error.message, true);
  } finally { main.setAttribute('aria-busy', 'false'); }
}
logout.onclick = async () => {
  try { await api('/session', 'DELETE'); location.href = '/'; }
  catch (error) { announce(error.message, true); }
};

function watch() {
  const video = el('div', { className: 'video' });
  const details = el('div', { className: 'stack' });
  let source;
  content.replaceChildren(video, details);
  async function refresh() {
    try {
      const data = await api('/public/' + parts[1] + '/' + parts[2]);
      announce();
      if (parts[1] === 'games') {
        if (data.video !== source) {
          source = data.video;
          video.replaceChildren(...!source ? [] : [source.startsWith('https://www.youtube-nocookie.com/embed/')
            ? el('iframe', { src: source, title: 'Видеотрансляция', allowFullscreen: true, referrerPolicy: 'strict-origin-when-cross-origin' })
            : el('video', { src: source, controls: true, playsInline: true })]);
        }
        details.replaceChildren(intro(data.title), el('div', { className: 'row' },
          status(data), paragraph('День ' + data.day), paragraph('За столом ' + data.alive),
          ...(data.winner ? [paragraph(winners[data.winner])] : [])),
          players(data), ...(data.days ? [protocol(data)] : []));
      } else {
        details.replaceChildren(intro(data.title), ...rounds(data, true), tournamentStandings(data));
      }
    } catch (error) {
      if (error.status === 404) {
        source = undefined;
        video.replaceChildren();
        details.replaceChildren();
      }
      announce(error.message, true);
    } finally {
      main.setAttribute('aria-busy', 'false');
      setTimeout(refresh, 5000);
    }
  }
  refresh();
}

const oldTournamentSection = new Map([['#rounds', 'games'], ['#players', 'participants'], ['#operator', 'operator'],
  ['#design', 'design'], ['#streams', 'streams']]);
const oldSection = parts[0] === 'tournaments' && parts.length === 2 && oldTournamentSection.get(location.hash);
if (oldSection) location.replace(tournamentPath(parts[1]) + '/' + oldSection);
else if (parts[0] === 'watch') watch();
else {
  renderPrivate();
  addEventListener('pageshow', event => { if (event.persisted) renderPrivate(); });
}
