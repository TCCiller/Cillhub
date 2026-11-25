// Application command visibility rules (src/commands/usable.ts, src/commands/commands.ts). Run: npm test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { filterContextCommands, flatten, usable } from '../src/commands/usable.ts'

const KICK = 1n << 1n
const BAN = 1n << 2n
const ADMIN = 1n << 3n
const MANAGE_GUILD = 1n << 5n
const USE_COMMANDS = 1n << 31n
const ALL = (1n << 50n) - 1n

const guildCh = { guild_id: '100' }
const dmCh = {}
const cmd = (overrides = {}) => ({
  id: '1',
  type: 1,
  application_id: 'app1',
  name: 'admin',
  description: 'Admin command',
  version: '1',
  ...overrides,
})

test('default_member_permissions "0" allows owner/administrators and hides from non-administrators', () => {
  const c = cmd({ default_member_permissions: '0' })
  assert.equal(usable(c, guildCh, ALL), true, 'owner / admin with ALL')
  assert.equal(usable(c, guildCh, ADMIN), true, 'administrator bit')
  assert.equal(usable(c, guildCh, USE_COMMANDS | MANAGE_GUILD | KICK | BAN), false, 'non-admin member')
  assert.equal(usable(c, guildCh, 0n), false, 'no permissions')
})

test('default_member_permissions null allows everyone; bit values require bits or ADMINISTRATOR', () => {
  const open = cmd({ default_member_permissions: null })
  assert.equal(usable(open, guildCh, 0n), true)
  assert.equal(usable(open, guildCh, USE_COMMANDS), true)
  assert.equal(usable(open, guildCh, ALL), true)
  assert.equal(usable(cmd(), guildCh, 0n), true, 'omitted default_member_permissions')

  const mod = cmd({ default_member_permissions: String(KICK | BAN) })
  assert.equal(usable(mod, guildCh, KICK | BAN), true, 'member holding required bits')
  assert.equal(usable(mod, guildCh, KICK), false, 'member missing one required bit')
  assert.equal(usable(mod, guildCh, USE_COMMANDS), false, 'member lacking required bits')
  assert.equal(usable(mod, guildCh, ALL), true, 'owner / admin with ALL')
  assert.equal(usable(mod, guildCh, ADMIN), true, 'administrator without individual bits')
})

test('non-decimal default_member_permissions hides the command without throwing', () => {
  for (const bad of ['abc', '', '-1', '0x8', '1.5', ' 8', '8 ', '123456789012345678901', 8]) {
    const c = cmd({ default_member_permissions: bad })
    assert.equal(usable(c, guildCh, USE_COMMANDS), false, `member: ${String(bad)}`)
    assert.equal(usable(c, guildCh, ALL), false, `admin: ${String(bad)}`)
  }
})

test('DM contexts and dm_permission behave as before, and server channels require context 0 when contexts is set', () => {
  assert.equal(usable(cmd({ contexts: [1] }), dmCh, 0n), true)
  assert.equal(usable(cmd({ contexts: [2] }), dmCh, 0n), true)
  assert.equal(usable(cmd({ contexts: [0] }), dmCh, 0n), false)
  assert.equal(usable(cmd({ dm_permission: false }), dmCh, 0n), false)
  assert.equal(usable(cmd({ dm_permission: true }), dmCh, 0n), true)
  assert.equal(usable(cmd({ default_member_permissions: '0' }), dmCh, 0n), true, 'DM ignores guild default_member_permissions')
  assert.equal(usable(cmd({ contexts: [1], dm_permission: false }), dmCh, 0n), true, 'contexts overrides dm_permission in DM')

  assert.equal(usable(cmd({ contexts: [1, 2] }), guildCh, ALL), false, 'server channel without context 0 hides even for admin')
  assert.equal(usable(cmd({ contexts: [] }), guildCh, ALL), false, 'empty contexts hides in server channel')
  assert.equal(usable(cmd({ contexts: [0], default_member_permissions: '0' }), guildCh, ALL), true)
  assert.equal(usable(cmd({ contexts: [0], default_member_permissions: '0' }), guildCh, USE_COMMANDS), false)
})

test('flatten and context-menu filtering share the same usable rule and commands.ts delegates to it', () => {
  const index = {
    applications: [{ id: 'app1', name: 'Bot', description: '', icon: null }],
    application_commands: [
      cmd({ id: '1', type: 1, name: 'nuke', default_member_permissions: '0' }),
      cmd({ id: '2', type: 1, name: 'kick', default_member_permissions: String(KICK) }),
      cmd({ id: '3', type: 1, name: 'ping', default_member_permissions: null }),
      cmd({ id: '4', type: 1, name: 'broken', default_member_permissions: 'not-a-number' }),
      cmd({ id: '5', type: 2, name: 'Admin User Action', default_member_permissions: '0' }),
      cmd({ id: '6', type: 2, name: 'Kick User', default_member_permissions: String(KICK) }),
      cmd({ id: '7', type: 3, name: 'Admin Message Action', default_member_permissions: '0' }),
      cmd({ id: '8', type: 3, name: 'Public Message Action', default_member_permissions: null }),
    ],
  }

  assert.deepEqual(flatten(index, guildCh, ALL).map((e) => e.cmd.name), ['kick', 'nuke', 'ping'])
  assert.deepEqual(flatten(index, guildCh, USE_COMMANDS | KICK).map((e) => e.cmd.name), ['kick', 'ping'])
  assert.deepEqual(flatten(index, guildCh, USE_COMMANDS).map((e) => e.cmd.name), ['ping'])

  assert.deepEqual(filterContextCommands(index, guildCh, 2, ALL).map((c) => c.name), ['Admin User Action', 'Kick User'])
  assert.deepEqual(filterContextCommands(index, guildCh, 2, USE_COMMANDS | KICK).map((c) => c.name), ['Kick User'])
  assert.deepEqual(filterContextCommands(index, guildCh, 2, USE_COMMANDS).map((c) => c.name), [])

  assert.deepEqual(filterContextCommands(index, guildCh, 3, ALL).map((c) => c.name), ['Admin Message Action', 'Public Message Action'])
  assert.deepEqual(filterContextCommands(index, guildCh, 3, USE_COMMANDS).map((c) => c.name), ['Public Message Action'])

  const commandsSrc = readFileSync(new URL('../src/commands/commands.ts', import.meta.url), 'utf8')
  assert.match(commandsSrc, /from '\.\/usable'/)
  assert.match(commandsSrc, /export \{ flatten, type Entry \}/)
  assert.match(commandsSrc, /filterContextCommands\(index, channel, type, perms\)/)
  assert.doesNotMatch(commandsSrc, /function usable\b/)
})
