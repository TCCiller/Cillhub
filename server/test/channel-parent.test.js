import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, guildWith, bits } from './helpers.js';

let srv, api, g, ann, bo;
before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['ann', 'bo']);
  ({ ann, bo } = g.users);
});
after(() => srv.stop());

test('creating a channel under a category needs sight of it and the right to grant what it hands down', async () => {
  const G = g.guild.id;
  const role = (await api('POST', `/guilds/${G}/roles`, ann.token, { name: 'chan-mod', permissions: bits(4) })).body;
  await api('PATCH', `/guilds/${G}/members/${bo.id}`, ann.token, { roles: [role.id] });
  const cat = async (name, overwrites) => { const r = await api('POST', `/guilds/${G}/channels`, ann.token, { name, type: 4, permission_overwrites: overwrites }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
  const make = parent_id => api('POST', `/guilds/${G}/channels`, bo.token, { name: 'new', type: 0, parent_id });
  const count = async () => (await api('GET', `/guilds/${G}/channels`, ann.token)).body.length;

  const secret = await cat('secret', [{ id: G, type: 0, deny: bits(10) }]);
  const before = await count();
  const r = await make(secret.id);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 50035, 'a hidden category answers like an unknown one');
  assert.equal(await count(), before, 'nothing created under a hidden category');

  const granting = await cat('granting', [{ id: G, type: 0, allow: bits(11) }]);
  assert.equal((await make(granting.id)).status, 403, 'overwrites the caller cannot set are not copied');

  const plain = await cat('plain', []);
  assert.equal((await make(plain.id)).status, 201, 'a visible category with nothing to hand down still works');

  await api('PATCH', `/guilds/${G}/roles/${role.id}`, ann.token, { permissions: bits(4, 28) });
  const ok = await make(granting.id);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.permission_overwrites.length, 1);
});

test('a category the caller cannot see answers like an unknown id on create, edit and reorder, and the current parent still passes', async () => {
  const G = g.guild.id;
  const role = (await api('POST', `/guilds/${G}/roles`, ann.token, { name: 'mover', permissions: bits(4) })).body;
  await api('PATCH', `/guilds/${G}/members/${bo.id}`, ann.token, { roles: [role.id] });
  const mk = async (name, type, extra = {}) => { const r = await api('POST', `/guilds/${G}/channels`, ann.token, { name, type, ...extra }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
  const hidden = await mk('hidden-cat', 4, { permission_overwrites: [{ id: G, type: 0, deny: bits(10) }] });
  const open = await mk('open-cat', 4);
  const open2 = await mk('open-cat-2', 4);
  const inHidden = await mk('kept', 0, { parent_id: hidden.id }); // made by the owner
  const mine = await mk('mine', 0, { parent_id: open.id });
  const unknown = '1';
  const channel = async id => (await api('GET', `/channels/${id}`, ann.token)).body;
  const events = await srv.gateway(ann.token);
  const audits = async () => (await api('GET', `/guilds/${G}/audit-logs`, ann.token)).body.audit_log_entries.length;
  const auditsBefore = await audits();
  const attempt = {
    edit: pid => api('PATCH', `/channels/${mine.id}`, bo.token, { parent_id: pid }),
    create: pid => api('POST', `/guilds/${G}/channels`, bo.token, { name: 'new', type: 0, parent_id: pid }),
    reorder: pid => api('PATCH', `/guilds/${G}/channels`, bo.token, [{ id: mine.id, position: 0, parent_id: pid }]),
  };
  const channelsBefore = (await api('GET', `/guilds/${G}/channels`, ann.token)).body.length;
  for (const [how, go] of Object.entries(attempt)) {
    const h = await go(hidden.id);
    const u = await go(unknown);
    assert.equal(h.status, 400, how);
    assert.equal(h.body.code, 50035, how);
    assert.deepEqual([h.status, h.body], [u.status, u.body], `${how}: hidden and unknown look the same`);
    assert.equal(h.body.errors.parent_id._errors[0].code, 'CHANNEL_PARENT_INVALID');
  }
  assert.equal((await channel(mine.id)).parent_id, open.id, 'nothing moved');
  assert.equal((await api('GET', `/guilds/${G}/channels`, ann.token)).body.length, channelsBefore, 'nothing created');
  assert.ok(await events.none(f => f.t === 'CHANNEL_UPDATE' || f.t === 'CHANNEL_CREATE'), 'no event');
  assert.equal(await audits(), auditsBefore, 'no audit entry');

  // honest paths
  assert.equal((await attempt.edit(open2.id)).status, 200);
  assert.equal((await channel(mine.id)).parent_id, open2.id);
  assert.equal((await attempt.edit(null)).status, 200);
  assert.equal((await channel(mine.id)).parent_id, null);
  assert.equal((await attempt.reorder(open.id)).status, 204);
  assert.equal((await attempt.create(open.id)).status, 201);
  assert.equal((await api('PATCH', `/channels/${mine.id}`, bo.token, { name: 'renamed' })).status, 200, 'parent_id left out');
  // the current parent sent back unchanged passes even when the caller cannot see it
  assert.equal((await api('PATCH', `/channels/${inHidden.id}`, ann.token, { parent_id: hidden.id })).status, 200);
  await api('PUT', `/channels/${inHidden.id}/permissions/${bo.id}`, ann.token, { type: 1, allow: bits(10), deny: '0' });
  assert.equal((await api('PATCH', `/channels/${inHidden.id}`, bo.token, { parent_id: hidden.id, name: 'kept2' })).status, 200, 'unchanged current parent');
  assert.equal((await api('PATCH', `/guilds/${G}/channels`, bo.token, [{ id: inHidden.id, position: 1, parent_id: hidden.id }])).status, 204);
  assert.equal((await api('PATCH', `/channels/${inHidden.id}`, ann.token, { parent_id: hidden.id })).status, 200, 'the owner moves anything');
  assert.equal((await api('PATCH', `/channels/${mine.id}`, ann.token, { parent_id: hidden.id })).status, 200);
  events.ws.close();
});
