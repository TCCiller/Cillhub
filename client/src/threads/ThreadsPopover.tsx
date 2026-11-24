// Channel header "Threads" button: active and archived threads of the channel, search, Create.
import { t } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import { archivedThreads } from '../actions'
import { Popover, type Anchor } from '../components/menu'
import { cls, Icon, ICONS } from '../components/ui'
import { relative } from '../markdown/Markdown'
import { has, P } from '../permissions'
import { activeThreads, usePerms } from '../selectors'
import { cmpId, setState, useStore } from '../store'
import type { Channel } from '../types'
import { openThread, snowflakeTime } from './util'
import { archivedCursor, type ArchivedKind } from './archived'
import './threads.css'

/** Header button with the threads list popover (active and archived threads, Create). */
export function ThreadsButton({ channel }: { channel: Channel }) {
  const [at, setAt] = useState<Anchor | null>(null)
  return (
    <>
      <button className="icon-btn" aria-label={t('Threads')} title={t('Threads')} aria-expanded={!!at} onClick={(e) => setAt({ rect: e.currentTarget.getBoundingClientRect(), side: 'below' })}>
        <Icon d={ICONS.thread} />
      </button>
      {at && <ThreadsPopover channel={channel} at={at} onClose={() => setAt(null)} />}
    </>
  )
}

function ThreadsPopover({ channel, at, onClose }: { channel: Channel; at: Anchor; onClose: () => void }) {
  const s = useStore((x) => x)
  const perms = usePerms(channel.guild_id, channel.id)
  const [tab, setTab] = useState<'active' | 'archived'>('active')
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [cursors, setCursors] = useState<Partial<Record<ArchivedKind, string>>>({})
  const generation = useRef(0)
  useEffect(() => {
    const current = ++generation.current
    setCursors({})
    if (tab !== 'archived') { setStatus('idle'); return }
    setStatus('loading')
    const kinds: ArchivedKind[] = has(perms, P.MANAGE_THREADS) ? ['public', 'private'] : ['public', 'joined']
    Promise.all(kinds.map(async (kind) => [kind, archivedCursor(kind, await archivedThreads(channel.id, kind))] as const)).then(
      (entries) => { if (generation.current === current) { setCursors(Object.fromEntries(entries)); setStatus('idle') } },
      () => { if (generation.current === current) setStatus('error') },
    )
    return () => { generation.current++ }
  }, [tab, channel.id, perms])
  const loadMore = async () => {
    if (status === 'loading') return
    const current = generation.current
    setStatus('loading')
    try {
      await Promise.all((Object.entries(cursors) as [ArchivedKind, string | undefined][]).filter(([, before]) => before).map(async ([kind, before]) => {
        const next = archivedCursor(kind, await archivedThreads(channel.id, kind, before))
        if (generation.current === current) setCursors((old) => ({ ...old, [kind]: next }))
      }))
      if (generation.current === current) setStatus('idle')
    } catch { if (generation.current === current) setStatus('error') }
  }
  const canCreate = has(perms, P.CREATE_PUBLIC_THREADS) || has(perms, P.CREATE_PRIVATE_THREADS)
  const query = q.trim().toLowerCase()
  const list = (tab === 'active'
    ? activeThreads(s, channel.id)
    : Object.values(s.channels).filter((c) => c.parent_id === channel.id && c.thread_metadata?.archived).sort((a, b) => cmpId(b.last_message_id ?? b.id, a.last_message_id ?? a.id))
  ).filter((x) => !query || x.name?.toLowerCase().includes(query))
  return (
    <Popover at={at} onClose={onClose} label={t('Threads')} className="threads-pop">
      <div className="threads-pop-head">
        <Icon d={ICONS.thread} size={20} />
        <h2>{t('Threads')}</h2>
        <input className="input" type="search" aria-label={t('Search for thread name')} placeholder={t('Search for Thread Name')} value={q} onChange={(e) => setQ(e.target.value)} />
        {canCreate && (
          <button className="primary small-btn" onClick={() => (onClose(), setState({ modal: { kind: 'create-thread', channelId: channel.id } }))}>{t('Create')}</button>
        )}
      </div>
      <div className="tabs" role="tablist" aria-label={t('Thread lists')}>
        {(['active', 'archived'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={cls('tab', tab === k && 'on')} onClick={() => setTab(k)}>
            {k === 'active' ? t('Active') : t('Archived')}
          </button>
        ))}
      </div>
      <div className="threads-pop-body" role="tabpanel" aria-busy={status === 'loading'}>
        {status === 'error' && <p className="form-error" role="alert">{t("Couldn't load archived threads.")}</p>}
        {status !== 'loading' && !list.length && <p className="hint threads-empty">{query ? t('No threads match your search.') : tab === 'active' ? t('There are no active threads.') : t('There are no archived threads.')}</p>}
        <ul>
          {list.map((th) => (
            <li key={th.id}>
              <button className="thread-item" onClick={() => (onClose(), openThread(th))}>
                <span className="thread-item-name ellipsis">{th.type === 12 && <Icon d={ICONS.lock} size={12} />} {th.name}</span>
                <span className="hint small">
                  {t(th.message_count === 1 ? '{n} message' : '{n} messages', { n: th.message_count ?? 0 })}
                  {th.last_message_id && <> · {relative(snowflakeTime(th.last_message_id))}</>}
                  {th.member && ` · ${t('Joined')}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {tab === 'archived' && Object.values(cursors).some(Boolean) && (
          <button className="link" disabled={status === 'loading'} onClick={loadMore}>{t('Load more')}</button>
        )}
      </div>
    </Popover>
  )
}
