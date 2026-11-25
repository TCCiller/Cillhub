import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, guildWith } from './helpers.js';

let srv, api, g, ann, bo, app;
const dbRun = (sql, ...args) => { const db = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite')); try { return db.prepare(sql).run(...args); } finally { db.close(); } };
before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['ann', 'bo']);
  ({ ann, bo } = g.users);
  app = (await api('POST', '/applications', ann.token, { name: 'Helper' })).body;
  await api('POST', `/oauth2/authorize?client_id=${app.id}&scope=bot`, ann.token, { authorize: true, guild_id: g.guild.id, permissions: '3072' });
});
after(() => srv.stop());

test('timed-out and pending members are refused component clicks and modal submits', async () => {
  const base = { application_id: app.id, channel_id: g.general.id };
  const click = () => api('POST', '/interactions', bo.token, { ...base, type: 3, message_id: '1', data: { component_type: 2, custom_id: 'x' } });
  const modal = () => api('POST', '/interactions', bo.token, { ...base, type: 5, data: { id: '1', custom_id: 'f', components: [] } });
  const restricted = [
    [() => api('PATCH', `/guilds/${g.guild.id}/members/${bo.id}`, ann.token, { communication_disabled_until: new Date(Date.now() + 36e5).toISOString() }),
      () => api('PATCH', `/guilds/${g.guild.id}/members/${bo.id}`, ann.token, { communication_disabled_until: null })],
    [() => dbRun('UPDATE members SET pending = 1 WHERE guild_id = ? AND user_id = ?', g.guild.id, bo.id),
      () => dbRun('UPDATE members SET pending = 0 WHERE guild_id = ? AND user_id = ?', g.guild.id, bo.id)],
  ];
  // a normal member gets past the restriction gate (the fake message or modal is then simply unknown)
  assert.notEqual((await click()).status, 403);
  assert.notEqual((await modal()).status, 403);
  for (const [on, off] of restricted) {
    await on();
    for (const r of [await click(), await modal()]) {
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 50013);
    }
    await off();
  }
});
