const { fetchShow, validRequest } = require('./mu');

function createResults(game, publish, send) {
  const loading = new Map();
  const cache = new Map();
  let selection;

  function load(what, id, key) {
    if (loading.has(key)) return loading.get(key);
    if (loading.size >= 8) throw new Error('Слишком много запросов к MafiaUniverse. Повторите позже.');
    const request = fetchShow(what, id).then(data => {
      cache.delete(key);
      cache.set(key, data);
      if (cache.size > 32) cache.delete(cache.keys().next().value);
      return data;
    }).finally(() => loading.delete(key));
    loading.set(key, request);
    return request;
  }
  function save(what, data, show, resetPage) {
    const error = game.setShow(what, data, show, resetPage);
    if (error) throw new Error(error);
    publish();
  }
  async function fetch(socket, { what, id, mode, requestId }) {
    const reply = result => send(socket, { kind: 'muFetched', what, id, requestId, ...result });
    if (!validRequest(what, id) || !['show', 'refresh', 'prefetch'].includes(mode) ||
        !Number.isSafeInteger(requestId) || requestId < 1) {
      reply({ ok: false, error: 'Неверный код игры, номер турнира или режим загрузки.' });
      return;
    }
    const key = what + ':' + id.toLowerCase();
    const intent = { socket };
    const show = mode === 'show';
    const active = mode !== 'prefetch';
    if (active) selection = intent;
    try {
      const stored = game.state().show?.[what];
      const ready = cache.get(key) || (stored?.id === id ? stored : null);
      if (show && ready) save(what, ready, true, true);
      const data = mode === 'prefetch' && ready ? ready : await load(what, id, key);
      if (active && selection === intent) save(what, data, show, !ready);
      reply({ ok: true, rows: data.rows.length, title: data.title });
    } catch (error) {
      reply({ ok: false, error: error.message });
    }
  }
  function cancel(socket) {
    if (!socket || selection?.socket === socket) selection = undefined;
  }
  return { fetch, cancel };
}

module.exports = { createResults };
