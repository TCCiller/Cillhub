import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, guildWith, png } from './helpers.js';

test('member lists and search preserve roles while lists load them in one query', async t => {
  const srv = await startServer();
  let db;
  try {
    const { guild, users } = await guildWith(srv, ['alice', 'bob', 'carol']);
    const { alice, bob, carol } = users;
    const roleIds = [];
    for (const name of ['First', 'Second']) {
      const r = await srv.api('POST', `/guilds/${guild.id}/roles`, alice.token, { name });
      assert.equal(r.status, 200);
      roleIds.push(r.body.id);
    }
    for (const [user, roles] of [[bob, [roleIds[0]]], [carol, [...roleIds].reverse()]]) {
      const r = await srv.api('PATCH', `/guilds/${guild.id}/members/${user.id}`, alice.token, { roles });
      assert.equal(r.status, 200);
    }
    process.env.DATA_DIR = srv.dataDir;
    const model = await import('../src/db.js');
    db = model.db;
    let roleQueries = 0;
    const prepare = db.prepare.bind(db);
    t.mock.method(db, 'prepare', sql => {
      const statement = prepare(sql);
      if (sql.includes('FROM member_roles')) {
        const all = statement.all.bind(statement);
        t.mock.method(statement, 'all', (...args) => { roleQueries++; return all(...args); });
      }
      return statement;
    });
    const expected = Object.values(users).map(u => model.memberObj(model.memberRow(guild.id, u.id)));
    assert.deepEqual(expected.map(m => m.roles.length), [0, 1, 2]);
    const row = model.memberRow(guild.id, carol.id);
    roleQueries = 0;
    assert.deepEqual(model.memberObj(row, []).roles, []);
    assert.equal(roleQueries, 0, 'explicit empty roles must not query');
    const members = model.membersOf(guild.id);
    assert.equal(roleQueries, 1, 'one role query for the entire member list');
    assert.deepEqual(members, expected);
    assert.deepEqual(model.membersOf(guild.id, 1), expected.slice(0, 1));
    assert.deepEqual(model.membersOf(guild.id, 0), []);
    const list = await srv.api('GET', `/guilds/${guild.id}/members`, alice.token);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body, expected);
    for (const suffix of ['', `?role_ids=${roleIds[1]}`, '?query=BOB', '?limit=1']) {
      const response = await srv.api('GET', `/guilds/${guild.id}/members/search${suffix}`, alice.token);
      assert.equal(response.status, 200);
      const wanted = suffix.includes('role_ids') ? expected.filter(m => m.roles.includes(roleIds[1]))
        : suffix.includes('query') ? expected.filter(m => m.user.id === bob.id)
        : suffix.includes('limit') ? expected.slice(0, 1) : expected;
      assert.deepEqual(response.body.map(({ safety_signals, ...member }) => member), wanted);
    }
  } finally {
    t.mock.restoreAll();
    db?.close();
    await srv.stop();
  }
});

test('a member in timeout cannot change their server profile, the account profile is untouched, and it works again when the timeout ends', async () => {
  const srv = await startServer();
  try {
    const { guild, users: { alice, bob } } = await guildWith(srv, ['alice', 'bob']);
    const me = `/guilds/${guild.id}/members/@me`;
    const img = `data:image/png;base64,${png(16, 16).toString('base64')}`;
    const edits = [{ nick: 'Bobby' }, { bio: 'hello' }, { avatar: img }, { banner: img }, { display_name_font_id: 3 }, { display_name_colors: [255] }];
    const member = async () => JSON.stringify((await srv.api('GET', `/guilds/${guild.id}/members/${bob.id}`, alice.token)).body);
    const timeout = until => srv.api('PATCH', `/guilds/${guild.id}/members/${bob.id}`, alice.token, { communication_disabled_until: until });
    const gw = await srv.gateway(alice.token);
    assert.equal((await timeout(new Date(Date.now() + 3_600_000).toISOString())).status, 200);
    await gw.event('GUILD_MEMBER_UPDATE', d => d.user.id === bob.id);
    const before = await member();
    for (const body of edits) {
      const r = await srv.api('PATCH', me, bob.token, body);
      assert.equal(r.status, 403, JSON.stringify(body));
      assert.equal(r.body.code, 50013);
    }
    assert.equal(await member(), before, 'nothing changed');
    assert.ok(await gw.none(f => f.t === 'GUILD_MEMBER_UPDATE'), 'no event');
    assert.equal((await srv.api('PATCH', '/users/@me', bob.token, { global_name: 'Bobby' })).status, 200, 'the account profile is not a server matter');
    assert.equal((await srv.api('PATCH', `/guilds/${guild.id}/members/@me`, alice.token, { bio: 'owner' })).status, 200);
    assert.equal((await timeout(null)).status, 200);
    for (const body of edits) {
      const r = await srv.api('PATCH', me, bob.token, body);
      assert.equal(r.status, 200, `${JSON.stringify(body)} ${JSON.stringify(r.body)}`);
    }
    gw.ws.close();
  } finally {
    await srv.stop();
  }
});
