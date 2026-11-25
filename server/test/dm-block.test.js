import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, guildWith, until } from './helpers.js';

let srv, api, ann, bo;
before(async () => {
  srv = await startServer();
  api = srv.api;
  ({ users: { ann, bo } } = await guildWith(srv, ['ann', 'bo']));
});
after(() => srv.stop());

test('a blocked user is denied every DM write path, and gets them back after unblock', async () => {
  const dm = (await api('POST', '/users/@me/channels', ann.token, { recipient_id: bo.id })).body;
  const mine = (await api('POST', `/channels/${dm.id}/messages`, bo.token, { content: 'hi' })).body;
  const theirs = (await api('POST', `/channels/${dm.id}/messages`, ann.token, { content: 'yo' })).body;
  const c = `/channels/${dm.id}`;
  const attempts = () => [
    ['PUT', `${c}/canvas`, { content: 'spam' }],
    ['PATCH', `${c}/messages/${mine.id}`, { content: 'edited' }],
    ['POST', `${c}/whiteboard/stroke`, { stroke: { x: 1 } }],
    ['DELETE', `${c}/whiteboard`],
    ['PUT', `${c}/pins/${theirs.id}`],
    ['PUT', `${c}/messages/${theirs.id}/reactions/%F0%9F%91%8D/@me`],
    ['POST', `${c}/typing`],
  ];
  assert.equal((await api('PUT', `/users/@me/relationships/${bo.id}`, ann.token, { type: 2 })).status, 204);
  for (const [m, p, b] of attempts()) {
    const r = await api(m, p, bo.token, b);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.body.code, 50007);
  }
  // the blocker is locked out the same way (blocking is one-sided but closes the DM for both)
  assert.equal((await api('PUT', `${c}/canvas`, ann.token, { content: 'x' })).status, 403);
  await api('DELETE', `/users/@me/relationships/${bo.id}`, ann.token);
  for (const [m, p, b] of attempts()) assert.ok((await api(m, p, bo.token, b)).status < 300, `${m} ${p} after unblock`);
});

test('a blocked user is also denied unpin, reaction removal, polls, encryption keys and recurring messages, and sends no read receipt', async () => {
  const dm = (await api('POST', '/users/@me/channels', ann.token, { recipient_id: bo.id })).body;
  const c = `/channels/${dm.id}`;
  const poll = { question: { text: 'Pizza?' }, answers: [{ poll_media: { text: 'Yes' } }, { poll_media: { text: 'No' } }], duration: 1 };
  const theirs = (await api('POST', `${c}/messages`, ann.token, { content: 'pinned' })).body;
  const annPoll = (await api('POST', `${c}/messages`, ann.token, { poll })).body;
  const boPoll = (await api('POST', `${c}/messages`, bo.token, { poll })).body;
  const react = `${c}/messages/${theirs.id}/reactions/%F0%9F%91%8D/@me`;
  assert.equal((await api('PUT', `${c}/pins/${theirs.id}`, ann.token)).status, 204);
  assert.equal((await api('PUT', react, bo.token)).status, 204);
  assert.equal((await api('PUT', `/users/@me/relationships/${bo.id}`, ann.token, { type: 2 })).status, 204);
  const gw = await srv.gateway(ann.token);
  const denied = [
    ['DELETE', `${c}/pins/${theirs.id}`],
    ['DELETE', react],
    ['PUT', `${c}/polls/${annPoll.id}/answers/@me`, { answer_ids: [1] }],
    ['POST', `${c}/polls/${boPoll.id}/expire`],
    ['PUT', `${c}/e2ee/epoch`, { epoch: 1, wraps: {} }],
    ['PUT', `${c}/e2ee/wraps`, { epoch: 0, wraps: {} }],
    ['POST', `${c}/recurring-messages`, { content: 'ping', interval_type: 'daily', time_of_day: '00:00' }],
  ];
  for (const [m, p, b] of denied) {
    const r = await api(m, p, bo.token, b);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.body.code, 50007);
  }
  // the ack itself works, but the blocker is not told
  assert.equal((await api('POST', `${c}/messages/${theirs.id}/ack`, bo.token, { token: null })).status, 200);
  assert.ok(await gw.none(f => f.t === 'CHANNEL_RECIPIENT_ACK' && f.d.user_id === bo.id), 'no peer ack for a blocked pair');
  await api('DELETE', `/users/@me/relationships/${bo.id}`, ann.token);
  assert.equal((await api('DELETE', `${c}/pins/${theirs.id}`, bo.token)).status, 204);
  assert.equal((await api('PUT', `${c}/polls/${annPoll.id}/answers/@me`, bo.token, { answer_ids: [1] })).status, 204);
});

test('a declined message request closes the DM to the requester only until accepted again or the pair are friends', async () => {
  const { users: { cy, di } } = await guildWith(srv, ['cy', 'di']);
  const dm = (await api('POST', '/users/@me/channels', cy.token, { recipient_id: di.id })).body;
  const send = t => api('POST', `/channels/${dm.id}/messages`, t, { content: 'hi' });
  const put = status => api('PUT', `/users/@me/message-requests/${dm.id}`, di.token, { status });
  assert.equal((await send(cy.token)).status, 201); // pending
  assert.equal((await put('declined')).status, 200);
  const r = await send(cy.token);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 50007);
  assert.equal((await api('POST', `/channels/${dm.id}/typing`, cy.token)).status, 403);
  assert.equal((await send(di.token)).status, 201); // the decliner is not locked out
  assert.equal((await put('accepted')).status, 200);
  assert.equal((await send(cy.token)).status, 201);
  await put('declined');
  assert.equal((await send(cy.token)).status, 403);
  await api('PUT', `/users/@me/relationships/${di.id}`, cy.token, {});
  await api('PUT', `/users/@me/relationships/${cy.id}`, di.token, {});
  assert.equal((await send(cy.token)).status, 201); // friends
});

test('a declined request also stops scheduled and recurring messages, message_ttl, calls and the read receipt', async () => {
  const { users: { ed, fy }, general } = await guildWith(srv, ['ed', 'fy']);
  const dm = (await api('POST', '/users/@me/channels', ed.token, { recipient_id: fy.id })).body;
  const c = `/channels/${dm.id}`;
  const at = () => new Date(Date.now() + 3_600_000).toISOString();
  const db = fn => { const d = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite')); try { return fn(d); } finally { d.close(); } };
  const queued = (await api('POST', `${c}/scheduled-messages`, ed.token, { content: 'queued', send_at: at() })).body;
  assert.equal((await api('POST', `${c}/recurring-messages`, ed.token, { content: 'tick' })).status, 201);
  const theirs = (await api('POST', `${c}/messages`, fy.token, { content: 'yo' })).body;
  assert.equal((await api('GET', `${c}/call`, ed.token)).body.ringable, true);
  assert.equal((await api('PUT', `/users/@me/message-requests/${dm.id}`, fy.token, { status: 'declined' })).status, 200);
  const gw = await srv.gateway(fy.token);
  const edGw = await srv.gateway(ed.token);
  for (const [m, p, b] of [['POST', `${c}/scheduled-messages`, { content: 'later', send_at: at() }], ['PATCH', `/users/@me/scheduled-messages/${queued.id}`, { content: 'edited' }], ['POST', `${c}/recurring-messages`, { content: 'tock' }]]) {
    const r = await api(m, p, ed.token, b);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.body.code, 50007);
  }
  assert.equal((await api('PATCH', c, ed.token, { message_ttl: 60 })).status, 403);
  assert.ok(await gw.none(f => f.t === 'CHANNEL_UPDATE'), 'no CHANNEL_UPDATE to the decliner');
  assert.equal((await api('GET', `${c}/call`, ed.token)).body.ringable, false);
  edGw.send({ op: 4, d: { guild_id: null, channel_id: dm.id, self_mute: false, self_deaf: false } });
  assert.ok(await edGw.none(f => f.t === 'VOICE_SERVER_UPDATE'), 'no call start');
  assert.equal((await api('POST', `${c}/messages/${theirs.id}/ack`, ed.token, { token: null })).status, 200);
  assert.ok(await gw.none(f => f.t === 'CHANNEL_RECIPIENT_ACK'), 'no receipt to the decliner');
  // delivery re-checks: the queued message and the recurring one come due after the decline and are not sent
  db(d => { d.prepare('UPDATE scheduled_messages SET send_at = 1 WHERE id = ?').run(queued.id); d.prepare('UPDATE recurring_messages SET next_run = 1 WHERE channel_id = ?').run(dm.id); });
  assert.equal((await api('POST', `/channels/${general.id}/scheduled-messages`, ed.token, { content: 'wake', send_at: at() })).status, 201); // re-arms the timer
  await until(() => db(d => d.prepare('SELECT COUNT(*) AS n FROM recurring_messages WHERE channel_id = ? AND next_run = 1').get(dm.id).n === 0));
  const texts = (await api('GET', `${c}/messages`, fy.token)).body.map(m => m.content);
  assert.deepEqual(texts, ['yo']);
  // accepted again, everything works
  await api('PUT', `/users/@me/message-requests/${dm.id}`, fy.token, { status: 'accepted' });
  assert.equal((await api('POST', `${c}/scheduled-messages`, ed.token, { content: 'later', send_at: at() })).status, 201);
  assert.equal((await api('PATCH', c, ed.token, { message_ttl: 60 })).status, 200);
  assert.equal((await api('GET', `${c}/call`, ed.token)).body.ringable, true);
});
