import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, guildWith, png } from './helpers.js';

let srv, api, g, alice, bob, carol;
const friends = async (a, b) => {
  await api('POST', '/users/@me/relationships', a.token, { username: b.name });
  await api('PUT', `/users/@me/relationships/${a.id}`, b.token, {});
};

before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob', 'carol']);
  ({ alice, bob, carol } = g.users);
  for (const u of [alice, bob, carol]) u.gw = await srv.gateway(u.token);
  await friends(alice, bob);
  await friends(alice, carol);
});
after(() => srv.stop());

test('group DMs: friends only, at most 10 people, recipients added and removed, owner passes on', async () => {
  const strangers = [];
  for (let i = 0; i < 10; i++) {
    const u = await srv.register(`friend${i}`);
    await friends(alice, { ...u, name: `friend${i}` });
    strangers.push(u);
  }
  const outsider = await srv.register('outsider');
  assert.equal((await api('POST', '/users/@me/channels', alice.token, { recipients: [bob.id, outsider.id] })).status, 403);
  assert.equal((await api('POST', '/users/@me/channels', alice.token, { recipients: strangers.map(s => s.id) })).body.code, 30014);
  const group = (await api('POST', '/users/@me/channels', alice.token, { recipients: [bob.id, ...strangers.slice(0, 7).map(s => s.id)] })).body;
  assert.deepEqual([group.type, group.owner_id, group.recipients.length], [3, alice.id, 8]);
  assert.equal((await bob.gw.event('CHANNEL_CREATE', c => c.id === group.id)).type, 3);
  assert.equal((await api('PUT', `/channels/${group.id}/recipients/${carol.id}`, alice.token)).status, 204);
  assert.equal((await bob.gw.event('CHANNEL_RECIPIENT_ADD')).user.id, carol.id);
  assert.equal((await api('PUT', `/channels/${group.id}/recipients/${strangers[8].id}`, alice.token)).body.code, 30014, '10 is the limit');
  // messages work as in DMs
  await api('POST', `/channels/${group.id}/messages`, carol.token, { content: 'hi group' });
  assert.equal((await bob.gw.event('MESSAGE_CREATE', m => m.channel_id === group.id)).content, 'hi group');
  assert.equal((await api('PATCH', `/channels/${group.id}`, bob.token, { name: 'Squad', icon: `data:image/png;base64,${png().toString('base64')}` })).body.name, 'Squad');
  assert.equal((await api('DELETE', `/channels/${group.id}/recipients/${carol.id}`, bob.token)).status, 403, 'only the owner removes others');
  assert.equal((await api('DELETE', `/channels/${group.id}/recipients/${carol.id}`, alice.token)).status, 204);
  assert.equal((await carol.gw.event('CHANNEL_DELETE', c => c.id === group.id)).id, group.id);
  assert.equal((await bob.gw.event('CHANNEL_RECIPIENT_REMOVE')).user.id, carol.id);
  assert.equal((await api('DELETE', `/channels/${group.id}`, alice.token)).status, 200);
  const update = await bob.gw.event('CHANNEL_UPDATE', c => c.id === group.id && c.owner_id !== alice.id);
  assert.ok(update.owner_id);
  // adding someone to a 1:1 DM makes a new group
  const dm = (await api('POST', '/users/@me/channels', alice.token, { recipient_id: bob.id })).body;
  const made = await api('PUT', `/channels/${dm.id}/recipients/${carol.id}`, alice.token);
  assert.deepEqual([made.body.type, made.body.recipients.length], [3, 2]);
});

test('blocking: removes friendship, stops DMs and friend requests both ways', async () => {
  const dm = (await api('POST', '/users/@me/channels', alice.token, { recipient_id: bob.id })).body;
  assert.equal((await api('PUT', `/users/@me/relationships/${alice.id}`, bob.token, { type: 2 })).status, 204);
  assert.equal((await bob.gw.event('RELATIONSHIP_ADD', r => r.type === 2)).id, alice.id);
  assert.deepEqual(await alice.gw.event('RELATIONSHIP_REMOVE', r => r.id === bob.id), { id: bob.id, type: 1 });
  assert.equal((await api('POST', `/channels/${dm.id}/messages`, alice.token, { content: 'hey?' })).body.code, 50007);
  assert.equal((await api('POST', `/channels/${dm.id}/messages`, bob.token, { content: 'hey?' })).body.code, 50007);
  assert.equal((await api('POST', '/users/@me/relationships', alice.token, { username: 'bob' })).body.code, 80001);
  // the blocked side sees no bio
  await api('PATCH', '/users/@me', bob.token, { bio: 'secret bio' });
  assert.equal((await api('GET', `/users/${bob.id}/profile`, alice.token)).body.user.bio, undefined);
  assert.equal((await api('DELETE', `/users/@me/relationships/${alice.id}`, bob.token)).status, 204);
  assert.equal((await api('POST', `/channels/${dm.id}/messages`, alice.token, { content: 'back' })).status, 201);
  await friends(alice, bob);
});

for (const relationship of ['blocked', 'unfriended']) {
  test(`DM conversion cannot add a partner who has ${relationship} the caller`, async () => {
    const dm = (await api('POST', '/users/@me/channels', alice.token, { recipient_id: bob.id })).body;
    assert.equal(dm.type, 1);
    const groups = async () => {
      const response = await api('GET', '/users/@me/channels', bob.token);
      assert.equal(response.status, 200);
      return response.body.filter(ch => ch.type === 3).map(ch => ch.id).sort();
    };
    const before = await groups();
    try {
      if (relationship === 'blocked') {
        assert.equal((await api('PUT', `/users/@me/relationships/${alice.id}`, bob.token, { type: 2 })).status, 204);
      } else {
        assert.equal((await api('DELETE', `/users/@me/relationships/${alice.id}`, bob.token)).status, 204);
      }
      const added = await api('PUT', `/channels/${dm.id}/recipients/${carol.id}`, alice.token);
      assert.equal(added.status, 403);
      assert.deepEqual(await groups(), before, 'the partner has no new group DM');
    } finally {
      if (relationship === 'blocked') await api('DELETE', `/users/@me/relationships/${alice.id}`, bob.token);
      await friends(alice, bob);
    }
  });
}

test('profiles: bio, pronouns, accent, banner, mutual guilds, per-guild profile; notes stay private', async () => {
  const banner = `data:image/png;base64,${png(600, 240).toString('base64')}`;
  const me = (await api('PATCH', '/users/@me', carol.token, { bio: 'x'.repeat(190), pronouns: 'she/her', accent_color: 0xff0000, banner })).body;
  assert.match(me.banner, /^[0-9a-f]{32}$/);
  assert.equal((await api('PATCH', '/users/@me', carol.token, { bio: 'x'.repeat(191) })).status, 400);
  assert.equal((await fetch(`${srv.origin}/banners/${carol.id}/${me.banner}`)).status, 200);
  await api('PATCH', `/guilds/${g.guild.id}/members/@me`, carol.token, { bio: 'guild bio', avatar: `data:image/png;base64,${png().toString('base64')}` });
  const p = (await api('GET', `/users/${carol.id}/profile?guild_id=${g.guild.id}`, bob.token)).body;
  assert.deepEqual([p.user.bio.length, p.user_profile.pronouns, p.user_profile.accent_color], [190, 'she/her', 0xff0000]);
  assert.deepEqual(p.mutual_guilds.map(x => x.id), [g.guild.id]);
  assert.equal(p.mutual_friends_count, 1);
  const mf = (await api('GET', `/users/${carol.id}/mutual-friends`, bob.token)).body;
  assert.equal(mf.length, 1);
  assert.equal(mf[0].id, alice.id);
  const mg = (await api('GET', `/users/${carol.id}/mutual-guilds`, bob.token)).body;
  assert.deepEqual(mg.map(x => x.id), [g.guild.id]);
  assert.equal(p.guild_member.bio, 'guild bio');
  assert.equal((await fetch(`${srv.origin}/guilds/${g.guild.id}/users/${carol.id}/avatars/${p.guild_member.avatar}`)).status, 200);
  const stranger = await srv.register('stranger');
  assert.equal((await api('GET', `/users/${carol.id}/profile`, stranger.token)).status, 403);
  assert.equal((await api('PUT', `/users/@me/notes/${carol.id}`, bob.token, { note: 'n'.repeat(257) })).status, 400);
  assert.equal((await api('PUT', `/users/@me/notes/${carol.id}`, bob.token, { note: 'owes me' })).status, 204);
  assert.deepEqual(await bob.gw.event('USER_NOTE_UPDATE'), { id: carol.id, note: 'owes me' });
  assert.deepEqual((await api('GET', '/users/@me/notes', bob.token)).body, { [carol.id]: 'owes me' });
  assert.equal((await api('GET', `/users/@me/notes/${carol.id}`, alice.token)).status, 404);
});

test('settings: allow-list validation, USER_SETTINGS_UPDATE, custom status reaches presence and expires', async () => {
  assert.equal((await api('PATCH', '/users/@me/settings', bob.token, { evil: true })).status, 400);
  assert.equal((await api('PATCH', '/users/@me/settings', bob.token, { theme: 'neon' })).status, 400);
  assert.equal((await api('PATCH', '/users/@me/settings', bob.token, { font_size: 30 })).status, 400);
  for (const k of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    assert.equal((await api('PATCH', '/users/@me/settings', bob.token, { [k]: 'x' })).status, 400, k);
    assert.equal((await api('PATCH', `/users/@me/guilds/${g.guild.id}/settings`, bob.token, { [k]: 'x' })).status, 400, k);
    assert.equal((await api('PATCH', `/users/@me/guilds/${g.guild.id}/settings`, bob.token, { channel_overrides: { [g.general.id]: { [k]: 'x' } } })).status, 400, k);
  }
  const s = (await api('PATCH', '/users/@me/settings', bob.token, { theme: 'onyx', locale: 'de', guild_folders: [{ id: 1, guild_ids: [g.guild.id], name: 'Main', color: 255 }] })).body;
  assert.deepEqual([s.theme, s.locale, s.guild_folders[0].name, s.developer_mode], ['onyx', 'de', 'Main', false]);
  assert.deepEqual(await bob.gw.event('USER_SETTINGS_UPDATE'), { theme: 'onyx', locale: 'de', guild_folders: [{ id: 1, guild_ids: [g.guild.id], name: 'Main', color: 255 }] });
  const expires = new Date(Date.now() + 1500).toISOString();
  await api('PATCH', '/users/@me/settings', bob.token, { custom_status: { text: 'scrims', emoji_name: '🎮', expires_at: expires } });
  const p = await alice.gw.event('PRESENCE_UPDATE', d => d.user.id === bob.id && d.activities.length);
  assert.deepEqual(p.activities, [{ type: 4, name: 'Custom Status', state: 'scrims', emoji: { name: '🎮' } }]);
  assert.deepEqual((await alice.gw.event('PRESENCE_UPDATE', d => d.user.id === bob.id && !d.activities.length, 4000)).activities, []);
  assert.deepEqual(await bob.gw.event('USER_SETTINGS_UPDATE', d => 'custom_status' in d && d.custom_status === null), { custom_status: null });
  // op 3 activities are relayed
  bob.gw.send({ op: 3, d: { status: 'online', afk: false, since: 0, activities: [{ type: 0, name: 'Valorant' }] } });
  assert.equal((await alice.gw.event('PRESENCE_UPDATE', d => d.user.id === bob.id && d.activities.length)).activities[0].name, 'Valorant');
});

test('notification settings, mentions inbox, bulk ack', async () => {
  const gs = (await api('PATCH', `/users/@me/guilds/${g.guild.id}/settings`, bob.token, {
    message_notifications: 1, suppress_everyone: true, channel_overrides: { [g.general.id]: { muted: true, mute_config: { end_time: null } } },
  })).body;
  assert.deepEqual([gs.guild_id, gs.message_notifications, gs.channel_overrides[0].muted], [g.guild.id, 1, true]);
  assert.equal((await bob.gw.event('USER_GUILD_SETTINGS_UPDATE')).suppress_everyone, true);
  assert.equal((await api('PATCH', `/users/@me/guilds/${g.guild.id}/settings`, bob.token, { bogus: 1 })).status, 400);
  assert.equal((await api('PATCH', `/users/@me/guilds/${g.guild.id}/settings`, bob.token, { channel_overrides: { 123: { muted: true } } })).status, 400);
  assert.equal((await api('PATCH', '/users/@me/guilds/@me/settings', bob.token, { muted: true })).body.guild_id, null);
  const again = await srv.gateway(bob.token);
  assert.equal(again.ready.user_guild_settings.entries.length, 2);
  again.ws.close();

  const m1 = (await api('POST', `/channels/${g.general.id}/messages`, alice.token, { content: `ping <@${bob.id}>` })).body;
  const m2 = (await api('POST', `/channels/${g.general.id}/messages`, alice.token, { content: '@everyone meeting' })).body;
  const inbox = (await api('GET', '/users/@me/mentions?limit=10', bob.token)).body.map(m => m.id);
  assert.deepEqual(inbox, [m2.id, m1.id]);
  assert.deepEqual((await api('GET', '/users/@me/mentions?everyone=false', bob.token)).body.map(m => m.id), [m1.id]);
  assert.equal((await api('DELETE', `/users/@me/mentions/${m1.id}`, bob.token)).status, 204);
  assert.deepEqual(await bob.gw.event('RECENT_MENTION_DELETE'), { message_id: m1.id });
  assert.equal((await api('POST', '/read-states/ack-bulk', bob.token, { read_states: [{ channel_id: g.general.id, message_id: m2.id }, { channel_id: '1', message_id: '2' }] })).status, 204);
  assert.deepEqual(await bob.gw.event('MESSAGE_ACK', d => d.message_id === m2.id), { channel_id: g.general.id, message_id: m2.id });
});

test('bulk ack clamps future IDs and preserves read position and mentions on stale requests', async () => {
  const ch = (await api('POST', `/guilds/${g.guild.id}/channels`, alice.token, { name: 'bulk-ack', type: 0 })).body;
  const ack = async (message_id, expected) => {
    assert.equal((await api('POST', '/read-states/ack-bulk', bob.token, {
      read_states: [{ channel_id: ch.id, message_id }],
    })).status, 204);
    assert.deepEqual(await bob.gw.event('MESSAGE_ACK', d => d.channel_id === ch.id), {
      channel_id: ch.id, message_id: expected,
    });
  };
  await ack('9999999999999999999', ch.id);
  const first = (await api('POST', `/channels/${ch.id}/messages`, alice.token, { content: 'first' })).body;
  await ack('9999999999999999999', first.id);
  await api('POST', `/channels/${ch.id}/messages`, alice.token, { content: `<@${bob.id}> unread` });
  await ack(ch.id, first.id);
  const again = await srv.gateway(bob.token);
  const state = again.ready.read_state.find(r => r.id === ch.id);
  again.ws.close();
  assert.equal(state.last_message_id, first.id);
  assert.equal(state.mention_count, 1);
});

// stored timestamps are compared as strings: "+010000-…" (past year 9999) sorted before every real date, so one user's
// far-future custom status became the "next" expiry and held back every other user's expiry until the hourly sweep
test('timestamps past year 9999 or before year 0 are refused, year 9999 still works', async () => {
  const guild = `/users/@me/guilds/${g.guild.id}/settings`;
  const event = t => ({ name: 'far', entity_type: 3, entity_metadata: { location: 'x' }, privacy_level: 2, scheduled_start_time: t, scheduled_end_time: t });
  for (const t of ['+010000-01-01T00:00:00.000Z', '-000001-01-01T00:00:00.000Z']) {
    assert.equal((await api('PATCH', '/users/@me/settings', carol.token, { custom_status: { text: 'x', expires_at: t } })).status, 400, t);
    assert.equal((await api('PATCH', guild, carol.token, { muted: true, mute_config: { end_time: t } })).status, 400, t);
    assert.equal((await api('POST', `/guilds/${g.guild.id}/scheduled-events`, alice.token, event(t))).status, 400, t);
  }
  const max = '9999-12-31T23:59:59.000Z';
  const s = await api('PATCH', '/users/@me/settings', carol.token, { custom_status: { text: 'x', expires_at: max } });
  assert.equal(s.body.custom_status.expires_at, max);
  assert.equal((await api('PATCH', guild, carol.token, { muted: true, mute_config: { end_time: max } })).body.mute_config.end_time, max);
  await api('PATCH', '/users/@me/settings', carol.token, { custom_status: null });
});
