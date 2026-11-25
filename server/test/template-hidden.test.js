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

test('exports and templates leave out channels the member cannot see', async () => {
  const G = g.guild.id;
  const role = (await api('POST', `/guilds/${G}/roles`, ann.token, { name: 'mgr', permissions: bits(5) })).body;
  await api('PATCH', `/guilds/${G}/members/${bo.id}`, ann.token, { roles: [role.id] });
  const secret = (await api('POST', `/guilds/${G}/channels`, ann.token, { name: 'secret-ops', type: 0, topic: 'launch codes', permission_overwrites: [{ id: G, type: 0, deny: bits(10) }] })).body;
  const names = snap => snap.channels.map(c => c.name);
  const dump = JSON.stringify;

  const exp = await api('GET', `/guilds/${G}/export`, bo.token);
  assert.equal(exp.status, 200);
  assert.ok(names(exp.body.serialized_source_guild).includes('general'), 'visible channels still export');
  assert.ok(!dump(exp.body).includes('secret-ops') && !dump(exp.body).includes('launch codes'));

  const tpl = await api('POST', `/guilds/${G}/templates`, bo.token, { name: 'T' });
  assert.equal(tpl.status, 201, dump(tpl.body));
  assert.ok(!dump(tpl.body).includes('secret-ops') && !dump(tpl.body).includes('launch codes'));
  assert.ok(!dump((await api('GET', `/guilds/templates/${tpl.body.code}`, null)).body).includes('secret-ops'));

  // the owner sees everything
  assert.ok(names((await api('GET', `/guilds/${G}/export`, ann.token)).body.serialized_source_guild).includes(secret.name));
});
