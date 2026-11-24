// node --test selfhost/test/updater-gate.test.mjs: unit tests for the updater HTTP gate and signed feed field validation
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { handle, isPrivate, parseKeys, verifyFeed } from '../updater.mjs';

const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const WRONG_SAME_LEN = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

async function callHandle({ remoteAddress, authorization, method = 'GET', url = '/status', onBodyRead, onDocker }) {
  let status = null;
  let headers = null;
  let rawBody = '';
  const req = {
    method,
    url,
    headers: authorization === undefined ? {} : { authorization },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      if (onBodyRead) onBodyRead();
      yield '{}';
    },
  };
  const res = {
    writeHead(code, h) { status = code; headers = h; },
    end(b) { rawBody = b; },
  };
  const origRequest = http.request;
  http.request = (...args) => {
    if (onDocker) onDocker(args[0]);
    const fakeReq = {
      on(ev, fn) {
        if (ev === 'error') queueMicrotask(() => fn(new Error('no docker in unit test')));
        return this;
      },
      end() {},
      pipe() {},
    };
    return fakeReq;
  };
  try {
    await handle(req, res);
  } finally {
    http.request = origRequest;
  }
  return { status, headers, body: rawBody ? JSON.parse(rawBody) : null };
}

test('HTTP gate: public and look-alike private addresses get 403 even with the right secret; no route or Docker call runs', async () => {
  process.env.CILLCORD_UPDATER_SECRET = SECRET;
  let dockerCalls = 0;
  let bodyReads = 0;

  for (const addr of [
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.160.0.1',
    '172.15.255.255',
    '172.32.0.1',
    '10.evil',
    '10.0.0.999',
    '10.0.0.1.2',
    '127.evil',
    '192.168.evil',
    '192.168.1.1/24',
    'fd00:evil',
    '::12',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
    '::ffff:172.160.0.1',
    '::ffff:10.evil',
    '',
    undefined,
  ]) {
    assert.equal(isPrivate(addr), false, `isPrivate(${addr})`);
    for (const [method, url] of [['GET', '/status'], ['GET', '/check'], ['POST', '/update'], ['POST', '/rollback']]) {
      const r = await callHandle({
        remoteAddress: addr,
        authorization: `Bearer ${SECRET}`,
        method,
        url,
        onBodyRead: () => { bodyReads++; },
        onDocker: () => { dockerCalls++; },
      });
      assert.equal(r.status, 403, `${addr} ${method} ${url}`);
      assert.deepEqual(r.body, { error: 'local network only' });
    }
  }
  assert.equal(dockerCalls, 0, 'no Docker request before address check passes');
  assert.equal(bodyReads, 0, 'no route handler reads body before address check passes');
});

test('HTTP gate: private addresses without, with a wrong, or with a same-length wrong secret get 401; IPv4-mapped private addresses with right secret pass', async () => {
  process.env.CILLCORD_UPDATER_SECRET = SECRET;
  let dockerCalls = 0;
  let bodyReads = 0;

  const privateAddrs = [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '172.20.0.5',
    '172.31.255.254',
    '192.168.1.10',
    '::1',
    'fd12:3456:789a::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '::ffff:10.24.0.3',
    '::ffff:172.18.0.2',
    '::ffff:192.168.0.1',
    '::FFFF:10.0.0.2',
  ];

  for (const addr of privateAddrs) {
    assert.equal(isPrivate(addr), true, `isPrivate(${addr})`);
    for (const auth of [
      undefined,
      '',
      'Bearer',
      'Bearer ',
      'Bearer short-wrong',
      `Bearer ${WRONG_SAME_LEN}`,
      `Basic ${SECRET}`,
      SECRET,
    ]) {
      const r = await callHandle({
        remoteAddress: addr,
        authorization: auth,
        method: 'POST',
        url: '/update',
        onBodyRead: () => { bodyReads++; },
        onDocker: () => { dockerCalls++; },
      });
      assert.equal(r.status, 401, `${addr} auth=${auth}`);
      assert.deepEqual(r.body, { error: 'unauthorized' });
    }
  }
  assert.equal(dockerCalls, 0, 'no Docker request before bearer secret check passes');
  assert.equal(bodyReads, 0, 'no route handler runs before bearer secret check passes');

  // With both a private (including IPv4-mapped) address and the matching secret, the request passes the gate
  for (const addr of ['127.0.0.1', '::ffff:172.18.0.2', '::FFFF:10.0.0.2']) {
    let seenDocker = 0;
    const r = await callHandle({
      remoteAddress: addr,
      authorization: `Bearer ${SECRET}`,
      method: 'GET',
      url: '/status',
      onDocker: () => { seenDocker++; },
    });
    assert.equal(r.status, 200, `${addr} GET /status`);
    assert.equal(r.body.state, 'idle');
    assert.equal(seenDocker, 1, 'route handler ran after passing both gate checks');
  }
});

const pair = () => crypto.generateKeyPairSync('ed25519');
const pem = (k) => k.publicKey.export({ type: 'spki', format: 'pem' });
const keyId = (k) => crypto.createHash('sha256').update(k.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
const signer = pair();
const keys = parseKeys(pem(signer));
const now = Date.parse('2026-11-09T00:00:00Z');

function signedFeed(overrides = {}) {
  const payload = {
    version: '7.1.0',
    url: 'https://hub.example/download/server/cillhub-server-7.1.0.tar.gz',
    sha256: 'a'.repeat(64),
    size: 1024,
    security: false,
    key_id: keyId(signer),
    expires: now / 1000 + 86400,
    min_version: null,
    min_upgrade_from: null,
    ...overrides,
  };
  const body = Buffer.from(JSON.stringify(payload));
  return [body, crypto.sign(null, body, signer.privateKey)];
}

test('verifyFeed rejects non-https URLs outside the hub download path', () => {
  process.env.CILLCORD_HUB_URL = 'http://fakehub:8000';
  try {
    assert.equal(
      verifyFeed(...signedFeed({ url: 'http://fakehub:8000/download/server/cillhub-server-7.1.0.tar.gz' }), keys, null, now).version,
      '7.1.0',
    );
    for (const badUrl of [
      'http://fakehub:8000/other/cillhub-server-7.1.0.tar.gz',
      'http://other.example/download/server/cillhub-server-7.1.0.tar.gz',
      'ftp://fakehub:8000/download/server/cillhub-server-7.1.0.tar.gz',
      '/download/server/cillhub-server-7.1.0.tar.gz',
      '',
      null,
      123,
    ]) {
      assert.throws(() => verifyFeed(...signedFeed({ url: badUrl }), keys, null, now), /malformed/, `url=${badUrl}`);
    }
  } finally {
    delete process.env.CILLCORD_HUB_URL;
  }
  assert.throws(
    () => verifyFeed(...signedFeed({ url: '/download/server/cillhub-server-7.1.0.tar.gz' }), keys, null, now),
    /malformed/,
  );
});

test('verifyFeed rejects a bad sha256', () => {
  for (const badSha of [
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    'g'.repeat(64),
    '',
    null,
    123,
    ['a'.repeat(64)],
  ]) {
    assert.throws(() => verifyFeed(...signedFeed({ sha256: badSha }), keys, null, now), /malformed/, `sha256=${badSha}`);
  }
});

test('verifyFeed rejects non-integer, zero, or negative size', () => {
  for (const badSize of [0, -1, -1024, 1.5, '1024', null, undefined, NaN, Infinity]) {
    assert.throws(() => verifyFeed(...signedFeed({ size: badSize }), keys, null, now), /malformed/, `size=${badSize}`);
  }
});

test('verifyFeed rejects a bad version', () => {
  for (const badVersion of ['', '7.1', 'v7.1.0', '7.1.0.1', '7.1.0;rm -rf /', '../7.1.0', null, 710, ['7.1.0']]) {
    assert.throws(() => verifyFeed(...signedFeed({ version: badVersion }), keys, null, now), /malformed/, `version=${badVersion}`);
  }
});

test('verifyFeed rejects a bad min_upgrade_from', () => {
  assert.equal(verifyFeed(...signedFeed({ min_upgrade_from: '7.0.0' }), keys, null, now).min_upgrade_from, '7.0.0');
  for (const badMin of ['', '7.0', 'v7.0.0', 'not-a-version', 0, false, 700, {}, ['7.0.0']]) {
    assert.throws(
      () => verifyFeed(...signedFeed({ min_upgrade_from: badMin }), keys, null, now),
      /malformed/,
      `min_upgrade_from=${JSON.stringify(badMin)}`,
    );
  }
});
