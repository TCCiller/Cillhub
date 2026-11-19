// Which voice connections a server may set up (secloop round 6, C-R6-1). A VOICE_SERVER_UPDATE is only followed for a
// join the user started on this device (or the call it became), and only to a media server on the host of the
// connection the event came from. Pure: scripts/voice-consent.test.mjs runs it as is.

/** A join the user started here: what the server's answer must name. Cleared on leave, teardown and every failure. */
export type Intent = { guildId: string | null; channelId: string; until: number }
/** The call this device is in: `established` once a server answer for it was followed and not failed or left since. */
export type Call = { guildId: string | null; channelId: string | null; established: boolean }

/** A join waits at most this long for the server's answer (its own timeout is 5 s). */
export const INTENT_MS = 15_000
export const intentFor = (guildId: string | null, channelId: string, now: number): Intent => ({ guildId, channelId, until: now + INTENT_MS })
const live = (i: Intent | null, guildId: string | null, channelId: unknown, now: number): i is Intent =>
  !!i && now <= i.until && i.guildId === guildId && i.channelId === channelId

/** VOICE_SERVER_UPDATE (also the "not configured" answer): only for a live intent, or the established call itself. The
 *  server sends it to the joining session only, for the channel it asked for (op 4), or after a move (members.js),
 *  which comes after our voice state already named the new channel (see moveVerdict). */
export function serverUpdateAllowed(d: { guild_id?: unknown; channel_id?: unknown }, intent: Intent | null, call: Call, now: number): boolean {
  const g = d.guild_id ?? null
  if (typeof d.channel_id !== 'string' || (g !== null && typeof g !== 'string')) return false
  if (live(intent, g, d.channel_id, now)) return true
  return call.established && call.guildId === g && call.channelId === d.channel_id
}

/** Our own voice state naming another channel than ours: `own` = the channel the user just chose here, `moved` = the
 *  server moved us (only guild voice channels of the same server; the microphone is muted until the user unmutes),
 *  `ignore` = nothing a server can move (DM calls, another server, an unknown or non-voice channel). */
export function moveVerdict(guildId: string | null, d: { channel_id?: unknown }, target: { guild_id?: string | null; type: number } | undefined, intent: Intent | null, now: number): 'own' | 'moved' | 'ignore' {
  if (!guildId || typeof d.channel_id !== 'string' || !target || target.guild_id !== guildId || (target.type !== 2 && target.type !== 13)) return 'ignore'
  return live(intent, guildId, d.channel_id, now) ? 'own' : 'moved'
}

/**
 * The media server URL of an endpoint as the voice engine connects to it, or null when it is not one this connection
 * may name: "cillvoice" (signalling over the same gateway), or a LiveKit URL on the host of `origin` (the connection the
 * event came from: the primary server's API origin, or the node's URL). Another port of that host is fine (LiveKit on
 * :7880); another host, a downgrade from https to ws, or credentials in the URL are not. Accepts what the server sends:
 * full ws(s)/http(s) URLs, bare hosts and root-relative paths.
 */
export function mediaUrl(endpoint: unknown, origin: string): string | null {
  if (endpoint === 'cillvoice') return endpoint
  if (typeof endpoint !== 'string' || !endpoint) return null
  let base: URL
  try { base = new URL(origin) } catch { return null }
  const secure = base.protocol === 'https:'
  const scheme = secure ? 'wss://' : 'ws://'
  const ws = /^wss?:\/\//i.test(endpoint) ? endpoint
    : /^https?:\/\//i.test(endpoint) ? endpoint.replace(/^http/i, 'ws')
    : endpoint.startsWith('/') && !endpoint.startsWith('//') ? scheme + base.host + endpoint
    : endpoint.startsWith('/') ? null
    : scheme + endpoint
  if (!ws) return null
  let url: URL
  try { url = new URL(ws) } catch { return null }
  if (url.hostname !== base.hostname || url.username || url.password) return null
  if (secure && url.protocol !== 'wss:') return null
  return ws
}

// ---------- round 7 ----------

/** The call as it was when its gateway connection dropped: only such a call may come back after the new READY. */
export type Restorable = { guildId: string | null; channelId: string; host: string; mic: boolean }

/** The media server's host of an endpoint as the engine connects to it ("cillvoice", or host:port of the URL). */
export function mediaHost(url: string): string {
  if (url === 'cillvoice') return url
  try { return new URL(url).host.toLowerCase() } catch { return '' }
}

/** What a READY does with the call this device has: `rejoin` a call that was connected when the connection dropped (the
 *  same channel), `again` ask once more for a join the user started just now (its own intent, nothing new), else `end`
 *  (idle). READY never makes an intent of its own. */
export function readyVerdict(call: { guildId: string | null; channelId: string | null; status: string }, was: Restorable | null, intent: Intent | null, now: number): 'rejoin' | 'again' | 'end' {
  if (was && call.channelId === was.channelId && call.guildId === was.guildId) return 'rejoin'
  if (call.status === 'waiting' && live(intent, call.guildId, call.channelId, now)) return 'again'
  return 'end'
}

/** A sound named by a server event (soundboard, entrance) plays only from the connection's own origin. No URL: the
 *  built-in path on that origin. */
export function soundAllowed(url: string | undefined, origin: string): boolean {
  if (url === undefined) return true
  try { return !!origin && new URL(url).origin === new URL(origin).origin } catch { return false }
}

/** Speaking given back by the server never opens the microphone (stage invite, SPEAK granted, server mute lifted, our
 *  voice state in READY): `held` = the server did not let us speak since the user's own last unmute or join; when it
 *  lets us again, the user is asked once (`prompt`: mute and say so), unless they asked to speak just now. */
export function speakGate(g: { held: boolean; prompted: boolean }, allows: boolean, askedUntil: number, now: number) {
  if (!allows) return { held: true, prompted: false, prompt: false }
  if (!g.held) return { ...g, prompt: false }
  if (now <= askedUntil) return { held: false, prompted: false, prompt: false }
  return { held: true, prompted: true, prompt: !g.prompted }
}

/** The AFK move (server-chosen channel and timeout) only moves a call that is connected. */
export const afkMayMove = (status: string, established: boolean) => status === 'connected' && established
