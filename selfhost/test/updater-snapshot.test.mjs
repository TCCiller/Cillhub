// node --test selfhost/test/updater-snapshot.test.mjs: database snapshots bind the path as a SQL parameter
// (quotes and SQL fragments in the install or backup path cannot fail or run SQL) and refuse symbolic links.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cillhub-snap-'quote-"));
const injRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cillhub-snap-inj-'));
process.env.CILLCORD_INSTALL_DIR = root;
const { snapshotDb } = await import('../updater.mjs');
const data = path.join(root, 'data');
const dbPath = path.join(data, 'cillcord.sqlite');

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(injRoot, { recursive: true, force: true });
});

function rowsOf(file) {
  const db = new DatabaseSync(file);
  try { return db.prepare('SELECT id, name FROM t ORDER BY id').all().map((r) => ({ id: r.id, name: r.name })); }
  finally { db.close(); }
}

test('snapshotDb works with a single quote in the install directory and blocks SQL in the snapshot path', () => {
  fs.mkdirSync(data, { recursive: true });
  const src = new DatabaseSync(dbPath);
  try {
    src.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t VALUES (1, \'alice\'), (2, \'bob\');');
  } finally { src.close(); }
  const expected = [{ id: 1, name: 'alice' }, { id: 2, name: 'bob' }];

  // install dir itself contains a single quote
  const backupDir = path.join(root, 'backups', '2026-01-01T00-00-00-000Z-pre-1.1.0');
  fs.mkdirSync(backupDir, { recursive: true });
  const snap1 = path.join(backupDir, 'cillcord.sqlite');
  assert.equal(snapshotDb(snap1), true);
  assert.deepEqual(rowsOf(snap1), expected);

  // snapshot path carries a single quote followed by SQL (no preceding quote in injRoot)
  const injDir = path.join(injRoot, "x'; DROP TABLE t; --");
  fs.mkdirSync(injDir, { recursive: true });
  const snap2 = path.join(injDir, 'cillcord.sqlite');
  assert.equal(snapshotDb(snap2), true);
  assert.deepEqual(rowsOf(dbPath), expected, 'source database table must remain untouched');
  assert.deepEqual(rowsOf(snap2), expected, 'snapshot must hold the rows of the source database');
});

test('snapshotDb refuses symbolic links on the database, -wal, and -shm without writing a snapshot', () => {
  const target = path.join(root, 'target.txt');
  fs.writeFileSync(target, 'not-a-db');
  const out = path.join(root, 'backups', 'should-not-exist.sqlite');
  fs.mkdirSync(path.dirname(out), { recursive: true });

  for (const suffix of ['-wal', '-shm']) {
    const link = dbPath + suffix;
    fs.symlinkSync(target, link);
    try {
      assert.throws(() => snapshotDb(out), new RegExp(`data/cillcord\\.sqlite${suffix} is a symbolic link; refusing to open it`));
      assert.equal(fs.existsSync(out), false);
    } finally { fs.rmSync(link, { force: true }); }
  }

  const saved = dbPath + '.orig';
  fs.renameSync(dbPath, saved);
  fs.symlinkSync(target, dbPath);
  try {
    assert.throws(() => snapshotDb(out), /data\/cillcord\.sqlite is a symbolic link; refusing to open it/);
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(dbPath, { force: true });
    fs.renameSync(saved, dbPath);
  }
});
