// Merging guild members into the store and requesting missing own member records. Pure (no React or browser globals)
// so scripts/members.test.mjs can run it directly and every store/action writer shares one merge rule.

export function withMembers<M extends { user: { id: string } }>(
  members: Record<string, Record<string, M>>,
  guildId: string,
  list: M[],
): Record<string, Record<string, M>> {
  return {
    ...members,
    [guildId]: { ...members[guildId], ...Object.fromEntries(list.map((m) => [m.user.id, m])) },
  }
}

export function ensureOwnMembers(
  s: { status: string; guilds: Record<string, unknown>; me: { id: string } | null; members: Record<string, Record<string, unknown>> },
  requested: Set<string>,
  load: (guildId: string) => Promise<unknown>,
) {
  if (s.status !== 'ready' || !s.me) return
  for (const id of requested) if (!(id in s.guilds)) requested.delete(id)
  for (const id of Object.keys(s.guilds)) {
    if (!s.members[id]?.[s.me.id] && !requested.has(id)) {
      requested.add(id)
      load(id).catch(() => requested.delete(id))
    }
  }
}
