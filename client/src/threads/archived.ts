export type ArchivedKind = 'public' | 'private' | 'joined'

type ArchivedPage = {
  has_more: boolean
  threads: { id: string; thread_metadata?: { archive_timestamp: string } }[]
}

export function archivedCursor(kind: ArchivedKind, page: ArchivedPage): string | undefined {
  if (!page.has_more) return undefined
  let oldest: string | undefined
  for (const thread of page.threads) {
    const value = kind === 'joined' ? thread.id : thread.thread_metadata?.archive_timestamp
    if (value && (oldest === undefined || (kind === 'joined' ? BigInt(value) < BigInt(oldest) : Date.parse(value) < Date.parse(oldest)))) oldest = value
  }
  return oldest
}
