import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, guildWith } from './helpers.js';

let srv, api, g, alice, bob;
before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob']);
  ({ alice, bob } = g.users);
});
after(() => srv.stop());

test('connections: CRUD connections, show_on_profile toggle, reflected in GET /users/:id/profile connected_accounts', async () => {
  // 1. Initial list is empty
  const init = (await api('GET', '/users/@me/connections', alice.token)).body;
  assert.deepEqual(init, []);

  // 2. Add GitHub connection
  const gh = (await api('POST', '/users/@me/connections', alice.token, {
    type: 'github',
    name: 'torvalds',
    show_on_profile: true,
    metadata: { profile_url: 'https://github.com/torvalds' },
  })).body;
  assert.ok(gh.id);
  assert.equal(gh.type, 'github');
  assert.equal(gh.name, 'torvalds');
  assert.equal(gh.verified, false);
  assert.equal(gh.show_on_profile, true);
  assert.deepEqual(gh.metadata, { profile_url: 'https://github.com/torvalds' });

  // 3. Add Steam connection with show_on_profile = false
  const steam = (await api('POST', '/users/@me/connections', alice.token, {
    type: 'steam',
    name: 'gaben',
    show_on_profile: false,
  })).body;
  assert.ok(steam.id);
  assert.equal(steam.show_on_profile, false);

  // 4. Duplicate connection returns 400
  const dup = await api('POST', '/users/@me/connections', alice.token, {
    type: 'github',
    name: 'torvalds',
  });
  assert.equal(dup.status, 400);

  // 5. GET /users/@me/connections returns both
  const list = (await api('GET', '/users/@me/connections', alice.token)).body;
  assert.equal(list.length, 2);

  // 6. Bob checks Alice's profile: only GitHub is in connected_accounts
  const profile1 = (await api('GET', `/users/${alice.id}/profile`, bob.token)).body;
  assert.ok(Array.isArray(profile1.connected_accounts));
  assert.equal(profile1.connected_accounts.length, 1);
  assert.equal(profile1.connected_accounts[0].name, 'torvalds');
  assert.equal(profile1.connected_accounts[0].type, 'github');

  // 7. Bob cannot modify Alice's connection
  const bobPatch = await api('PATCH', `/users/@me/connections/${steam.id}`, bob.token, { show_on_profile: true });
  assert.equal(bobPatch.status, 404);

  // 8. Alice updates steam to show_on_profile: true
  const patchRes = await api('PATCH', `/users/@me/connections/${steam.id}`, alice.token, { show_on_profile: true });
  assert.equal(patchRes.status, 200);
  assert.equal(patchRes.body.show_on_profile, true);

  // 9. Now Bob sees both in Alice's profile
  const profile2 = (await api('GET', `/users/${alice.id}/profile`, bob.token)).body;
  assert.equal(profile2.connected_accounts.length, 2);

  // 10. Delete steam connection
  const delRes = await api('DELETE', `/users/@me/connections/${steam.id}`, alice.token);
  assert.ok(delRes.status === 204 || delRes.status === 200);

  // 11. Profile now only has 1
  const profile3 = (await api('GET', `/users/${alice.id}/profile`, bob.token)).body;
  assert.equal(profile3.connected_accounts.length, 1);
  assert.equal(profile3.connected_accounts[0].type, 'github');
});

test('connections: invalid type, name, metadata, profile_url and over-cap POSTs are refused with 400', async () => {
  const post = body => api('POST', '/users/@me/connections', bob.token, body);
  const count = async () => (await api('GET', '/users/@me/connections', bob.token)).body.length;
  assert.equal(await count(), 0);

  const badBodies = [
    { type: 'a'.repeat(33), name: 'ok' },
    { type: 'bad slug!', name: 'ok' },
    { type: 'github', name: 'a'.repeat(101) },
    { type: 123, name: 'ok' },
    { type: { x: 1 }, name: 'ok' },
    { type: ['github'], name: 'ok' },
    { type: 'github', name: 123 },
    { type: 'github', name: { x: 1 } },
    { type: 'github', name: ['bob'] },
    { type: 'github', name: 'ok', metadata: 'plain-string' },
    { type: 'github', name: 'ok', metadata: '' },
    { type: 'github', name: 'ok', metadata: 42 },
    { type: 'github', name: 'ok', metadata: 0 },
    { type: 'github', name: 'ok', metadata: ['a'] },
    { type: 'github', name: 'ok', metadata: { big: 'x'.repeat(1100) } },
    { type: 'github', name: 'ok', metadata: { profile_url: 'javascript:alert(1)' } },
    { type: 'github', name: 'ok', metadata: { profile_url: 'data:text/html,<script>alert(1)</script>' } },
  ];
  for (const body of badBodies) {
    const r = await post(body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal(await count(), 0, 'no invalid connection was stored');

  // Custom lower-case slug + 100-char name still works, and cap stops at 25.
  const first = await post({ type: 'my_custom-site', name: 'a'.repeat(100), metadata: { profile_url: 'https://example.org/u' } });
  assert.equal(first.status, 201);
  for (let i = 1; i < 25; i++) {
    assert.equal((await post({ type: 'github', name: `user${i}` })).status, 201);
  }
  assert.equal(await count(), 25);
  const over = await post({ type: 'github', name: 'user26' });
  assert.equal(over.status, 400);
  assert.equal(await count(), 25, 'over-cap connection was not stored');
});

test('connections: PATCH refuses bad/oversized metadata without changing row, clears on null', async () => {
  const created = await api('POST', '/users/@me/connections', alice.token, {
    type: 'twitch',
    name: 'patch_target',
    metadata: { profile_url: 'https://twitch.tv/patch_target' },
  });
  assert.equal(created.status, 201);
  const target = created.body;
  const origMeta = target.metadata;

  for (const bad of ['str', '', 42, 0, ['a'], { big: 'x'.repeat(1100) }, { profile_url: 'javascript:alert(1)' }, { profile_url: 'data:text/plain,hi' }]) {
    const r = await api('PATCH', `/users/@me/connections/${target.id}`, alice.token, { metadata: bad });
    assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 60));
  }
  const afterBad = (await api('GET', '/users/@me/connections', alice.token)).body.find(c => c.id === target.id);
  assert.deepEqual(afterBad.metadata, origMeta, 'stored metadata is unchanged after refused PATCH');

  const cleared = await api('PATCH', `/users/@me/connections/${target.id}`, alice.token, { metadata: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.metadata, null);
});

test('connections: legacy row with over-long name remains listable and deletable', async () => {
  const legacyId = 'legacy-conn-overlong';
  const longName = 'z'.repeat(500);
  const db = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite'));
  try {
    db.prepare(
      'INSERT INTO user_connections (id, user_id, type, name, verified, show_on_profile, metadata, created_at) VALUES (?, ?, ?, ?, 0, 1, NULL, ?)',
    ).run(legacyId, alice.id, 'legacy', longName, new Date().toISOString());
  } finally { db.close(); }

  const listed = (await api('GET', '/users/@me/connections', alice.token)).body;
  const row = listed.find(c => c.id === legacyId);
  assert.ok(row, 'legacy over-long row is still listed');
  assert.equal(row.name, longName);

  const del = await api('DELETE', `/users/@me/connections/${legacyId}`, alice.token);
  assert.equal(del.status, 204);
  const afterDel = (await api('GET', '/users/@me/connections', alice.token)).body;
  assert.equal(afterDel.find(c => c.id === legacyId), undefined);
});
