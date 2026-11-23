// Состояние, фотографии и подтверждения правок хранятся в отдельной базе каждой игры.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PHOTO_ID = /^[\w-]{1,64}(\.(?:civ|sheriff|mafia|don))?$/;
const PHOTO_DATA = /^data:image\/(?:jpeg|png|webp|gif|avif);base64,[a-z0-9+/]+={0,2}$/i;
const validPhoto = (id, data) => typeof id === 'string' && PHOTO_ID.test(id)
  && typeof data === 'string' && data.length <= 1024 * 1024 && PHOTO_DATA.test(data);

function openStorage(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'hud.sqlite'));
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS game (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL CHECK (json_valid(state))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS receipts (
      client TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      at INTEGER NOT NULL
    ) STRICT;
  `);

  const readGame = db.prepare('SELECT state FROM game WHERE id = 1');
  const writeGame = db.prepare('INSERT INTO game VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state');
  const readPhotos = db.prepare('SELECT id, data FROM photos');
  const writePhoto = db.prepare('INSERT INTO photos VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data');
  const deletePhoto = db.prepare('DELETE FROM photos WHERE id = ?');
  const clearPhotos = db.prepare('DELETE FROM photos');
  const readReceipt = db.prepare('SELECT seq FROM receipts WHERE client = ?');
  const writeReceipt = db.prepare('INSERT INTO receipts VALUES (?, ?, ?) ON CONFLICT(client) DO UPDATE SET seq = excluded.seq, at = excluded.at');
  const pruneReceipts = db.prepare('DELETE FROM receipts WHERE client IN (SELECT client FROM receipts ORDER BY at DESC LIMIT -1 OFFSET 1024)');

  function transaction(write) {
    db.exec('BEGIN IMMEDIATE');
    try {
      write();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    close: () => db.close(),
    game: () => JSON.parse(readGame.get()?.state ?? 'null'),
    photos: () => Object.assign(Object.create(null), Object.fromEntries(readPhotos.all().map(({ id, data }) => [id, data]))),
    receipt: client => readReceipt.get(client)?.seq ?? 0,
    save(state, receipt, deleted = []) {
      if (!receipt && !deleted.length) return writeGame.run(JSON.stringify(state));
      transaction(() => {
        writeGame.run(JSON.stringify(state));
        for (const id of deleted) deletePhoto.run(id);
        if (receipt) {
          writeReceipt.run(receipt.client, receipt.seq, Date.now());
          pruneReceipts.run();
        }
      });
    },
    setPhoto: (id, data) => data === null ? deletePhoto.run(id) : writePhoto.run(id, data),
    replace(state, photos) {
      transaction(() => {
        clearPhotos.run();
        for (const [id, data] of Object.entries(photos)) writePhoto.run(id, data);
        writeGame.run(JSON.stringify(state));
      });
    }
  };
}

function readSnapshot(dir) {
  const file = path.join(dir, 'hud.sqlite');
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return JSON.parse(db.prepare('SELECT state FROM game WHERE id = 1').get()?.state ?? 'null');
  } finally {
    db.close();
  }
}

module.exports = { openStorage, readSnapshot, PHOTO_ID, validPhoto };
