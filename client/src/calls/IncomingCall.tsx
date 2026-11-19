// Incoming call popup with the generated ringtone; plays the "calling" tone while we wait for others to pick up.
import { useEffect, useRef } from 'react'
import { apply } from '../store'
import { stopRinging } from '../actions'
import { Avatar, channelIconUrl, Icon, ICONS } from '../components/ui'
import { t } from '../i18n'
import { startRing, stopRing } from '../notifications/sounds'
import { navigate } from '../router'
import { privateName } from '../selectors'
import { callStates, getState, useStore } from '../store'
import { joinVoice } from '../voice/engine'
import { ACCEPT_KEYS, acceptKey, typingIn } from '../keyboard/keyrules'
import './calls.css'

export function IncomingCall() {
  const s = useStore((x) => x)
  const me = s.me?.id ?? ''
  const incoming = Object.values(s.calls).find((c) => c.ringing.includes(me) && s.voice.channelId !== c.channel_id && s.channels[c.channel_id])
  // Outgoing: we are in a DM call, alone, and others are being rung.
  const mine = !s.voice.guildId && s.voice.channelId ? s.calls[s.voice.channelId] : undefined
  const waiting = !!mine && mine.ringing.some((id) => id !== me) && callStates(s, mine.channel_id).every((v) => v.user_id === me)
  const tone = incoming ? 'incoming' : waiting ? 'outgoing' : null
  useEffect(() => {
    if (!tone || (tone === 'incoming' && (s.presences[me] ?? s.settings.status) === 'dnd')) return
    startRing(tone)
    return stopRing
  }, [tone, me]) // eslint-style: presence changes do not restart the tone
  // Round 7 (A-R7-1): the dialog never takes focus from where the user types, and Accept is not the default action:
  // a pointer or touch on Accept, or the dedicated shortcut (not in a text field, not in the first second).
  const shownAt = useRef(0)
  const ringId = incoming?.channel_id
  const acceptRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!ringId) return
    shownAt.current = Date.now()
    const onKey = (e: KeyboardEvent) => {
      if (!acceptKey(e, Date.now() - shownAt.current, typingIn(document.activeElement))) return
      e.preventDefault()
      acceptRef.current()
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [ringId])
  if (!incoming) return null
  const ch = s.channels[incoming.channel_id]
  const caller = callStates(s, ch.id).find((v) => v.user_id !== me)
  const who = caller ? s.users[caller.user_id] : ch.recipients?.[0]
  const name = privateName(s, ch)
  const decline = () => {
    apply('CALL_UPDATE', { ...incoming, ringing: incoming.ringing.filter((id) => id !== me) }) // optimistic: stop ringing here at once
    void stopRinging(ch.id).catch(() => {})
  }
  const accept = () => {
    joinVoice(null, ch.id)
    navigate(`/channels/@me/${ch.id}`)
  }
  acceptRef.current = accept
  return (
    <div className="incoming-call" role="alertdialog" aria-labelledby="incoming-call-name" aria-describedby="incoming-call-text">
      <div className="incoming-avatar"><Avatar user={who} src={ch.type === 3 ? channelIconUrl(ch) : undefined} size={80} /></div>
      <h2 id="incoming-call-name" className="ellipsis">{name}</h2>
      <p id="incoming-call-text" className="hint">{t('Incoming Call…')}</p>
      <p className="hint small">{t('Accept with a click or {keys}', { keys: ACCEPT_KEYS })}</p>
      <div className="incoming-actions">
        <button className="round-btn big danger" aria-label={t('Decline')} title={t('Decline')} onClick={decline}><Icon d={ICONS.hangup} size={24} /></button>
        <button className="round-btn big ok" aria-label={t('Accept')} title={`${t('Accept')} (${ACCEPT_KEYS})`} aria-keyshortcuts="Control+Alt+A" onClick={(e) => e.detail > 0 && accept()}><Icon d={ICONS.phone} size={24} /></button>
      </div>
    </div>
  )
}
/** Keeps a reference so `getState` stays imported for callers that ring from outside React. */
export const ringingMe = () => Object.values(getState().calls).some((c) => c.ringing.includes(getState().me?.id ?? ''))
