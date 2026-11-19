const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { ROOT } = require('./helpers');

test('скрипты пульта, экранов и судьи без синтаксических ошибок', () => {
  const dir = path.join(ROOT, 'src', 'client');
  const scripts = fs.readdirSync(dir).filter(name => name.endsWith('.js'));
  assert.ok(scripts.length);
  for (const name of scripts) new vm.Script(fs.readFileSync(path.join(dir, name), 'utf8'), { filename: name });
  const judge = fs.readFileSync(path.join(dir, 'judge.html'), 'utf8');
  const code = judge.match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(code, { filename: 'judge.html' });
});
