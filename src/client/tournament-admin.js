function csvRows(text) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delimiter = firstLine.includes('\t') ? '\t' : firstLine.includes(';') ? ';' : ',';
  const rows = [];
  let row = [], cell = '', quoted = false;
  function appendRow() {
    row.push(cell.trim());
    if (row.some(Boolean)) rows.push(row);
    row = [];
    cell = '';
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && char === delimiter) {
      row.push(cell.trim());
      cell = '';
    } else if (!quoted && (char === '\r' || char === '\n')) {
      appendRow();
      if (char === '\r' && text[i + 1] === '\n') i++;
    } else cell += char;
  }
  if (quoted) throw new Error('В CSV осталась незакрытая кавычка.');
  appendRow();
  return rows;
}

function checked(form, name) {
  return form.elements.namedItem(name).checked;
}

function checkbox(name, title, initial = false) {
  return el('label', { className: 'row' }, field(name, 'checkbox', { checked: initial }), title);
}

function tournamentAdminPage(tournament, admin) {
  const path = tournamentPath(tournament.id) + '/admin';
  const stageOptions = admin.stages.map(stage => [stage.id, stage.name]);
  const playerOptions = tournament.roster.map(player => [player.id, player.nick]);
  const ruleNames = { separate: 'За разными столами', minimize: 'Реже за одним столом', together: 'За одним столом' };
  const playerNames = new Map(playerOptions);
  const judgeNames = new Map(admin.judges.map(judge => [judge.id, judge.nick]));
  const stageSelect = (empty = 'Выберите стадию') => select('stage', [['', empty], ...stageOptions]);
  async function submit(action, data, describe, reload = true) {
    const result = await api(path + '/' + action, 'POST', data);
    if (reload) await renderPrivate();
    announce(typeof describe === 'function' ? describe(result) : describe);
    return result;
  }
  function command(text, run, confirmation) {
    const control = button(text, async () => {
      if (confirmation && !confirm(confirmation)) return;
      control.disabled = true;
      announce();
      try { await run(); }
      catch (error) { announce(error.message, true); }
      finally { control.disabled = false; }
    });
    return control;
  }
  const scores = el('div', { className: 'stack' });
  const calculate = command('Посчитать результат', async () => {
    const result = await submit('calculate', {}, 'Результаты пересчитаны.', false);
    scores.replaceChildren(standingsTable({ standings: result.standings }));
  });
  if (admin.finalizedAt) {
    return card(h2('Админка турнира'), paragraph('Итоговые места зафиксированы.'),
      link('Открыть итоговую таблицу', tournamentPath(tournament.id) + '/standings', 'button'),
      command('Открыть турнир для изменений', () => submit('reopen', {}, 'Турнир открыт для изменений.'),
        'Снять фиксацию итоговых мест и вернуться к предварительной таблице?'));
  }
  function stageEditor(stage) {
    const current = stage ?? { name: '', rounds: 1, players: 10, coefficient: 1, final: false, swiss: false };
    const numeric = (key, title, min, max, step = 1) =>
      label(title, field(key, 'number', { required: true, min, max, step, value: current[key] }));
    const editor = form([
      label('Название стадии', field('stageName', 'text', { required: true, maxLength: 120, value: current.name })),
      el('div', { className: 'fields' }, numeric('rounds', 'Игр на игрока', 1, 50),
        numeric('players', 'Игроков', 10, 500, 10), numeric('coefficient', 'Коэффициент игр', .01, 10, .01)),
      el('div', { className: 'row' }, checkbox('finalStage', 'Финал', current.final), checkbox('swiss', 'Швейцарская рассадка', current.swiss)),
    ], 'Сохранить стадию', node => submit('stage', {
      id: stage?.id, name: value(node, 'stageName'), rounds: +value(node, 'rounds'),
      players: +value(node, 'players'), coefficient: +value(node, 'coefficient'), final: checked(node, 'finalStage'), swiss: checked(node, 'swiss'),
    }, 'Стадия сохранена.'), stage && command('Удалить стадию',
      () => submit('stage', { id: stage.id, remove: true }, 'Стадия удалена.'), 'Удалить стадию «' + stage.name + '»?'));
    const name = stage ? stage.name + ' · ' + stage.rounds + ' игр на игрока · ' + stage.players + ' игроков' : 'Добавить стадию';
    return el('details', { className: 'player-details' }, el('summary', {}, name), editor);
  }
  const judgeForm = form([el('div', { className: 'fields' },
    label('Имя судьи', field('judgeName', 'text', { required: true, maxLength: 120 })),
    label('Стол', field('judgeTable', 'number', { required: true, min: 1, max: 1000 })))],
  'Назначить судью', node => submit('judge', { nick: value(node, 'judgeName'), table: +value(node, 'judgeTable') }, 'Судья назначен.'));
  const judgeTable = admin.judges.length ? makeTable(['Судья', 'Стол', ''], admin.judges.map(judge => [
    judge.nick, judge.table, command('Снять назначение', () => submit('judge', { id: judge.id, remove: true }, 'Назначение снято.'),
      'Снять назначение судьи? Его ограничения в рассадке также будут сняты.'),
  ])) : paragraph('Судьи пока не назначены.');
  const opponentOptions = [['', 'Выберите игрока или судью'],
    ...playerOptions.map(([key, name]) => ['p:' + key, name]),
    ...admin.judges.map(judge => ['j:' + judge.id, 'Судья · ' + judge.nick + ' · стол ' + judge.table])];
  const ruleForm = form([el('div', { className: 'fields' },
    label('Игрок', select('player', [['', 'Выберите игрока'], ...playerOptions])),
    label('Пара', select('opponent', opponentOptions)), label('Правило', select('pairRule', Object.entries(ruleNames))))],
  'Добавить ограничение', node => {
    const [type, key] = value(node, 'opponent').split(':');
    return submit('pair', { player: value(node, 'player'), opponent: type === 'p' ? key : '', judge: type === 'j' ? key : '',
      rule: value(node, 'pairRule') }, 'Ограничение сохранено.');
  });
  const pairTable = admin.pairs.length ? makeTable(['Игрок', 'Пара', 'Правило', ''], admin.pairs.map(pair => [
    playerNames.get(pair.player) || 'Выбыл', playerNames.get(pair.opponent) || judgeNames.get(pair.judge) || 'Выбыл', ruleNames[pair.rule],
    command('Удалить', () => submit('pair', { id: pair.id, remove: true }, 'Ограничение удалено.')),
  ])) : null;
  const createForm = form([label('Стадия', stageSelect())], 'Создать игры', node =>
    submit('create', { stageId: value(node, 'stage') }, result => 'Создано игр: ' + result.created + '.'));
  const placementNotice = result => 'Рассажено игр: ' + result.placed + '. Пропущено: ' + result.skipped + '.'
    + (result.waitingForResults ? ' Следующий тур швейцарки станет доступен после результатов предыдущего.' : '');
  const placeForm = form([label('Стадия', stageSelect()), checkbox('overwrite', 'Перезаписать рассадку в черновиках')],
    'Создать рассадку', node => {
      const overwrite = checked(node, 'overwrite');
      if (overwrite && !confirm('Перезаписать рассадку в играх, которые ещё не начались?')) return;
      return submit('place', { stageId: value(node, 'stage'), overwrite }, placementNotice);
    });
  const drafts = tournament.games.filter(game => game.status === 'draft');
  const incomingGame = new URLSearchParams(location.search).get('game');
  const encodedSeats = new URLSearchParams(location.hash.slice(1)).get('seating');
  let importedSeats;
  try {
    const seats = JSON.parse(encodedSeats ?? 'null');
    if (Array.isArray(seats) && seats.length === 10 && seats.every(nick => typeof nick === 'string')) importedSeats = seats;
  } catch {}
  const confirmed = tournament.roster.filter(player => player.confirmed);
  const seatOptions = [['', 'Свободно'], ...confirmed.map(player => [player.id, player.nick])];
  const manualGame = select('manualGame', [['', 'Выберите игру'], ...drafts.map(game => [game.id, tournamentGameLabel(game)])]);
  manualGame.value = drafts.some(game => game.id === incomingGame) ? incomingGame : '';
  const manualSeats = el('div', { className: 'seating' });
  const manualHint = paragraph('');
  function drawSeats(useIncoming = false) {
    const game = drafts.find(game => game.id === manualGame.value);
    const normalize = text => text.trim().toLocaleLowerCase('ru');
    const missing = [];
    const seats = useIncoming && importedSeats && game
      ? importedSeats.map(nick => {
        const wanted = normalize(nick);
        const found = confirmed.filter(player => [player.mu, player.nick].some(name => name && normalize(name) === wanted));
        if (wanted && found.length !== 1) missing.push(nick);
        return found.length === 1 ? found[0].id : '';
      })
      : game?.seating ?? [];
    manualSeats.replaceChildren(...(game ? Array.from({ length: 10 }, (_, index) => {
      const pid = seats[index] || '';
      const options = pid && !confirmed.some(player => player.id === pid)
        ? [...seatOptions, [pid, (game.seats.find(seat => seat.no === index + 1)?.nick || 'Игрок') + ' · вне подтверждённого состава']] : seatOptions;
      return label('Место ' + (index + 1), select('manualSeat' + index, options, pid));
    }) : []));
    manualHint.textContent = missing.length ? 'Проверьте участников, которых не удалось однозначно сопоставить: ' + missing.join(', ') + '.' : '';
  }
  manualGame.onchange = () => drawSeats();
  drawSeats(true);
  const manualForm = form([label('Игра', manualGame), manualSeats, manualHint], 'Сохранить рассадку', async node => {
    if (!manualGame.value) throw new Error('Выберите игру.');
    const seating = Array.from({ length: 10 }, (_, index) => value(node, 'manualSeat' + index));
    await api(path + '/place', 'POST', { gameId: manualGame.value, seating, overwrite: true });
    history.replaceState(null, '', path + '?game=' + manualGame.value);
    await renderPrivate();
    announce('Рассадка сохранена.');
  });
  const importForm = form([label('Нумерация туров', stageSelect('Сквозная нумерация турнира')),
    label('Файл CSV', field('placementCsv', 'file', { required: true, accept: '.csv,text/csv' })),
    paragraph('Четыре колонки: тур, стол, место, ник. Для импорта укажите все 10 мест каждого стола.'),
    checkbox('overwrite', 'Перезаписать рассадку в черновиках')], 'Загрузить рассадку', async node => {
    const file = node.elements.namedItem('placementCsv').files[0];
    if (file.size > 1024 * 1024) throw new Error('Размер CSV должен быть до 1 МБ.');
    const overwrite = checked(node, 'overwrite');
    if (overwrite && !confirm('Перезаписать рассадку в играх, которые ещё не начались?')) return;
    const rows = csvRows(await file.text());
    if (/^тур|^номер тура|^round/i.test(rows[0]?.[0] ?? '')) rows.shift();
    const seats = rows.map(row => row.length === 4 ? [+row[0], +row[1], +row[2], row[3]] : row);
    return submit('place', { stageId: value(node, 'stage'), overwrite, rows: seats }, placementNotice);
  });
  return el('div', { className: 'stack' },
    card(h2('Стадии'), paragraph('Подтверждено игроков: ' + tournament.roster.filter(player => player.confirmed).length + '.'),
      ...admin.stages.map(stageEditor), stageEditor()),
    el('div', { className: 'operator-layout' }, card(h2('Судьи по столам'), judgeTable, judgeForm),
      card(h2('Ограничения рассадки'), ...(pairTable ? [pairTable] : []), ruleForm)),
    card(h2('Игры и рассадка'), ...(stageOptions.length ? [el('div', { className: 'operator-layout' }, createForm, placeForm)]
      : [paragraph('Добавьте стадию для пакетного создания игр.')]),
    ...(drafts.length ? [el('details', { open: Boolean(manualGame.value) }, el('summary', {}, 'Рассадка отдельной игры'), manualForm)] : []),
    el('details', {}, el('summary', {}, 'Импорт рассадки из CSV'), importForm),
    ...(admin.pairStats.length ? [makeTable(['Встреч за одним столом', 'Пар игроков'], admin.pairStats)] : [])),
    card(h2('Итоги турнира'), el('div', { className: 'row' }, calculate,
      command('Установить итоговые места', () => submit('finalize', {}, 'Итоговые места зафиксированы.'),
        'Зафиксировать итоговые места турнира?'),
      command('Удалить незавершённые игры', () => submit('remove-unfinished', {}, result => 'Удалено игр: ' + result.removed + '.'),
        'Удалить все незавершённые игры турнира вместе с их рассадкой и протоколами?')), scores));
}
