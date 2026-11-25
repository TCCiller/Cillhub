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

test('the invite list and revoke do not name channels the manager cannot see', async () => {
  const G = g.guild.id;
  const role = (await api('POST', `/guilds/${G}/roles`, ann.token, { name: 'mgr', permissions: bits(5) })).body;
  await api('PATCH', `/guilds/${G}/members/${bo.id}`, ann.token, { roles: [role.id] });
  const secret = (await api('POST', `/guilds/${G}/channels`, ann.token, { name: 'secret-ops', type: 0, permission_overwrites: [{ id: G, type: 0, deny: bits(10) }] })).body;
  const hidden = (await api('POST', `/channels/${secret.id}/invites`, ann.token, { max_age: 0 })).body;

  const list = (await api('GET', `/guilds/${G}/invites`, bo.token)).body;
  assert.ok(!JSON.stringify(list).includes('secret-ops') && !JSON.stringify(list).includes(secret.id), 'hidden channel is not named');
  assert.ok(list.some(i => i.code === hidden.code), 'the invite itself is still listed');
  const visible = list.find(i => i.code === g.invite.code);
  assert.equal(visible.channel.id, g.general.id, 'visible channels still list fully');
  assert.equal(visible.channel.name, 'general');
  assert.equal((await api('GET', `/guilds/${G}/invites`, ann.token)).body.find(i => i.code === hidden.code).channel.name, 'secret-ops');

  const revoked = await api('DELETE', `/invites/${hidden.code}`, bo.token);
  assert.equal(revoked.status, 200);
  assert.ok(!JSON.stringify(revoked.body).includes('secret-ops'));
});

test('the public invite preview names the channel only to someone who can view it', async () => {
  const G = g.guild.id;
  const insider = (await api('POST', `/guilds/${G}/roles`, ann.token, { name: 'insider' })).body;
  const secret = (await api('POST', `/guilds/${G}/channels`, ann.token, {
    name: 'vault-ops', type: 0, permission_overwrites: [{ id: G, type: 0, deny: bits(10) }, { id: insider.id, type: 0, allow: bits(10) }],
  })).body;
  const hidden = (await api('POST', `/channels/${secret.id}/invites`, ann.token, { max_age: 0 })).body;
  const di = await srv.register('di');
  const cy = await srv.register('cy');
  assert.equal((await api('POST', `/invites/${g.invite.code}`, di.token)).status, 200);
  await api('PATCH', `/guilds/${G}/members/${di.id}`, ann.token, { roles: [insider.id] });
  const preview = (code, who, q = '') => api('GET', `/invites/${code}${q}`, who?.token ?? null);

  for (const [who, label] of [[null, 'signed out'], [cy, 'outsider'], [bo, 'member without the role']]) {
    const r = await preview(hidden.code, who, '?with_counts=true');
    assert.equal(r.status, 200, label);
    assert.equal(r.body.channel, null, label);
    assert.ok(!JSON.stringify(r.body).includes('vault-ops') && !JSON.stringify(r.body).includes(secret.id), `${label}: no name anywhere`);
    assert.deepEqual([r.body.guild.id, r.body.guild.name, r.body.code, r.body.inviter.id, r.body.approximate_member_count], [G, g.guild.name, hidden.code, ann.id, 3], label);
  }
  const seen = (await preview(hidden.code, di)).body;
  assert.deepEqual(seen.channel, { id: secret.id, name: 'vault-ops', type: 0 }, 'a member who can view it');
  assert.equal((await preview(hidden.code, ann)).body.channel.name, 'vault-ops', 'the owner');
  assert.equal((await api('GET', `/invites/${hidden.code}`, 'not-a-token')).body.channel, null, 'a bad token is just anonymous');

  for (const who of [null, cy, bo, di]) assert.equal((await preview(g.invite.code, who)).body.channel.name, 'general', 'a public channel previews for everyone');
  assert.equal((await api('POST', `/invites/${hidden.code}`, cy.token)).status, 200, 'joining through a hidden-channel invite still works');
});
