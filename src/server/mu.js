// Итоги с MafiaUniverse для экранов худа: результаты игры (/Games/Details/{id}) и итоговая таблица турнира
// (/Tournaments/Results/{id}). Обе страницы открыты без входа, поэтому их забирает сервер. Зависимостей нет.
const MU = process.env.MU_ORIGIN || 'https://mafiauniverse.org';
const GAME_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOURNAMENT_ID = /^\d{1,9}$/;
const MAX_PAGE = 3 * 1024 * 1024;
const MAX_ROWS = 200;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
// сайт кодирует кириллицу сущностями (&#x418;), поэтому текст сначала раскодируется
function decode(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#'
      ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1))
      : ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}
const text = html => decode(html).slice(0, 80);
// ячейки строк таблицы: [[заголовки], [ячейки строки], ...]
function tableRows(table) {
  return [...table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map(([tr]) => [...tr.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(m => text(m[1])));
}
function findTable(html, test) {
  return [...html.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map(m => m[0]).find(test) || '';
}
const hasHeader = name => t => (tableRows(t)[0] || []).some(h => h.toLowerCase() === name);
// столбцы ищутся по заголовку, а не по номеру, чтобы перестановка колонок на сайте ничего не сломала
function columns(head, names) {
  const at = {};
  for (const [key, test] of Object.entries(names)) at[key] = head.findIndex(h => test(h.toLowerCase()));
  return at;
}
const pick = (row, k) => (k >= 0 && row[k] != null ? row[k] : '');
const titleOf = html => decode((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '')
  .replace(/\s*-\s*MafiaUniverse\s*$/i, '').replace(/^Информация об игре\s+/i, '').replace(/\s*\([0-9a-f-]{36}\)\s*$/i, '').slice(0, 80);

function parseGame(html) {
  const table = findTable(html, hasHeader('роль'));
  if (!table) throw new Error('На странице игры нет таблицы результатов');
  const [head, ...rows] = tableRows(table);
  const c = columns(head, { n: h => h === '#', nick: h => h === 'игрок', role: h => h === 'роль', pu: h => h === 'пу', ci: h => h === 'ci', plus: h => h === '+', minus: h => h === '-' || h === '−', tech: h => h.startsWith('тех'), sum: h => h === '∑' });
  const facts = {};
  for (const m of html.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)) facts[text(m[1]).toLowerCase()] = text(m[2]);
  const winner = facts['победитель'] || '';
  return {
    title: titleOf(html).replace(/^Игра\s+/i, ''),
    winner: /мирн/i.test(winner) ? 'red' : /маф/i.test(winner) ? 'black' : /нич/i.test(winner) ? 'draw' : '',
    rows: rows.filter(r => r.length >= 3).slice(0, 10).map(r => ({
      n: pick(r, c.n), nick: pick(r, c.nick), role: pick(r, c.role), pu: pick(r, c.pu), ci: pick(r, c.ci),
      plus: pick(r, c.plus), minus: pick(r, c.minus), tech: pick(r, c.tech), sum: pick(r, c.sum)
    }))
  };
}

function parseResults(html) {
  if (/Результаты скрыты организатором/i.test(decode(html))) throw new Error('Организатор скрыл результаты турнира на MafiaUniverse');
  const table = findTable(html, t => /id="TournResultsTable"/i.test(t)) || findTable(html, hasHeader('игрок'));
  if (!table) throw new Error('На странице турнира нет итоговой таблицы');
  const [head, ...rows] = tableRows(table);
  // у колонок «первые отстрелы», «штрафы» и «игр» на сайте только значки, поэтому они ищутся по подсказке
  const titles = [...((table.match(/<thead[\s\S]*?<\/thead>/i) || [''])[0]).matchAll(/<th\b[\s\S]*?<\/th>/gi)]
    .map(m => decode((m[0].match(/title="([^"]*)"/i) || [])[1] || '').toLowerCase());
  const c = columns(head, { place: h => h === '#', nick: h => h === 'игрок', sum: h => h === '∑', plus: h => h === '∑ +' || h === '∑+', lh: h => h === 'лх', dop: h => h === 'допы', ci: h => h === 'ci' });
  const byTitle = re => titles.findIndex(t => re.test(t));
  c.games = byTitle(/^игр/); c.pen = byTitle(/штраф/); c.first = byTitle(/первых отстрел/);
  return {
    title: titleOf(html).replace(/^Результаты\s+/i, ''),
    rows: rows.filter(r => r.length >= 3 && pick(r, c.nick)).slice(0, MAX_ROWS).map(r => ({
      place: pick(r, c.place), nick: pick(r, c.nick), sum: pick(r, c.sum), plus: pick(r, c.plus), lh: pick(r, c.lh),
      dop: pick(r, c.dop), ci: pick(r, c.ci), pen: pick(r, c.pen), games: pick(r, c.games), first: pick(r, c.first)
    }))
  };
}

async function download(path) {
  const res = await fetch(MU + path, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'mafia-hud' } });
  if (res.status !== 200) throw new Error(res.status === 404 ? 'MafiaUniverse не нашёл такую страницу' : 'MafiaUniverse ответил ' + res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PAGE) throw new Error('Страница MafiaUniverse слишком большая');
      chunks.push(decoder.decode(value, { stream: true }));
    }
    return chunks.join('') + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// what: 'game' — итоги игры по её коду, 'results' — итоговая таблица турнира по номеру
async function fetchShow(what, id) {
  const key = String(id || '');
  if (what === 'game' && GAME_ID.test(key)) return { ...parseGame(await download('/Games/Details/' + key)), id: key, at: Date.now() };
  if (what === 'results' && TOURNAMENT_ID.test(key)) return { ...parseResults(await download('/Tournaments/Results/' + key)), id: key, at: Date.now() };
  throw new Error('Неверный код игры или номер турнира');
}

const validRequest = (what, id) => typeof id === 'string' &&
  (what === 'game' ? GAME_ID.test(id) : what === 'results' && TOURNAMENT_ID.test(id));

module.exports = { fetchShow, validRequest, parseGame, parseResults };
