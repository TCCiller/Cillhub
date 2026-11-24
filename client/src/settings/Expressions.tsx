// Server Settings > Emoji, Stickers and Soundboard managers (CONTRACT-v3 section 3).
import { t } from '../i18n'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createEmoji, createSound, createSticker, deleteEmoji, deleteSound, deleteSticker, loadSounds, updateEmoji, updateSticker, updateSound } from '../actions'
import { cdn, dataUri } from '../api'
import { ask } from '../components/dialogs'
import { FormError, Icon, ICONS } from '../components/ui'
import { emojiUrl } from '../markdown/Markdown'
import { canEditExpression, P, has } from '../permissions'
import { usePerms } from '../selectors'
import { apply, displayName, getState, useStore } from '../store'
import type { Emoji, Guild, Sound, Sticker } from '../types'
import { Popover, type Anchor } from '../components/menu'
import { EmojiPicker } from '../emoji/EmojiPicker'
import { EMOJI } from '../emoji/data'
import { prepareSticker } from '../expressions/stickerFile'

const ALL_EMOJI = EMOJI.flatMap((c) => c.list)
/** Clients store a sticker's related emoji as the emoji's name in `tags`; show the emoji again when we know it. */
const emojiForTags = (tags = "") => ALL_EMOJI.find((e) => e.name === tags)?.char ?? tags

const EMOJI_NAME = /^[A-Za-z0-9_]{2,32}$/
/** "my cool-emoji.png" -> "my_cool_emoji" (2–32 of [A-Za-z0-9_]). */
export const emojiNameFrom = (file: string) => file.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32).padEnd(2, '_')
if (import.meta.env.DEV) console.assert(emojiNameFrom('my cool-emoji.png') === 'my_cool_emoji' && emojiNameFrom('a.gif') === 'a_', 'emoji name from file')

export const stickerUrl = (s: { id: string; format_type: number }) => cdn(`/stickers/${s.id}.${s.format_type === 4 ? 'gif' : 'png'}`)

function useCanEdit(guildId: string) {
  const perms = usePerms(guildId)
  const meId = useStore((s) => s.me?.id ?? '')
  return { perms, canEdit: (uploader?: string) => canEditExpression(perms, uploader, meId), canAdd: has(perms, P.MANAGE_GUILD_EXPRESSIONS) || has(perms, P.CREATE_GUILD_EXPRESSIONS) }
}

const remove = (what: string, name: string, run: () => Promise<unknown>, onError: (e: Error) => void) =>
  void ask({ title: t('Delete {what}', { what: t(what) }), body: <p>{t('Are you sure you want to delete {name}? This cannot be undone.', { name })}</p>, confirm: t('Delete'), danger: true })
    .then((ok) => void (ok && run().catch(onError)))

export function EmojiPage({ guild }: { guild: Guild }) {
  const { canEdit, canAdd } = useCanEdit(guild.id)
  const [error, setError] = useState('')
  const list = guild.emojis ?? []
  const animated = list.filter((e) => e.animated).length
  const setList = (emojis: Emoji[]) => apply('GUILD_EMOJIS_UPDATE', { guild_id: guild.id, emojis })
  const upload = async (file: File) => {
    setError('')
    try {
      const image = await dataUri(file, 256 * 1024)
      const e = await createEmoji(guild.id, emojiNameFrom(file.name), image)
      if (!(guild.emojis ?? []).some((x) => x.id === e.id)) setList([...(guild.emojis ?? []), e])
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <>
      <h1>{t('Emoji')}</h1>
      <p className="hint">{t('Add up to 100 custom emoji and 100 animated emoji that anyone can use in this server. Names must be 2–32 letters, numbers or underscores. PNG, JPEG, GIF or WebP, at most 256 KB.')}</p>
      {canAdd && (
        <label className="primary file-btn">
          {t('Upload Emoji')}
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = '' }} />
        </label>
      )}
      <FormError error={error} />
      <h2 className="sub-title">{t('Emoji — {s} of 100 static, {a} of 100 animated', { s: list.length - animated, a: animated })}</h2>
      {!list.length && <p className="hint">{t('No emoji yet.')}</p>}
      <ul className="expr-list" aria-label={t('Server emoji')}>
        {list.map((e) => (
          <li key={e.id} className="expr-row">
            <img className="expr-img" src={emojiUrl(e.id!, e.animated)} alt="" />
            <EmojiName guildId={guild.id} e={e} editable={canEdit(e.user?.id)} onError={setError} />
            <EmojiRoles guild={guild} emoji={e} editable={canEdit(e.user?.id)} />
            <span className="hint small ellipsis">{e.user ? displayName(e.user) : ''}</span>
            {canEdit(e.user?.id) && (
              <button className="icon-btn" aria-label={t('Delete emoji {name}', { name: e.name })} onClick={() => remove('Emoji', `:${e.name}:`, () => deleteEmoji(guild.id, e.id!).then(() => setList((guild.emojis ?? []).filter((x) => x.id !== e.id))), (err) => setError(err.message))}>
                <Icon d={ICONS.trash} size={16} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  )
}

function EmojiRoles({ guild, emoji, editable }: { guild: Guild; emoji: Emoji; editable: boolean }) {
  const [at, setAt] = useState<Anchor | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const roles = guild.roles.filter((role) => role.id !== guild.id)
  const restriction = emoji.roles?.length
    ? emoji.roles.map((id) => roles.find((role) => role.id === id)?.name ?? id).join(', ')
    : t('Everyone')
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const updated = await updateEmoji(guild.id, emoji.id!, { roles: selected })
      apply('GUILD_EMOJIS_UPDATE', {
        guild_id: guild.id,
        emojis: (getState().guilds[guild.id]?.emojis ?? []).map((item) => item.id === emoji.id ? updated : item),
      })
      setAt(null)
    } catch (err) { setError((err as Error).message) }
    finally { setBusy(false) }
  }
  return (
    <>
      <span className="hint small ellipsis" title={restriction}>{restriction}</span>
      {editable && <button className="secondary small-btn" aria-label={t('Roles for emoji {name}', { name: emoji.name })} aria-expanded={!!at}
        onClick={(ev) => {
          setSelected([...(emoji.roles ?? [])])
          setError('')
          setAt({ rect: ev.currentTarget.getBoundingClientRect(), side: 'below' })
        }}>{t('Roles')}</button>}
      {editable && at && (
        <Popover at={at} onClose={() => !busy && setAt(null)} label={t('Roles for emoji {name}', { name: emoji.name })}>
          <fieldset className="plain" disabled={busy}>
            <legend className="field-label">{t('Roles')}</legend>
            <div className="check-list">
              {roles.map((role) => <label key={role.id}><input type="checkbox" checked={selected.includes(role.id)}
                onChange={() => setSelected((ids) => ids.includes(role.id) ? ids.filter((id) => id !== role.id) : [...ids, role.id])} /> {role.name}</label>)}
            </div>
          </fieldset>
          <p className="hint small">{t('No roles selected means everyone can use this emoji.')}</p>
          <FormError error={error} />
          <div className="modal-actions">
            <button className="secondary" disabled={busy} onClick={() => setAt(null)}>{t('Cancel')}</button>
            <button className="primary" disabled={busy} onClick={() => void save()}>{t('Save')}</button>
          </div>
        </Popover>
      )}
    </>
  )
}

function EmojiName({ guildId, e, editable, onError }: { guildId: string; e: Emoji; editable: boolean; onError: (s: string) => void }) {
  const [name, setName] = useState(e.name)
  useEffect(() => setName(e.name), [e.name])
  const valid = EMOJI_NAME.test(name)
  const commit = () => {
    if (name === e.name) return
    if (!valid) return onError(t('Emoji names must be 2–32 letters, numbers or underscores.')), setName(e.name)
    updateEmoji(guildId, e.id!, { name }).catch((err: Error) => (onError(err.message), setName(e.name)))
  }
  if (!editable) return <span className="expr-name">:{e.name}:</span>
  return (
    <input className="input expr-name" aria-label={t('Name of emoji {name}', { name: e.name })} aria-invalid={!valid || undefined} maxLength={32} value={name}
      onChange={(ev) => setName(ev.target.value)} onBlur={commit} onKeyDown={(ev) => ev.key === 'Enter' && ev.currentTarget.blur()} />
  )
}

function ExpressionName({ name: saved, editable, label, maxLength, save, onError }: {
  name: string; editable: boolean; label: string; maxLength: number
  save: (name: string) => Promise<unknown>; onError: (message: string) => void
}) {
  const [name, setName] = useState(saved)
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  useEffect(() => setName(saved), [saved])
  const commit = async () => {
    const next = name.trim()
    if (saving.current || next === saved) { setName(saved); return }
    saving.current = true
    setBusy(true)
    onError('')
    try {
      await save(next)
      setName(next)
    } catch (err) {
      onError((err as Error).message)
      setName(saved)
    } finally {
      saving.current = false
      setBusy(false)
    }
  }
  if (!editable) return <span className="expr-name ellipsis">{saved}</span>
  return (
    <input className="input expr-name" aria-label={label} minLength={2} maxLength={maxLength} disabled={busy}
      aria-invalid={name.trim().length < 2 || undefined} value={name} onChange={(ev) => setName(ev.target.value)}
      onBlur={() => void commit()} onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.currentTarget.blur() } }} />
  )
}

export function StickersPage({ guild }: { guild: Guild }) {
  const { canEdit, canAdd } = useCanEdit(guild.id)
  const list = guild.stickers ?? []
  const [file, setFile] = useState<File | null>(null)
  const [note, setNote] = useState('')
  const [preview, setPreview] = useState('')
  const [related, setRelated] = useState<{ char: string; name: string } | null>(null)
  const [pickerAt, setPickerAt] = useState<Anchor | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const setList = (stickers: Sticker[]) => apply('GUILD_STICKERS_UPDATE', { guild_id: guild.id, stickers })
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview])
  const choose = (picked: File | undefined) => {
    setError('')
    setNote('')
    setFile(null)
    setPreview('')
    if (!picked) return
    prepareSticker(picked).then(
      (r) => (setFile(r.file), setNote(r.note), setPreview(URL.createObjectURL(r.file))),
      (err: Error) => setError(err.message),
    )
  }
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const f = new FormData(form)
    if (!file) return setError(t('Choose a sticker file.'))
    if (!related) return setError(t('Choose a related emoji.'))
    setBusy(true)
    setError('')
    createSticker(guild.id, file, String(f.get('name')).trim(), related.name, String(f.get('description')).trim()).then(
      (s) => (!(guild.stickers ?? []).some((x) => x.id === s.id) && setList([...(guild.stickers ?? []), s]), form.reset(), setFile(null), setNote(''), setPreview(''), setRelated(null), setBusy(false)),
      (err: Error) => (setError(err.message), setBusy(false)),
    )
  }
  return (
    <>
      <h1>{t('Stickers')}</h1>
      <p className="hint">{t('Up to 60 stickers that anyone can send in this server. PNG, APNG, GIF, WebP or JPEG. Bigger still images are scaled down to 320×320 for you; animated ones must already be at most 320×320 and 512 KB.')}</p>
      {canAdd && list.length < 60 && (
        <form className="expr-form" onSubmit={submit} aria-label={t('Upload a sticker')}>
          <label className="secondary file-btn">
            {file ? file.name : t('Choose File')}
            <input type="file" accept="image/png,image/apng,image/gif,image/webp,image/jpeg" className="sr-only" onChange={(e) => choose(e.target.files?.[0])} />
          </label>
          {preview && <img className="sticker-preview" src={preview} alt={t('Sticker preview')} />}
          <div className="field grow"><label htmlFor="st-name">{t('Sticker Name')}</label><input id="st-name" name="name" className="input" required minLength={2} maxLength={30} /></div>
          <div className="field">
            <span className="field-label" id="st-tags-label">{t('Related Emoji')}</span>
            <button type="button" className="input emoji-input emoji-field" aria-labelledby="st-tags-label" aria-haspopup="dialog" aria-description={related ? `:${related.name}:` : t('None chosen')}
              onClick={(e) => setPickerAt({ rect: e.currentTarget.getBoundingClientRect(), side: 'below' })}>
              {related ? related.char : <span className="hint">{t('Choose')}</span>}
            </button>
          </div>
          <div className="field grow"><label htmlFor="st-desc">{t('Description')}</label><input id="st-desc" name="description" className="input" maxLength={100} /></div>
          <button className="primary" disabled={busy}>{t('Upload')}</button>
        </form>
      )}
      {pickerAt && (
        <EmojiPicker at={pickerAt} onClose={() => setPickerAt(null)} onPick={(char, ref) => {
          // Stickers relate to standard emoji only; custom emoji are not offered here (no guildId).
          if (ref.id) return
          setRelated({ char, name: ALL_EMOJI.find((e) => e.char === char)?.name ?? char })
          setPickerAt(null)
        }} />
      )}
      {note && <p className="hint small" role="status">{note}</p>}
      <FormError error={error} />
      <h2 className="sub-title">{t('Stickers — {n} of 60', { n: list.length })}</h2>
      {!list.length && <p className="hint">{t('No stickers yet.')}</p>}
      <ul className="sticker-grid" aria-label={t('Server stickers')}>
        {list.map((s) => (
          <li key={s.id} className="sticker-card">
            <img src={stickerUrl(s)} alt={s.name} />
            <ExpressionName name={s.name} editable={canEdit(s.user?.id)} label={t('Name of sticker {name}', { name: s.name })} maxLength={30} onError={setError}
              save={(name) => updateSticker(guild.id, s.id, { name }).then((updated) => setList((getState().guilds[guild.id]?.stickers ?? []).map((x) => x.id === s.id ? updated : x)))} />
            <span className="hint small">{emojiForTags(s.tags)}</span>
            {canEdit(s.user?.id) && (
              <button className="icon-btn" aria-label={t('Delete sticker {name}', { name: s.name })} onClick={() => remove('Sticker', s.name, () => deleteSticker(guild.id, s.id).then(() => setList((guild.stickers ?? []).filter((x) => x.id !== s.id))), (err) => setError(err.message))}>
                <Icon d={ICONS.trash} size={16} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  )
}

/** Duration of an audio file in seconds, read by the browser. */
const audioDuration = (file: File) =>
  new Promise<number>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const a = new Audio()
    a.preload = 'metadata'
    a.onloadedmetadata = () => (URL.revokeObjectURL(url), resolve(a.duration))
    a.onerror = () => (URL.revokeObjectURL(url), reject(new Error(t('Could not read that audio file.'))))
    a.src = url
  })

export const playSound = (s: Sound, volume = 1) => {
  const a = new Audio(cdn(`/soundboard-sounds/${s.sound_id}`))
  a.volume = Math.max(0, Math.min(1, s.volume * volume))
  void a.play().catch(() => {})
}

export function SoundboardPage({ guild }: { guild: Guild }) {
  const { canEdit, canAdd } = useCanEdit(guild.id)
  const list = useStore((s) => s.sounds[guild.id])
  const [file, setFile] = useState<File | null>(null)
  const [volume, setVolume] = useState(100)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => void (!list && loadSounds(guild.id).catch((e: Error) => setError(e.message))), [guild.id, list])
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setError('')
    if (!file) return setError(t('Choose a sound file.'))
    setBusy(true)
    try {
      if ((await audioDuration(file)) > 5.2) throw new Error(t('Sounds can be at most 5.2 seconds long.'))
      const sound = await dataUri(file, 512 * 1024, /^audio\/(mpeg|mp3|ogg)$/)
      await createSound(guild.id, { name: String(f.get('name')).trim(), sound, volume: volume / 100, emoji_name: String(f.get('emoji')).trim() || null })
      form.current?.reset()
      setFile(null)
      setVolume(100)
    } catch (err) {
      setError((err as Error).message)
    }
    setBusy(false)
  }
  return (
    <>
      <h1>{t('Soundboard')}</h1>
      <p className="hint">{t('Up to 48 sounds that members can play in voice channels. MP3 or OGG, at most 512 KB and 5.2 seconds.')}</p>
      {canAdd && (list?.length ?? 0) < 48 && (
        <form ref={form} className="expr-form" onSubmit={submit} aria-label={t('Upload a sound')}>
          <label className="secondary file-btn">
            {file ? file.name : t('Choose File')}
            <input type="file" accept="audio/mpeg,audio/ogg,.mp3,.ogg" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <div className="field grow"><label htmlFor="snd-name">{t('Sound Name')}</label><input id="snd-name" name="name" className="input" required minLength={2} maxLength={32} /></div>
          <div className="field"><label htmlFor="snd-emoji">{t('Emoji')}</label><input id="snd-emoji" name="emoji" className="input emoji-input" maxLength={8} placeholder="🔊" /></div>
          <div className="field"><label htmlFor="snd-vol">{t('Volume')} <span className="hint">{volume}%</span></label><input id="snd-vol" type="range" min={0} max={100} value={volume} onChange={(e) => setVolume(+e.target.value)} /></div>
          <button className="primary" disabled={busy}>{t('Upload')}</button>
        </form>
      )}
      <FormError error={error} />
      <h2 className="sub-title">{t('Sounds — {n} of 48', { n: list?.length ?? 0 })}</h2>
      {list?.length === 0 && <p className="hint">{t('No sounds yet.')}</p>}
      <ul className="expr-list" aria-label={t('Soundboard sounds')}>
        {list?.map((s) => (
          <li key={s.sound_id} className="expr-row">
            <span className="expr-img sound-emoji" aria-hidden="true">{s.emoji_id ? <img src={emojiUrl(s.emoji_id)} alt="" /> : s.emoji_name ?? '🔊'}</span>
            <ExpressionName name={s.name} editable={canEdit(s.user?.id)} label={t('Name of sound {name}', { name: s.name })} maxLength={32} onError={setError}
              save={(name) => updateSound(guild.id, s.sound_id, { name })} />
            <span className="hint small">{Math.round(s.volume * 100)}%</span>
            <button className="icon-btn" aria-label={t('Preview {name}', { name: s.name })} onClick={() => playSound(s)}><Icon d={ICONS.play} size={16} /></button>
            {canEdit(s.user?.id) && (
              <button className="icon-btn" aria-label={t('Delete sound {name}', { name: s.name })} onClick={() => remove('Sound', s.name, () => deleteSound(guild.id, s.sound_id), (err) => setError(err.message))}>
                <Icon d={ICONS.trash} size={16} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  )
}
