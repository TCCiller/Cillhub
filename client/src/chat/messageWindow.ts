// The loaded window of a channel's messages (store `messages`): how a fetched page joins it. Pure, so
// scripts/message-window.test.mjs can run it. A page is applied only to the window it was asked for: a jump (search
// result, reply, pin) or "Jump to Present" replaces the window, and live messages trim its oldest, while a fetch is out.

type Msg = { id: string; pending?: unknown; failed?: unknown }

export const sortById = <T extends Msg>(list: T[]) => [...list].sort((a, b) => (a.id.length - b.id.length) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

const replaced = new Map<string, number>() // channel id -> how often its window was replaced
/** Taken when the latest page is asked for; the answer is dropped if the window was replaced meanwhile. */
export const windowToken = (channelId: string) => replaced.get(channelId) ?? 0
export const replaceWindow = (channelId: string) => void replaced.set(channelId, windowToken(channelId) + 1)

/** The list with an older page (`before` given) or the latest page in front, or null when it no longer fits: an older page
 *  only while the list still starts at `before`, the latest page only while the window was not replaced (`token`). */
export function withOlder<T extends Msg>(channelId: string, list: T[] | undefined, page: T[], before: string | undefined, token: number): T[] | null {
  if (before ? list?.[0]?.id !== before : windowToken(channelId) !== token) return null
  const cur = list ?? []
  const ids = new Set(cur.map((m) => m.id))
  return [...sortById(page).filter((m) => !ids.has(m.id)), ...cur]
}

/** The list with a newer page after its newest sent message, or null when that is no longer `after`. */
export function withNewer<T extends Msg>(list: T[] | undefined, page: T[], after: string): T[] | null {
  const cur = list ?? []
  if (cur.filter((m) => !m.pending && !m.failed).at(-1)?.id !== after) return null
  const ids = new Set(cur.map((m) => m.id))
  return [...cur, ...sortById(page).filter((m) => !ids.has(m.id))]
}
