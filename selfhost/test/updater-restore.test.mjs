// node --test selfhost/test/updater-restore.test.mjs: restoring the database never changes the owner of a file the
// owner of data/ links in place of the copy (root updater, data/ owned by the app's uid 1000)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cillhub-restore-'));
process.env.CILLCORD_INSTALL_DIR = root;
const { restoreDb } = await import('../updater.mjs');
const data = path.join(root, 'data');
const db = path.join(data, 'cillcord.sqlite');
const snapshot = path.join(root, 'snapshot.sqlite');
const victim = path.join(root, 'secret.env'); // stands for /install/.env or the docker socket
const copy = fs.copyFileSync;

test.after(() => { fs.copyFileSync = copy; fs.rmSync(root, { recursive: true, force: true }); });

test('a link planted between the copy and the chown is refused; the linked file keeps its owner', { skip: process.getuid?.() !== 0 && 'needs root' }, () => {
  fs.mkdirSync(data);
  fs.chownSync(data, 1000, 1000);
  fs.writeFileSync(snapshot, 'snapshot');
  fs.writeFileSync(victim, 'secret');
  fs.writeFileSync(db, 'live');
  // the owner of data/ swaps the fresh copy for a link the moment it exists
  fs.copyFileSync = (from, to, mode) => { copy(from, to, mode); if (to.endsWith('.restore')) { fs.rmSync(to); fs.symlinkSync(victim, to); } };
  assert.throws(() => restoreDb(snapshot));
  fs.copyFileSync = copy;
  assert.equal(fs.statSync(victim).uid, 0, 'the linked file still belongs to root');
  assert.equal(fs.readFileSync(db, 'utf8'), 'live', 'nothing was restored');

  // without interference the copy replaces the database and belongs to the owner of data/
  fs.writeFileSync(db + '-wal', 'wal');
  restoreDb(snapshot);
  assert.equal(fs.readFileSync(db, 'utf8'), 'snapshot');
  assert.equal(fs.statSync(db).uid, 1000);
  assert.ok(!fs.existsSync(db + '-wal') && !fs.existsSync(db + '.restore'));
});
