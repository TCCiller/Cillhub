import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './helpers.js';

const VIEW = 1n << 10n, ADMIN = 1n << 3n;
let db, run, viewersOf, eventsPart;

before(async () => {
  process.env.DATA_DIR = await tempDir();
  ({ db, run } = await import('../src/db.js'));
  ({ viewersOf } = await import('../src/permissions.js'));
  const { guildParts } = await import('../src/gateway.js');
  await import('../src/routes/events.js');
  eventsPart = guildParts.find(f => 'guild_scheduled_events' in f({ id: 'none' }, null));
  assert.ok(eventsPart, 'events guildParts entry is registered');
});

test('event visibility matches viewersOf for channel events and membership for external or orphaned events', () => {
  db.exec('BEGIN');
  const addUser = id => run("INSERT INTO users (id, email, username, password_hash, salt) VALUES (?, ?, ?, 'x', 'x')", id, `${id}@x`, `u_${id}`);
  for (const id of ['0', 'adm', 'denied', 'vip', 'plain', 'pend_vip', 'pend_plain', 'to_vip', 'to_plain', 'outsider']) addUser(id);
  run("INSERT INTO guilds (id, name, owner_id) VALUES ('g', 'G', '0')");
  run("INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ('g', 'g', '@everyone', 0, ?)", String(VIEW));
  run("INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ('r_adm', 'g', 'admin', 1, ?)", String(ADMIN));
  run("INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ('r_vip', 'g', 'vip', 2, '0')");

  const addMember = (id, pending = 0, until = null) =>
    run("INSERT INTO members (guild_id, user_id, joined_at, pending, communication_disabled_until) VALUES ('g', ?, 'now', ?, ?)", id, pending, until);
  for (const id of ['0', 'adm', 'denied', 'vip', 'plain']) addMember(id);
  addMember('pend_vip', 1, null);
  addMember('pend_plain', 1, null);
  addMember('to_vip', 0, '2999-01-01T00:00:00Z');
  addMember('to_plain', 0, '2999-01-01T00:00:00Z');

  run("INSERT INTO member_roles VALUES ('g', 'adm', 'r_adm')");
  for (const id of ['denied', 'vip', 'pend_vip', 'to_vip']) run("INSERT INTO member_roles VALUES ('g', ?, 'r_vip')", id);

  run("INSERT INTO channels (id, type, guild_id, name) VALUES ('vip_ch', 2, 'g', 'vip'), ('open_ch', 2, 'g', 'open'), ('gone_ch', 2, 'g', 'gone')");
  run("INSERT INTO overwrites VALUES ('vip_ch', 'g', 0, '0', ?), ('vip_ch', 'r_vip', 0, ?, '0'), ('vip_ch', 'denied', 1, '0', ?)",
    String(VIEW), String(VIEW), String(VIEW));
  run("INSERT INTO overwrites VALUES ('open_ch', 'denied', 1, '0', ?)", String(VIEW));

  const start = '2099-01-01T00:00:00.000Z';
  const addEvent = (id, chId, type) => run(
    `INSERT INTO scheduled_events (id, guild_id, channel_id, creator_id, name, scheduled_start_time, privacy_level, status, entity_type)
     VALUES (?, 'g', ?, '0', ?, ?, 2, 1, ?)`, id, chId, id, start, type);
  addEvent('ev_vip', 'vip_ch', 2);
  addEvent('ev_open', 'open_ch', 2);
  addEvent('ev_ext', null, 3);
  addEvent('ev_gone', 'gone_ch', 2);
  run("DELETE FROM channels WHERE id = 'gone_ch'");
  db.exec('COMMIT');

  const vipCh = db.prepare("SELECT * FROM channels WHERE id = 'vip_ch'").get();
  const openCh = db.prepare("SELECT * FROM channels WHERE id = 'open_ch'").get();
  const vipViewers = new Set(viewersOf(vipCh));
  const openViewers = new Set(viewersOf(openCh));

  const cases = [
    ['0', true, true, true],
    ['adm', true, true, true],
    ['vip', true, true, true],
    ['pend_vip', true, true, true],
    ['to_vip', true, true, true],
    ['denied', false, false, true],
    ['plain', false, true, true],
    ['pend_plain', false, true, true],
    ['to_plain', false, true, true],
    ['outsider', false, false, false],
  ];

  for (const [uid, wantVip, wantOpen, wantMember] of cases) {
    const seen = new Set(eventsPart({ id: 'g' }, uid).guild_scheduled_events.map(e => e.id));
    assert.equal(seen.has('ev_vip'), vipViewers.has(uid), `vip_ch parity with viewersOf for ${uid}`);
    assert.equal(seen.has('ev_open'), openViewers.has(uid), `open_ch parity with viewersOf for ${uid}`);
    assert.equal(seen.has('ev_vip'), wantVip, `vip_ch expected for ${uid}`);
    assert.equal(seen.has('ev_open'), wantOpen, `open_ch expected for ${uid}`);
    assert.equal(seen.has('ev_ext'), wantMember, `external event for ${uid}`);
    assert.equal(seen.has('ev_gone'), wantMember, `deleted-channel event for ${uid}`);
  }
});

test('visible scheduled events stays fast at 5000 members and 50 active channel events', () => {
  const MEMBERS = 5000;
  const EVENTS = 50;
  db.exec('BEGIN');
  run("INSERT INTO users (id, email, username, password_hash, salt) VALUES ('b0', 'b0@x', 'b0', 'x', 'x')");
  run("INSERT INTO guilds (id, name, owner_id) VALUES ('big', 'Big', 'b0')");
  run("INSERT INTO members (guild_id, user_id, joined_at) VALUES ('big', 'b0', 'now')");
  run("INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ('big', 'big', '@everyone', 0, ?)", String(VIEW));
  run("INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ('b_vip', 'big', 'vip', 1, '0')");
  for (let i = 1; i <= MEMBERS; i++) {
    const id = `b${i}`;
    run("INSERT INTO users (id, email, username, password_hash, salt) VALUES (?, ?, ?, 'x', 'x')", id, `${id}@x`, id);
    run("INSERT INTO members (guild_id, user_id, joined_at) VALUES ('big', ?, 'now')", id);
    if (i % 2 === 0) run("INSERT INTO member_roles VALUES ('big', ?, 'b_vip')", id);
  }
  run("INSERT INTO channels (id, type, guild_id, name) VALUES ('b_open', 2, 'big', 'open'), ('b_vip_ch', 2, 'big', 'vip')");
  run("INSERT INTO overwrites VALUES ('b_vip_ch', 'big', 0, '0', ?), ('b_vip_ch', 'b_vip', 0, ?, '0')", String(VIEW), String(VIEW));
  for (let i = 0; i < EVENTS; i++) {
    const chId = i % 2 === 0 ? 'b_open' : 'b_vip_ch';
    run(`INSERT INTO scheduled_events (id, guild_id, channel_id, creator_id, name, scheduled_start_time, privacy_level, status, entity_type)
         VALUES (?, 'big', ?, 'b0', ?, '2099-01-01T00:00:00.000Z', 2, 1, 2)`, `bev_${i}`, chId, `Event ${i}`);
  }
  db.exec('COMMIT');

  const t0 = performance.now();
  const list = eventsPart({ id: 'big' }, 'b1').guild_scheduled_events;
  const ms = performance.now() - t0;
  assert.equal(list.length, EVENTS / 2);
  console.log(`visible events (5000 members, 50 channel events): ${ms.toFixed(1)} ms`);
  assert.ok(ms < 50, `visible events took ${ms.toFixed(1)} ms (expected < 50 ms)`);
});

test('calendar feed token lookup uses users_calendar_token index', () => {
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM users WHERE calendar_token = ? AND disabled = 0 AND deleted = 0').all('tok');
  const details = plan.map(r => r.detail).join(' | ');
  assert.match(details, /USING (?:COVERING )?INDEX users_calendar_token\b/, `expected users_calendar_token index in plan: ${details}`);
});
