import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, guildWith } from './helpers.js';

let srv, api, g, alice, bob;
before(async () => {
  srv = await startServer({ env: { CILLCORD_RATE_LIMIT_SCALE: '1' } });
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob']);
  ({ alice, bob } = g.users);
  alice.gw = await srv.gateway(alice.token);
  bob.gw1 = await srv.gateway(bob.token);
  bob.gw2 = await srv.gateway(bob.token);
});
after(() => srv.stop());

test('plain message arrives once per session with identical payload', async () => {
  const r = await api('POST', `/channels/${g.general.id}/messages`, alice.token, { content: 'hello fanout' });
  assert.equal(r.status, 201);
  const [evA, evB1, evB2] = await Promise.all([
    alice.gw.event('MESSAGE_CREATE', d => d.id === r.body.id),
    bob.gw1.event('MESSAGE_CREATE', d => d.id === r.body.id),
    bob.gw2.event('MESSAGE_CREATE', d => d.id === r.body.id),
  ]);
  assert.deepEqual(evA, evB1);
  assert.deepEqual(evB1, evB2);
  assert.equal(await bob.gw1.none(f => f.t === 'MESSAGE_CREATE' && f.d.id === r.body.id, 100), true);
  assert.equal(await bob.gw2.none(f => f.t === 'MESSAGE_CREATE' && f.d.id === r.body.id, 100), true);
});

test('message with a reaction by user A shows me:true only to A after an update and in referenced_message', async () => {
  const m = (await api('POST', `/channels/${g.general.id}/messages`, alice.token, { content: 'react target' })).body;
  await Promise.all([
    alice.gw.event('MESSAGE_CREATE', d => d.id === m.id),
    bob.gw1.event('MESSAGE_CREATE', d => d.id === m.id),
    bob.gw2.event('MESSAGE_CREATE', d => d.id === m.id),
  ]);

  const react = await api('PUT', `/channels/${g.general.id}/messages/${m.id}/reactions/${encodeURIComponent('👍')}/@me`, alice.token);
  assert.equal(react.status, 204);

  const edit = await api('PATCH', `/channels/${g.general.id}/messages/${m.id}`, alice.token, { content: 'react target edited' });
  assert.equal(edit.status, 200);

  const [updA, updB1, updB2] = await Promise.all([
    alice.gw.event('MESSAGE_UPDATE', d => d.id === m.id),
    bob.gw1.event('MESSAGE_UPDATE', d => d.id === m.id),
    bob.gw2.event('MESSAGE_UPDATE', d => d.id === m.id),
  ]);
  assert.deepEqual(updA.reactions, [{ emoji: { id: null, name: '👍' }, count: 1, me: true }]);
  assert.deepEqual(updB1.reactions, [{ emoji: { id: null, name: '👍' }, count: 1, me: false }]);
  assert.deepEqual(updB1, updB2);

  const reply = await api('POST', `/channels/${g.general.id}/messages`, bob.token, {
    content: 'replying to reacted message',
    message_reference: { message_id: m.id },
  });
  assert.equal(reply.status, 201);
  const [repA, repB1, repB2] = await Promise.all([
    alice.gw.event('MESSAGE_CREATE', d => d.id === reply.body.id),
    bob.gw1.event('MESSAGE_CREATE', d => d.id === reply.body.id),
    bob.gw2.event('MESSAGE_CREATE', d => d.id === reply.body.id),
  ]);
  assert.equal(repA.referenced_message.reactions[0].me, true);
  assert.equal(repB1.referenced_message.reactions[0].me, false);
  assert.deepEqual(repB1, repB2);
});

test('6 typing calls in 5 s give one 429', async () => {
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await api('POST', `/channels/${g.general.id}/typing`, alice.token);
    statuses.push(r.status);
  }
  assert.deepEqual(statuses, [204, 204, 204, 204, 204, 429]);
});


test('payload factories skip absent recipients and plain broadcasts share an object', async () => {
  process.env.DATA_DIR = srv.dataDir;
  const { db } = await import('../src/db.js');
  const { sendToUsers, moduleSinks } = await import('../src/gateway.js');
  const { broadcastMessage, getMessage, getChannel } = await import('../src/message.js');
  const received = [];
  const calls = [];
  for (const user of [alice, bob]) moduleSinks.set(user.id, (t, d) => received.push(d));
  try {
    sendToUsers([alice.id, alice.id, bob.id, 'absent'], 'TEST', id => {
      calls.push(id);
      return Object.freeze({ id });
    });
    assert.deepEqual(calls, [alice.id, bob.id]);
    assert.equal(received.length, 2);
    received.length = 0;
    const result = await api('POST', `/channels/${g.general.id}/messages`, alice.token, { content: 'shared object' });
    assert.equal(result.status, 201);
    broadcastMessage(getChannel(g.general.id), 'MESSAGE_CREATE', getMessage(result.body.id));
    assert.equal(received.length, 2);
    assert.equal(received[0], received[1]);
  } finally {
    moduleSinks.delete(alice.id);
    moduleSinks.delete(bob.id);
    db.close();
  }
});
