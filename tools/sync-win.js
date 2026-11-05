// Пересобирает экраны победы из mafia-hud.html: файлы отличаются только строкой FORCE_MODE.
// node tools/sync-win.js          обновить файлы
// node tools/sync-win.js --check  только проверить, код выхода 1 при расхождении
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const MARKER = "const FORCE_MODE='';";
const SCREENS = { 'win-civilians.html': 'red', 'win-mafia.html': 'black' };

const source = fs.readFileSync(path.join(root, 'mafia-hud.html'), 'utf8');
if (!source.includes(MARKER)) throw new Error(`В mafia-hud.html нет строки ${MARKER}`);

const check = process.argv.includes('--check');
const stale = [];
for (const [name, mode] of Object.entries(SCREENS)) {
  const file = path.join(root, name);
  const text = source.replace(MARKER, `const FORCE_MODE='${mode}';`);
  if (fs.readFileSync(file, 'utf8') === text) continue;
  stale.push(name);
  if (!check) fs.writeFileSync(file, text);
}

if (!stale.length) console.log('Экраны победы совпадают с mafia-hud.html');
else if (check) {
  console.error(`Не совпадают с mafia-hud.html: ${stale.join(', ')}. Запустите node tools/sync-win.js`);
  process.exit(1);
} else console.log(`Обновлены: ${stale.join(', ')}`);
