import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { startServer, guildWith } from './helpers.js';

let srv, api, g, alice, bob, stranger;
before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob']);
  ({ alice, bob } = g.users);
  alice.gw = await srv.gateway(alice.token);
  bob.gw = await srv.gateway(bob.token);
  stranger = await srv.register('stranger');
});
after(() => srv.stop());

test('onboarding: get, put config, respond assigns roles, emits events, checks permissions', async () => {
  const guildId = g.guild.id;

  // Initial GET
  const init = (await api('GET', `/guilds/${guildId}/onboarding`, alice.token)).body;
  assert.equal(init.enabled, false);
  assert.deepEqual(init.prompts, []);

  // Create a role to assign via onboarding
  const gamerRole = (await api('POST', `/guilds/${guildId}/roles`, alice.token, { name: 'Gamer' })).body;

  // PUT onboarding config
  const putRes = await api('PUT', `/guilds/${guildId}/onboarding`, alice.token, {
    enabled: true,
    prompts: [
      {
        title: 'Choose your interests',
        single_select: false,
        required: true,
        options: [
          { title: 'Gaming', description: 'Access to gaming channels', role_ids: [gamerRole.id], channel_ids: [g.general.id] }
        ]
      }
    ]
  });
  assert.equal(putRes.status, 200);
  assert.equal(putRes.body.enabled, true);
  assert.equal(putRes.body.prompts.length, 1);
  const prompt = putRes.body.prompts[0];
  const option = prompt.options[0];
  assert.ok(prompt.id);
  assert.ok(option.id);

  // Bob receives GUILD_ONBOARDING_UPDATE event
  const obEv = await bob.gw.event('GUILD_ONBOARDING_UPDATE', d => d.guild_id === guildId);
  assert.equal(obEv.enabled, true);

  // Bob responds to onboarding
  const resp = await api('POST', `/guilds/${guildId}/onboarding/respond`, bob.token, {
    option_ids: [option.id]
  });
  assert.equal(resp.status, 200);
  assert.equal(resp.body.success, true);
  assert.deepEqual(resp.body.assigned_roles, [gamerRole.id]);

  // Bob should now have the role
  const member = (await api('GET', `/guilds/${guildId}/members/${bob.id}`, alice.token)).body;
  assert.ok(member.roles.includes(gamerRole.id));

  // Non-manager cannot configure onboarding
  const forbiddenPut = await api('PUT', `/guilds/${guildId}/onboarding`, bob.token, { enabled: false });
  assert.equal(forbiddenPut.status, 403);
});

test('analytics: records messages and joins, returns daily metrics to manager', async () => {
  const guildId = g.guild.id;

  // Send a message in general to trigger messages_sent metric
  await api('POST', `/channels/${g.general.id}/messages`, alice.token, { content: 'test metric' });

  // Alice (owner/manager) fetches analytics
  const res = await api('GET', `/guilds/${guildId}/analytics?days=7`, alice.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.guild_id, guildId);
  assert.ok(Array.isArray(res.body.daily));
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayEntry = res.body.daily.find(d => d.date === todayStr);
  assert.ok(todayEntry);
  assert.ok(todayEntry.messages_sent >= 1);
  assert.ok(todayEntry.joins >= 1); // bob joined

  // Stranger cannot fetch analytics
  const forbidden = await api('GET', `/guilds/${guildId}/analytics`, stranger.token);
  assert.equal(forbidden.status, 403);
});

test('onboarding: a single_select prompt hands out one option, answering again swaps it, a timed-out member cannot answer', async () => {
  const G = g.guild.id;
  const role = async name => (await api('POST', `/guilds/${G}/roles`, alice.token, { name })).body.id;
  const [a, b, c, shared, x, y] = [await role('a'), await role('b'), await role('c'), await role('shared'), await role('x'), await role('y')];
  const put = await api('PUT', `/guilds/${G}/onboarding`, alice.token, {
    enabled: true,
    prompts: [
      { title: 'Pick one', single_select: true, options: [{ title: 'A', role_ids: [a, shared] }, { title: 'B', role_ids: [b, shared] }, { title: 'C', role_ids: [c] }] },
      { title: 'Pick any', single_select: false, options: [{ title: 'X', role_ids: [x] }, { title: 'Y', role_ids: [y] }] },
    ],
  });
  assert.equal(put.status, 200);
  const [[A, B, C], [X, Y]] = put.body.prompts.map(p => p.options.map(o => o.id));
  const signUp = async name => { const u = await srv.register(name); assert.equal((await api('POST', `/invites/${g.invite.code}`, u.token)).status, 200); return u; };
  const roles = async u => (await api('GET', `/guilds/${G}/members/${u.id}`, alice.token)).body.roles.sort();
  const answer = (u, ids) => api('POST', `/guilds/${G}/onboarding/respond`, u.token, { option_ids: ids });
  const sorted = (...ids) => ids.sort();

  const cleo = await signUp('cleo');
  const two = await answer(cleo, [A, B]);
  assert.equal(two.status, 400);
  assert.equal(two.body.errors.option_ids._errors.length, 1);
  assert.deepEqual(await roles(cleo), [], 'nothing assigned');
  assert.equal((await answer(cleo, [A, X, Y])).status, 200);
  assert.deepEqual(await roles(cleo), sorted(a, shared, x, y), 'a multi-select prompt still adds both');
  const swap = await answer(cleo, [B]);
  assert.equal(swap.status, 200);
  assert.deepEqual(swap.body.assigned_roles.sort(), sorted(b, shared));
  assert.deepEqual(await roles(cleo), sorted(b, shared, x, y), 'the second answer replaces the first; the shared role and other prompts stay');
  assert.equal((await answer(cleo, [B])).status, 200);
  assert.deepEqual(await roles(cleo), sorted(b, shared, x, y), 'the same answer twice changes nothing');
  assert.equal((await answer(cleo, [C, 'nope'])).status, 200);
  assert.deepEqual(await roles(cleo), sorted(c, x, y), 'unknown option ids are ignored; the shared role goes with its options');
  assert.equal((await answer(cleo, [X])).status, 200);
  assert.deepEqual(await roles(cleo), sorted(c, x, y), 'an answer about another prompt leaves the single_select choice alone');

  // a timed-out member may not answer; a pending one may
  const dev = await signUp('dev');
  const eli = await signUp('eli');
  assert.equal((await api('PATCH', `/guilds/${G}/members/${dev.id}`, alice.token, { communication_disabled_until: new Date(Date.now() + 3_600_000).toISOString() })).status, 200);
  const refused = await answer(dev, [A]);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 50013);
  assert.deepEqual(await roles(dev), []);
  const db = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite'));
  try { db.prepare('UPDATE members SET pending = 1 WHERE guild_id = ? AND user_id = ?').run(G, eli.id); } finally { db.close(); }
  assert.equal((await answer(eli, [A])).status, 200);
  assert.deepEqual(await roles(eli), sorted(a, shared));
  await api('PATCH', `/guilds/${G}/members/${dev.id}`, alice.token, { communication_disabled_until: null });
  assert.equal((await answer(dev, [A])).status, 200, 'works again once the timeout is lifted');
});
