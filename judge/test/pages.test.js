const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { ROOT } = require('./helpers');

test('экраны победы совпадают с mafia-hud.html', () => {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'sync-win.js'), '--check'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});

test('скрипты страниц без синтаксических ошибок', () => {
  const pages = ['mafia-hud.html', 'win-civilians.html', 'win-mafia.html', 'judge/judge.html'];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length, page);
    scripts.forEach(([, code]) => new vm.Script(code, { filename: page }));
  }
});
