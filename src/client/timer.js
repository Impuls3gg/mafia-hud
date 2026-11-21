function createTimerClock() {
  let serverDeadline = null;
  let localDeadline = null;
  let pausedRemaining = 0;
  let clockOffset = Infinity;

  return {
    update(timer) {
      const now = performance.now();
      // Обновление с наименьшей задержкой даёт наиболее точную привязку к серверным часам.
      if (Number.isFinite(timer.sentAt)) clockOffset = Math.min(clockOffset, now - timer.sentAt);
      if (!timer.running) {
        serverDeadline = localDeadline = null;
        pausedRemaining = timer.remain;
        return;
      }
      if (!Number.isFinite(timer.endAt) || !Number.isFinite(clockOffset)) {
        serverDeadline = null;
        localDeadline = now + timer.remain;
        return;
      }
      // Правки игры присылают тот же срок окончания, поэтому продолжаем начатый отсчёт.
      if (serverDeadline !== timer.endAt) {
        serverDeadline = timer.endAt;
        localDeadline = serverDeadline + clockOffset;
      }
    },
    remaining() {
      return localDeadline === null ? pausedRemaining : Math.max(0, localDeadline - performance.now());
    },
    serverTimeAt(localTime) {
      if (Number.isFinite(clockOffset)) return Math.round(localTime - clockOffset);
    }
  };
}

function createTimerDisplay() {
  let opening = null;
  return {
    show(full) {
      const frame = { full, until: Infinity };
      opening = frame;
      // Сохраняем стартовое число до первого кадра и на один интервал обновления.
      requestAnimationFrame(() => { frame.until = performance.now() + 200; });
    },
    clear() { opening = null; },
    remaining(actual) {
      return opening && actual > 0 && opening.full - actual < 2000 && performance.now() < opening.until
        ? Math.max(actual, opening.full)
        : actual;
    }
  };
}
