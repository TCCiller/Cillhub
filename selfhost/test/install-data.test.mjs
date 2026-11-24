// The installer can be rerun when only the container's uid can enter data/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('installer resolves the data mount without entering the private data directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cillhub-install-'));
  try {
    fs.mkdirSync(path.join(root, 'install dir', 'data'), { recursive: true });
    const source = fs.readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
    const command = source.match(/^docker run --rm -v .*\n  \|\| die .*$/m)?.[0];
    assert.ok(command, 'exercise the installer ownership command');
    const result = spawnSync('sh', ['-c', `
      DIR='install dir'
      IMAGE=cillhub-test
      cd() { case "$1" in */data) return 1 ;; *) command cd "$1" ;; esac; }
      docker() { [ "$4" = "$EXPECTED_MOUNT" ]; }
      die() { exit 1; }
      ${command}
    `], {
      cwd: root,
      env: { ...process.env, EXPECTED_MOUNT: path.join(root, 'install dir', 'data') + ':/data' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
