import test from 'node:test';
import assert from 'node:assert/strict';
import { on } from 'node:events';
import WebSocket from 'ws';
import { startServer } from './helpers.js';

// Match Config, Session, Rest and GatewayProtocol in Android 3.7.1: no Origin,
// raw Authorization, login/password JSON, and a user IDENTIFY without intents.
test('Android 3.7.1 discovery, login and gateway connection', { timeout: 15000 }, async () => {
  const srv = await startServer();
  const headers = { 'User-Agent': 'Cillhub-Android/3.7.1' };
  let ws;
  try {
    const discovery = await fetch(`${srv.origin}/.well-known/cillhub`, { headers });
    assert.equal(discovery.status, 200);
    assert.equal((await discovery.json()).api, srv.base);
    const gateway = await srv.api('GET', '/gateway', null, undefined, headers);
    assert.equal(gateway.status, 200);
    assert.equal(gateway.body.url, `${srv.origin.replace('http', 'ws')}/gateway`);
    const instance = await srv.api('GET', '/instance', null, undefined, headers);
    assert.equal(instance.status, 200);
    assert.equal(typeof instance.body.legal.min_age, 'number');

    const registered = await srv.api('POST', '/auth/register', null, {
      email: 'android@example.invalid', username: 'android', password: 'android-test-password',
      age_confirmed: true, terms_accepted: true,
    }, headers);
    assert.equal(registered.status, 201);
    const login = await srv.api('POST', '/auth/login', null, {
      login: 'android', password: 'android-test-password',
    }, headers);
    assert.equal(login.status, 200);
    assert.equal(typeof login.body.token, 'string');
    const me = await srv.api('GET', '/users/@me', login.body.token, undefined, headers);
    assert.equal(me.status, 200);
    assert.equal(me.body.id, login.body.user_id);

    ws = new WebSocket(`${gateway.body.url}?v=9&encoding=json`, { headers });
    const messages = on(ws, 'message');
    const next = async () => JSON.parse((await messages.next()).value[0]);
    const hello = await next();
    assert.equal(hello.op, 10);
    assert.equal(hello.d.heartbeat_interval, 41250);
    ws.send(JSON.stringify({ op: 2, d: {
      token: login.body.token,
      properties: { os: 'Android', browser: 'Cillhub Android', device: 'test' },
    } }));
    const ready = await next();
    assert.equal(ready.t, 'READY');
    assert.equal(ready.d.user.id, me.body.id);
    assert.equal(typeof ready.d.session_id, 'string');
    for (const key of ['guilds', 'private_channels', 'users', 'presences', 'read_state', 'relationships', 'recipient_read_states']) {
      assert.ok(Array.isArray(ready.d[key]), `${key} must remain an array for Android's Ready model`);
    }
    ws.send(JSON.stringify({ op: 3, d: { afk: true } }));
    ws.send(JSON.stringify({ op: 1, d: ready.s }));
    let ack = await next();
    while (ack.op === 0) ack = await next(); // presence dispatches may precede the ACK
    assert.equal(ack.op, 11);
    await messages.return();
  } finally {
    ws?.terminate();
    await srv.stop();
  }
});
