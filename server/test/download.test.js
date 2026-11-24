import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer } from './helpers.js';

test('Static /download directory and transparent installer delivery', async (t) => {
  // Release retention and availability on the public hub must not determine
  // whether the local relay passes its tests.
  const files = new Map([
    ['/download/desktop/Cillhub-Setup-2.1.0.exe', 'desktop fixture'],
    ['/download/server/install.sh', '#!/bin/sh\n# install.sh fixture\n'],
    ['/download/android/Cillhub.apk', 'android fixture'],
  ]);
  const seen = [];
  const hub = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const body = files.get(req.url);
    if (body === undefined) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': Buffer.byteLength(body) });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise(resolve => hub.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    hub.close(err => err ? reject(err) : resolve());
    hub.closeAllConnections();
  }));
  const srv = await startServer({ env: { CILLCORD_DOWNLOAD_UPSTREAM: `http://127.0.0.1:${hub.address().port}` } });
  try {
    // 1. HEAD /download/desktop/ returns 200 without redirecting external clients
    const headRes = await fetch(`${srv.origin}/download/desktop/Cillhub-Setup-2.1.0.exe`, { method: 'HEAD', redirect: 'manual' });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get('content-disposition'), 'attachment; filename="Cillhub-Setup-2.1.0.exe"');

    // 2. GET /download/server/install.sh streams the installer with 200 directly from the instance origin
    const shRes = await fetch(`${srv.origin}/download/server/install.sh`, { redirect: 'manual' });
    assert.equal(shRes.status, 200);
    const shText = await shRes.text();
    assert.equal(shText, files.get('/download/server/install.sh'));

    // 3. /download/android/Cillhub.apk streams with 200 directly
    const apkRes = await fetch(`${srv.origin}/download/android/Cillhub.apk`, { method: 'HEAD', redirect: 'manual' });
    assert.equal(apkRes.status, 200);
    assert.equal(apkRes.headers.get('content-disposition'), 'attachment; filename="Cillhub.apk"');
    assert.equal(Number(apkRes.headers.get('content-length')), Buffer.byteLength(files.get('/download/android/Cillhub.apk')));

    const missing = await fetch(`${srv.origin}/download/desktop/missing.exe`, { method: 'HEAD' });
    assert.equal(missing.status, 404);
    assert.ok(seen.includes('HEAD /download/desktop/Cillhub-Setup-2.1.0.exe'));
    assert.ok(seen.includes('GET /download/server/install.sh'));
    assert.ok(seen.includes('HEAD /download/android/Cillhub.apk'));

    // 4. no file-existence oracle outside the download folders, no 500 on a bad escape (review L-3)
    for (const p of ['/download/server/%2e%2e/%2e%2e/cillcord.sqlite', '/download/server/%']) assert.equal((await fetch(srv.origin + p)).status, 404, p);
  } finally {
    await srv.stop();
  }
});

test('web client pages carry CSP, nosniff and frame protection; HSTS only behind https (audit M3)', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(`${tmpdir()}/cillhub-static-`);
  await writeFile(`${dir}/index.html`, '<!doctype html>');
  await writeFile(`${dir}/offline.html`, '<button onclick="location.reload()">');
  const srv = await startServer({ env: { STATIC_DIR: dir } });
  try {
    const app = await fetch(`${srv.origin}/oauth2/authorize?client_id=1`);
    const csp = app.headers.get('content-security-policy');
    assert.match(csp, /frame-ancestors 'self'/);
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
    assert.equal(app.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(app.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(app.headers.get('strict-transport-security'), null);
    const offline = await fetch(`${srv.origin}/offline.html`, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(offline.headers.get('content-security-policy'), "frame-ancestors 'self'");
    assert.equal(offline.headers.get('strict-transport-security'), 'max-age=31536000');
  } finally {
    await srv.stop();
  }
});

test('the hub download relay forwards only plain names: no double escapes, no quotes in the filename', async () => {
  const { createServer } = await import('node:http');
  const seen = [];
  const hub = createServer((req, res) => { seen.push(req.url); res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end('x'); });
  await new Promise(r => hub.listen(3393, '127.0.0.1', r));
  const srv = await startServer({ env: { CILLCORD_DOWNLOAD_UPSTREAM: 'http://127.0.0.1:3393' } });
  try {
    for (const p of ['/download/desktop/%252e%252e/%252e%252e/secret', '/download/desktop/a%22.exe', '/download/desktop/a%0d%0aX:1.exe']) {
      assert.equal((await fetch(srv.origin + p)).status, 404, p);
    }
    assert.deepEqual(seen.filter(u => u !== '/download/desktop/Cillhub-Setup-9.9.9.exe'), [], 'nothing odd reached the hub');
    const ok = await fetch(`${srv.origin}/download/desktop/Cillhub-Setup-9.9.9.exe`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-disposition'), 'attachment; filename="Cillhub-Setup-9.9.9.exe"');
  } finally {
    await srv.stop();
    hub.close();
  }
});

test('local downloads stream the selected regular file, including DATA_DIR, ranges and HEAD', async t => {
  const { mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tempDir } = await import('./helpers.js');
  const staticDir = await tempDir();
  t.after(() => rm(staticDir, { recursive: true, force: true }));
  await writeFile(`${staticDir}/index.html`, '<!doctype html>app shell');
  const seen = [];
  const hub = createServer((req, res) => { seen.push(req.url); res.writeHead(404); res.end(); });
  await new Promise(resolve => hub.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { hub.close(resolve); hub.closeAllConnections(); }));
  for (const configuredStatic of ['', staticDir]) {
    const srv = await startServer({ env: {
      STATIC_DIR: configuredStatic, CILLCORD_DOWNLOAD_UPSTREAM: `http://127.0.0.1:${hub.address().port}`,
    } });
    try {
      const dir = `${srv.dataDir}/download/server`;
      await mkdir(`${dir}/folder`, { recursive: true });
      const bytes = Buffer.from([0, 1, 2, 255, 128, 10, 20, 30]);
      await writeFile(`${dir}/release.bin`, bytes);
      await writeFile(`${dir}/latest.json`, '{"version":"test"}');
      if (configuredStatic) {
        await mkdir(`${staticDir}/download/server/release.bin`, { recursive: true });
        await writeFile(`${staticDir}/download/server/latest.json`, '{"version":"static"}');
      }
      const url = `${srv.origin}/download/server/release.bin`;
      const full = await fetch(url, { headers: { 'X-Forwarded-Proto': 'https' } });
      assert.equal(full.status, 200);
      assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
      assert.equal(full.headers.get('content-type'), 'application/octet-stream');
      assert.equal(full.headers.get('cache-control'), 'no-cache');
      assert.match(full.headers.get('etag'), /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
      assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(full.headers.get('x-frame-options'), 'SAMEORIGIN');
      assert.equal(full.headers.get('strict-transport-security'), 'max-age=31536000');
      const ranged = await fetch(url, { headers: { Range: 'bytes=2-5' } });
      assert.equal(ranged.status, 206);
      assert.equal(ranged.headers.get('content-range'), 'bytes 2-5/8');
      assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(2, 6));
      const head = await fetch(url, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-length'), '8');
      assert.equal(await head.text(), '');
      const feed = await fetch(`${srv.origin}/download/server/latest.json`);
      assert.match(feed.headers.get('content-type'), /^application\/json/);
      assert.deepEqual(await feed.json(), { version: configuredStatic ? 'static' : 'test' });
      const directory = await fetch(`${srv.origin}/download/server/folder`);
      assert.equal(directory.status, 404);
      assert.ok(!(await directory.text()).includes('app shell'));
      assert.ok(seen.includes('/download/server/folder'));
    } finally {
      await srv.stop();
    }
  }
});
