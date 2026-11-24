import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, guildWith } from './helpers.js';

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
