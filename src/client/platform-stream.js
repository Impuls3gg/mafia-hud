const stream = location.pathname.replace('/stream/', '/api/streams/');
const token = location.hash.slice(1);
let frame;
let source;

async function followTable() {
  try {
    const response = await fetch(stream, { headers: { Authorization: 'Bearer ' + token } });
    const next = response.ok ? (await response.json()).source : null;
    if (next !== source) {
      frame?.remove();
      source = next;
      if (source) {
        frame = document.createElement('iframe');
        frame.title = 'Игровой оверлей';
        frame.src = source;
        document.body.append(frame);
      }
    }
  } catch {
    // При временной потере сети открытый оверлей переподключится самостоятельно.
  }
  setTimeout(followTable, 1500);
}

if (/^[a-f0-9]{32}$/.test(token)) followTable();
