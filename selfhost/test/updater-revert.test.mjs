// node --test selfhost/test/updater-revert.test.mjs: every revert step runs even when an earlier step throws,
// original error and logs survive, and backup folder names stay directly inside backups/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupDir, executeSwap, pruneBackups } from '../updater.mjs';

function makeOps(log, overrides = {}) {
  return {
    step: () => {},
    oldId: 'old-1',
    targetLabel: '1.2.0',
    stopOld: async () => { log.push('stopOld'); },
    snapshotDb: () => { log.push('snapshotDb'); return true; },
    restoreDb: () => { log.push('restoreDb'); },
    tagNew: async () => { log.push('tagNew'); },
    tagOld: async () => { log.push('tagOld'); },
    renameOldToReplaced: async () => { log.push('renameOldToReplaced'); },
    renameOldBack: async () => { log.push('renameOldBack'); },
    createNew: async () => { log.push('createNew'); return { Id: 'new-2' }; },
    startNew: async (id) => { log.push(`startNew:${id}`); },
    startOld: async () => { log.push('startOld'); },
    healthCheck: async (id) => {
      log.push(`healthCheck:${id}`);
      if (id === 'new-2') throw new Error('the app exited (code 3)');
    },
    logTail: async (id) => { log.push(`logTail:${id}`); return 'fatal: migration boom'; },
    removeNew: async (id) => { log.push(`removeNew:${id}`); },
    removeOld: async () => { log.push('removeOld'); },
    ...overrides,
  };
}

test('revert runs tag, rename back, start and health check even when restoreDb throws', async () => {
  const log = [];
  const dir = '/tmp/cillhub-fake/backups/2026-01-01T00-00-00-000Z-pre-1.2.0';
  const ops = makeOps(log, {
    restoreDb: () => { log.push('restoreDb'); throw new Error('ENOSPC: no space left on device'); },
  });

  let caught;
  try {
    await executeSwap({ dir, snapshot: `${dir}/cillcord.sqlite`, restoreFrom: null, ops });
  } catch (e) { caught = e; }

  assert.ok(caught, 'swap must rethrow the original error');
  assert.deepEqual(log, [
    'stopOld', 'snapshotDb', 'tagNew', 'renameOldToReplaced', 'createNew', 'startNew:new-2', 'healthCheck:new-2',
    'logTail:new-2', 'removeNew:new-2', 'restoreDb', 'tagOld', 'renameOldBack', 'startOld', 'healthCheck:old-1',
  ]);
  assert.equal(caught.rolled_back, false);
  assert.equal(caught.logs, 'fatal: migration boom');
  assert.match(caught.message, /the app exited \(code 3\)/);
  assert.match(caught.message, /database was not restored/i);
  assert.match(caught.message, /ENOSPC/);
  assert.ok(caught.message.includes(dir), 'error must include backup folder');
});

test('revert sets rolled_back true and keeps original message when every step succeeds', async () => {
  const log = [];
  const dir = '/tmp/cillhub-fake/backups/2026-01-01T00-00-00-000Z-pre-1.2.0';
  const ops = makeOps(log);

  let caught;
  try {
    await executeSwap({ dir, snapshot: `${dir}/cillcord.sqlite`, restoreFrom: null, ops });
  } catch (e) { caught = e; }

  assert.ok(caught);
  assert.deepEqual(log, [
    'stopOld', 'snapshotDb', 'tagNew', 'renameOldToReplaced', 'createNew', 'startNew:new-2', 'healthCheck:new-2',
    'logTail:new-2', 'removeNew:new-2', 'restoreDb', 'tagOld', 'renameOldBack', 'startOld', 'healthCheck:old-1',
  ]);
  assert.equal(caught.rolled_back, true);
  assert.equal(caught.message, 'the app exited (code 3)');
  assert.equal(caught.logs, 'fatal: migration boom');
});

test('revert still starts the old container and checks health when renameOldBack fails', async () => {
  const log = [];
  const dir = '/tmp/cillhub-fake/backups/2026-01-01T00-00-00-000Z-pre-1.2.0';
  const ops = makeOps(log, {
    renameOldBack: async () => { log.push('renameOldBack'); throw new Error('409 name in use'); },
  });

  let caught;
  try {
    await executeSwap({ dir, snapshot: `${dir}/cillcord.sqlite`, restoreFrom: null, ops });
  } catch (e) { caught = e; }

  assert.ok(caught);
  assert.deepEqual(log.slice(-4), ['tagOld', 'renameOldBack', 'startOld', 'healthCheck:old-1']);
  assert.equal(caught.rolled_back, false);
  assert.match(caught.message, /the app exited \(code 3\)/);
  assert.match(caught.message, /409 name in use/);
  assert.ok(caught.message.includes(dir));
});

test('revert still runs when stopOld fails', async () => {
  const log = [];
  const dir = '/tmp/cillhub-fake/backups/2026-01-01T00-00-00-000Z-pre-1.2.0';
  const ops = makeOps(log, {
    stopOld: async () => { log.push('stopOld'); throw new Error('stop timeout'); },
  });

  let caught;
  try {
    await executeSwap({ dir, snapshot: `${dir}/cillcord.sqlite`, restoreFrom: null, ops });
  } catch (e) { caught = e; }

  assert.ok(caught);
  assert.deepEqual(log, ['stopOld', 'tagOld', 'startOld', 'healthCheck:old-1']);
  assert.equal(caught.rolled_back, true);
  assert.equal(caught.message, 'stop timeout');
});

test('backupDir keeps null, slash, double-dot/parent-path and normal versions directly inside backups and pruneBackups recognises them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cillhub-bdir-'));
  const base = path.join(root, 'backups');
  try {
    const cases = [
      ['null', null],
      ['slash', 'pre-rollback-to-1.0/evil'],
      ['parent', 'pre-rollback-to-../../etc/passwd'],
      ['dots', '..'],
      ['normal', 'pre-1.2.0'],
    ];
    const dirs = [];
    for (let i = 0; i < cases.length; i++) {
      const [label, input] = cases[i];
      const now = new Date(Date.UTC(2026, 0, i + 1, 0, 0, 0));
      const d = backupDir(root, input, now);
      assert.equal(path.dirname(d), base, `${label}: must sit directly inside backups/ (got ${d})`);
      const name = path.basename(d);
      assert.ok(!name.includes('..') && !name.includes('/') && !name.includes('\\'), `${label}: unsafe basename ${name}`);
      assert.match(name, /^\d{4}-\d{2}-\d{2}T/, `${label}: must match pruneBackups prefix`);
      fs.mkdirSync(d, { recursive: true });
      dirs.push(d);
    }
    assert.ok(path.basename(dirs[4]).endsWith('-pre-1.2.0'));

    // pruneBackups recognises all 5 and keeps only the newest 2 plus the protected oldest one
    pruneBackups(root, 2, path.join(dirs[0], 'cillcord.sqlite'));
    const kept = fs.readdirSync(base).sort();
    assert.deepEqual(kept, [path.basename(dirs[0]), path.basename(dirs[3]), path.basename(dirs[4])].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
