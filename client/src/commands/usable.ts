// Application command visibility and filtering for the composer and context menus; pure so scripts/commands.test.mjs can run it.
import type { AppCommand, Channel, CommandIndex, CommandOption } from '../types'

export type Entry = { cmd: AppCommand; path: string[]; options: CommandOption[]; description: string; app: string }

const ADMINISTRATOR = 1n << 3n
const has = (perms: bigint, bit: bigint) => (perms & bit) === bit
const DECIMAL = /^\d{1,20}$/

/** Commands the user may run here: DM/guild contexts, then default_member_permissions (null = everyone, "0" = administrators only, else those bits; administrators pass). */
export function usable(c: AppCommand, channel: Pick<Channel, 'guild_id'>, perms: bigint): boolean {
  if (!channel.guild_id) {
    if (c.contexts ? !c.contexts.some((x) => x === 1 || x === 2) : c.dm_permission === false) return false
  } else if (c.contexts && !c.contexts.includes(0)) return false
  if (channel.guild_id && c.default_member_permissions != null) {
    if (typeof c.default_member_permissions !== 'string' || !DECIMAL.test(c.default_member_permissions)) return false
    if (has(perms, ADMINISTRATOR)) return true
    const need = BigInt(c.default_member_permissions)
    if (need === 0n || !has(perms, need)) return false
  }
  return true
}

/** CHAT_INPUT commands flattened for the picker: `/cmd`, `/cmd sub`, `/cmd group sub`. */
export function flatten(index: CommandIndex, channel: Pick<Channel, 'guild_id'>, perms: bigint): Entry[] {
  const apps = Object.fromEntries(index.applications.map((a) => [a.id, a.name]))
  const out: Entry[] = []
  for (const c of index.application_commands) {
    if ((c.type ?? 1) !== 1 || !usable(c, channel, perms)) continue
    const app = apps[c.application_id] ?? ''
    const subs = (c.options ?? []).filter((o) => o.type === 1 || o.type === 2)
    if (!subs.length) { out.push({ cmd: c, path: [c.name], options: c.options ?? [], description: c.description, app }); continue }
    for (const s of subs)
      if (s.type === 1) out.push({ cmd: c, path: [c.name, s.name], options: s.options ?? [], description: s.description, app })
      else for (const x of s.options ?? []) out.push({ cmd: c, path: [c.name, s.name, x.name], options: x.options ?? [], description: x.description, app })
  }
  return out.sort((a, b) => a.path.join(' ').localeCompare(b.path.join(' ')))
}

/** USER (2) and MESSAGE (3) context commands the user may run in this channel. */
export function filterContextCommands(index: CommandIndex, channel: Pick<Channel, 'guild_id'>, type: 2 | 3, perms: bigint): AppCommand[] {
  return index.application_commands.filter((c) => c.type === type && usable(c, channel, perms))
}
