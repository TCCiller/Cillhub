// node --test selfhost/test/updater-skip.test.mjs: skip_version is set only once an update reached the swap step.
// The hub is a local HTTP server (127.0.0.1:3370, signed feed and a tarball), Docker is faked at http.request, health checks go to 127.0.0.1:3371.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';

const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cillhub-updater-skip-'));
fs.mkdirSync(path.join(ROOT, 'data'));
const key = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(path.join(ROOT, 'release-public-key.pem'), key.publicKey.export({ type: 'spki', format: 'pem' }));
const HUB = 'http://127.0.0.1:3370';
Object.assign(process.env, {
  CILLCORD_INSTALL_DIR: ROOT, CILLCORD_UPDATER_SECRET: SECRET, CILLCORD_HUB_URL: HUB, CILLCORD_IMAGE: 'repo', COMPOSE_PROJECT_NAME: 'proj', CILLCORD_UPDATER_HEALTH_TIMEOUT: '5',
});
const { handle } = await import('../updater.mjs');

const EXPIRES = Math.floor(Date.now() / 1000) + 86400; // fixed, so the feed and its signature match across requests
const tarball = Buffer.from('not really a tarball');
const world = { version: '9.9.9', download: 200, load: 200, imageVersion: '9.9.9', stop: 204, running: 'sha256:oldimg' };
const feed = () => {
  const body = Buffer.from(JSON.stringify({
    version: world.version, url: `${HUB}/download/server/x-${world.version}.tar.gz`, sha256: crypto.createHash('sha256').update(tarball).digest('hex'), size: tarball.length,
    security: false, key_id: crypto.createHash('sha256').update(key.publicKey.export({ type: 'spki', format: 'der' })).digest('hex'), expires: EXPIRES, min_version: null,
  }));
  return [body, crypto.sign(null, body, key.privateKey)];
};
const hub = http.createServer((req, res) => {
  if (req.url.endsWith('latest.json')) return res.end(feed()[0]);
  if (req.url.endsWith('latest.json.sig')) return res.end(feed()[1]);
  res.writeHead(world.download);
  res.end(world.download === 200 ? tarball : 'nope');
}).listen(3370, '127.0.0.1');
const health = http.createServer((req, res) => res.end('{}')).listen(3371, '127.0.0.1');
after(() => { hub.close(); health.close(); http.request = realRequest; fs.rmSync(ROOT, { recursive: true, force: true }); });

// fake Docker: the updater talks to it with http.request({ socketPath })
const container = id => ({ Id: id, Name: '/app', Image: world.running, Config: { Env: ['PORT=3371'], Labels: {} }, HostConfig: {}, State: { Status: 'running' }, RestartCount: 0,
  NetworkSettings: { Networks: { n: { IPAddress: '127.0.0.1', Aliases: [] } } } });
const image = id => ({ Id: id, Config: { Env: [`CILLCORD_VERSION=${id === 'sha256:oldimg' ? '1.0.0' : world.imageVersion}`] } });
function fakeDocker(method, p) {
  const [route, q = ''] = p.split('?');
  if (method === 'GET' && route === '/containers/json') return { json: [{ Id: 'old1', Names: ['/app'] }] };
  if (method === 'GET' && /^\/containers\/(old1|new2)\/json$/.test(route)) return { json: container(route.split('/')[2]) };
  if (method === 'GET' && route.endsWith('/logs')) return { text: '' };
  if (method === 'GET' && route.startsWith('/images/')) {
    const id = decodeURIComponent(route.split('/')[2]);
    return { json: image(id.includes('9.9') || id === 'repo:loaded' ? 'sha256:newimg' : id) };
  }
  if (method === 'POST' && route === '/images/load') return world.load === 200 ? { text: '{"stream":"Loaded image: repo:loaded\\n"}' } : { status: 500, text: 'boom' };
  if (method === 'POST' && route.endsWith('/tag') && q.includes('tag=current')) { world.running = decodeURIComponent(route.split('/')[2]); return { text: '' }; }
  if (method === 'POST' && route.endsWith('/stop')) return { status: world.stop, text: world.stop === 204 ? '' : 'cannot stop' };
  if (method === 'POST' && route === '/containers/create') return { json: { Id: 'new2' } };
  return { text: '' };
}
const realRequest = http.request;
http.request = (opts, cb) => {
  if (!opts?.socketPath) return realRequest(opts, cb);
  const chunks = [];
  return new Writable({
    write(c, _e, next) { chunks.push(c); next(); },
    final(next) {
      const r = fakeDocker(opts.method, opts.path);
      const res = Object.assign(new EventEmitter(), { statusCode: r.status ?? (r.json ? 200 : 204) });
      cb(res);
      queueMicrotask(() => { res.emit('data', Buffer.from(r.json ? JSON.stringify(r.json) : r.text ?? '')); res.emit('end'); });
      next();
    },
  });
};

async function call(method, url, body) {
  let status, out = '';
  const req = {
    method, url, headers: { authorization: `Bearer ${SECRET}` }, socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield body === undefined ? '' : JSON.stringify(body); },
  };
  await handle(req, { writeHead(c) { status = c; }, end(b) { out = b; } });
  return { status, body: out ? JSON.parse(out) : null };
}
const status = async () => (await call('GET', '/status')).body;
async function settle() {
  for (let i = 0; i < 200; i++) { const s = await status(); if (s.state !== 'updating' && s.state !== 'rolling_back') return s; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('the updater did not finish');
}
const auto = () => call('POST', '/update', { auto: true });
const manual = () => call('POST', '/update', {});

test('a failure before swap (download, load, version check) leaves skip_version alone and the next automatic run goes ahead', async () => {
  for (const [what, set, error] of [
    ['download', () => { world.download = 500; }, /download: HTTP 500/],
    ['load', () => { world.load = 500; }, /docker load|docker POST \/images\/load/],
    ['version check', () => { world.imageVersion = '0.0.1'; }, /the image is version 0.0.1/],
  ]) {
    Object.assign(world, { download: 200, load: 200, imageVersion: '9.9.9' });
    set();
    assert.equal((await auto()).status, 202, `${what}: the first automatic run starts`);
    const s = await settle();
    assert.equal(s.state, 'failed', what);
    assert.match(s.error, error, what);
    assert.equal(s.skip_version, undefined, `${what}: nothing on the node changed`);
    const again = await auto();
    assert.equal(again.status, 202, `${what}: an automatic run is accepted again`);
    await settle();
  }
});

test('a failure inside swap sets skip_version, the automatic run gets 409 and a manual update is never blocked', async () => {
  Object.assign(world, { download: 200, load: 200, imageVersion: '9.9.9', stop: 500 });
  assert.equal((await auto()).status, 202);
  const s = await settle();
  assert.equal(s.state, 'failed');
  assert.equal(s.skip_version, '9.9.9');
  const refused = await auto();
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /failed or was rolled back before/);
  assert.equal((await manual()).status, 202, 'a manual update is not blocked by skip_version');
  assert.equal((await settle()).skip_version, '9.9.9');
});

test('an earlier skipped version stays skipped after a pre-swap failure of another version', async () => {
  Object.assign(world, { version: '9.9.10', download: 500, stop: 204 });
  assert.equal((await auto()).status, 202);
  const s = await settle();
  assert.equal(s.state, 'failed');
  assert.equal(s.skip_version, '9.9.9');
  assert.equal((await auto()).status, 202, 'the new version is not skipped');
  await settle();
});

test('a manual rollback marks the version it left as skipped', async () => {
  Object.assign(world, { version: '9.9.11', download: 200, load: 200, imageVersion: '9.9.11', stop: 204 });
  assert.equal((await manual()).status, 202);
  const done = await settle();
  assert.equal(done.state, 'done', JSON.stringify(done));
  assert.equal(done.skip_version, '9.9.9', 'a success does not touch it');
  assert.equal((await call('POST', '/rollback')).status, 202);
  const back = await settle();
  assert.equal(back.state, 'done', JSON.stringify(back));
  assert.equal(back.skip_version, '9.9.11');
  const refused = await auto();
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /rolled back before/);
});
