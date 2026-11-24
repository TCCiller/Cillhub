import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, guildWith, bits, png } from './helpers.js';

let srv, api, g, alice, bob, carol, secret;
before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob', 'carol']);
  ({ alice, bob, carol } = g.users);
  secret = (await api('POST', `/guilds/${g.guild.id}/channels`, alice.token, {
    name: 'staff', permission_overwrites: [{ id: g.guild.id, type: 0, allow: '0', deny: bits(10) }, { id: carol.id, type: 1, allow: bits(10), deny: bits(16) }],
  })).body;
  const say = (who, content, ch = g.general.id) => api('POST', `/channels/${ch}/messages`, who.token, { content });
  await say(alice, 'the raid starts at nine');
  await say(bob, 'Raid tonight? https://example.com/plan');
  await say(alice, 'secret raid plans', secret.id);
  await say(alice, 'pinned raid notes');
  await srv.form('POST', `/channels/${g.general.id}/messages`, bob.token, { content: 'raid map' }, [['files[0]', 'map.png', png(), 'image/png']]);
});
after(() => srv.stop());

const search = (who, q, path = `/guilds/${g.guild.id}`) => api('GET', `${path}/messages/search?${q}`, who.token);
const contents = r => r.body.messages.map(([m]) => m.content);

test('guild search: FTS words, filters, sort and paging; result shape per the user docs', async () => {
  const r = await search(bob, 'content=raid');
  assert.equal(r.status, 200);
  assert.equal(r.body.total_results, 4);
  assert.deepEqual(contents(r), ['raid map', 'pinned raid notes', 'Raid tonight? https://example.com/plan', 'the raid starts at nine']);
  const [first] = r.body.messages[0];
  assert.deepEqual([first.hit, first.reactions, typeof r.body.analytics_id, r.body.doing_deep_historical_index], [true, undefined, 'string', false]);
  assert.deepEqual(contents(await search(bob, `content=raid&author_id=${bob.id}`)), ['raid map', 'Raid tonight? https://example.com/plan']);
  assert.deepEqual(contents(await search(bob, `content=raid&from=${bob.id}`)), ['raid map', 'Raid tonight? https://example.com/plan']);
  assert.deepEqual(contents(await search(bob, 'has=link')), ['Raid tonight? https://example.com/plan']);
  assert.deepEqual(contents(await search(bob, 'has=image&has=file')), ['raid map']);
  assert.deepEqual(contents(await search(bob, 'has=audio')), []);
  assert.deepEqual(contents(await search(bob, 'has=code')), []);
  assert.ok((await search(bob, `content=raid&before=${new Date(Date.now() + 864e5).toISOString()}`)).body.total_results >= 1, 'before ISO date');
  assert.ok((await search(bob, 'content=raid&after=2020-01-01T00:00:00Z')).body.total_results >= 1, 'after ISO date');
  assert.deepEqual(contents(await search(bob, 'content=raid&has=-file')).length, 3);
  assert.deepEqual(contents(await search(bob, 'content=raid&sort_order=asc&limit=1&offset=1')), ['Raid tonight? https://example.com/plan']);
  assert.equal((await search(bob, 'content="raid" OR * NEAR(')).status, 200, 'FTS syntax in the query is just text');
  assert.equal((await search(bob, 'has=nonsense')).status, 400);
  assert.equal((await search(bob, 'limit=26')).status, 400);
});

test('search never returns messages from channels the user cannot read', async () => {
  assert.ok(!contents(await search(bob, 'content=secret')).length, 'no VIEW_CHANNEL');
  assert.ok(!contents(await search(carol, 'content=secret')).length, 'VIEW_CHANNEL without READ_MESSAGE_HISTORY');
  assert.ok(!contents(await search(bob, `content=secret&channel_id=${secret.id}`)).length, 'asking for the channel does not help');
  assert.deepEqual(contents(await search(alice, 'content=secret')), ['secret raid plans']);
  assert.equal((await search(bob, 'content=x', `/channels/${secret.id}`)).status, 403);
  const outsider = await srv.register('mallory');
  assert.equal((await search(outsider, 'content=raid')).status, 404);
});

test('channel search covers DMs', async () => {
  const dm = (await api('POST', '/users/@me/channels', bob.token, { recipient_id: carol.id })).body;
  await api('POST', `/channels/${dm.id}/messages`, carol.token, { content: 'dm about the raid' });
  assert.deepEqual(contents(await search(bob, 'content=raid', `/channels/${dm.id}`)), ['dm about the raid']);
  assert.equal((await search(alice, 'content=raid', `/channels/${dm.id}`)).status, 403);
});

test('search caps large totals at 10000 while preserving exact small totals and page rows', async () => {
  process.env.DATA_DIR = srv.dataDir;
  const { db, run, tx } = await import('../src/db.js');
  const { SEARCH_RESULT_CAP } = await import('../src/routes/search.js');
  const base = 1000000000000000000n;
  try {
    tx(() => {
      for (let i = 0; i < 10050; i++) {
        run('INSERT INTO messages (id, channel_id, author_id, content, timestamp) VALUES (?, ?, ?, ?, ?)',
          String(base + BigInt(i)), g.general.id, alice.id, 'capfixture', '2026-11-23T12:00:00.000Z');
      }
    });
    const large = await search(bob, 'content=capfixture');
    assert.equal(large.status, 200);
    assert.equal(SEARCH_RESULT_CAP, 10000);
    assert.equal(large.body.total_results, SEARCH_RESULT_CAP);
    assert.equal(large.body.messages.length, 25);
    assert.deepEqual(large.body.messages.map(([m]) => m.id), Array.from({ length: 25 }, (_, i) => String(base + BigInt(10049 - i))));
    const small = await search(bob, `content=capfixture&min_id=${base + 10046n}`);
    assert.equal(small.body.total_results, 3);
    assert.equal(small.body.messages.length, 3);
    const empty = await search(bob, 'content=absentcapfixture');
    assert.equal(empty.body.total_results, 0);
    const lastPage = await search(bob, 'content=capfixture&offset=9975');
    assert.equal(lastPage.body.messages.length, 25);
    assert.equal(lastPage.body.total_results, SEARCH_RESULT_CAP);
  } finally {
    run('DELETE FROM messages WHERE content = ?', 'capfixture');
    db.close();
  }
});
