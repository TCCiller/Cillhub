import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, guildWith } from './helpers.js';

let srv, api, g, ann, bo, carol, out;
before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['ann', 'bo']);
  ({ ann, bo } = g.users);
  carol = await srv.register('carol');
  out = await srv.register('outsider');
});
after(() => srv.stop());

const befriend = async (a, b) => {
  assert.equal((await api('POST', '/users/@me/relationships', a.token, { username: b.name })).status, 204);
  assert.equal((await api('PUT', `/users/@me/relationships/${a.id}`, b.token, {})).status, 204);
};

test('mutual friends and guilds follow the profile rules: access first, then blocks', async () => {
  await befriend(ann, carol);
  await befriend(bo, carol);
  const friends = who => api('GET', `/users/${ann.id}/mutual-friends`, who.token);
  const guilds = who => api('GET', `/users/${ann.id}/mutual-guilds`, who.token);

  // a stranger gets what /profile gives: 403, so not ann's friends either
  assert.equal((await api('GET', `/users/${ann.id}/profile`, out.token)).status, 403);
  assert.equal((await friends(out)).status, 403);
  assert.equal((await guilds(out)).status, 403);
  // a shared friend alone does not open ann's profile
  await befriend(out, carol);
  assert.equal((await friends(out)).status, 403, 'a shared friend alone is no access');

  // legitimate mutuals
  assert.deepEqual((await friends(bo)).body.map(u => u.id), [carol.id]);
  assert.deepEqual((await guilds(bo)).body.map(x => x.id), [g.guild.id]);

  // ann blocks bo: /profile drops mutual_guilds, and so do these
  assert.equal((await api('PUT', `/users/@me/relationships/${bo.id}`, ann.token, { type: 2 })).status, 204);
  assert.equal((await api('GET', `/users/${ann.id}/profile`, bo.token)).body.mutual_guilds, undefined);
  assert.deepEqual((await guilds(bo)).body, []);
  assert.deepEqual((await friends(bo)).body, []);
});
