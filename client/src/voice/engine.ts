import { instanceById, nodeOf, nodeUserId } from '../instances/registry'
import { joins } from './join'
// LiveKit identities of a node's room are that node's user ids: scoped (ours → our hub id) before any map key or tile.
let roomNode: string | undefined
const userOf = (p: { identity: string }) => nodeUserId(roomNode, p.identity)
const speakingOf = (ps: { identity: string }[]) => Object.fromEntries(ps.flatMap((p) => { const id = userOf(p); return id ? [[id, true as const]] : [] }))
// Voice connection: gateway op 4 / VOICE_SERVER_UPDATE handling and the LiveKit room (CONTRACT-v2 section 10).
// livekit-client is imported lazily so it only loads once someone joins voice. When VOICE_SERVER_UPDATE names the
// endpoint "cillvoice", Cillhub's own media server is used instead: every action below then goes to ./cillvoice.
import type { LocalAudioTrack, LocalTrack, LocalTrackPublication, LocalVideoTrack, Participant, RemoteParticipant, Room, Track } from 'livekit-client'
import { api, apiOrigin, cdn } from '../api'
import { sendOp } from '../gateway'
import { P, has } from '../permissions'
import { canJoinVoice, permsOf } from '../selectors'
import { getState, idleVoice, setVoice, voiceKey } from '../store'
import { GainProcessor } from './gain'
import { t } from '../i18n'
import { markRnnoiseFailed, rnnoiseFailure } from '../rnnoise/rnnoise'
import { AV1_MODE, SCREEN_DEGRADATION, captureConstraints, noiseMode, RESOLUTIONS, saveVoiceSettings, screenCodecs, streamBitrate, voiceSettings, type StreamQuality, type VideoCodecName, type VoiceSettings } from './settings'
import { entranceHeard, playKind } from '../custom/sounds'
import * as cv from './cillvoice'
import { micHooks, withMic } from './settings'
import { installStartBitrateHint } from './startBitrate'
import { toast } from '../components/dialogs'
import { afkMayMove, intentFor, mediaHost, mediaUrl, moveVerdict, readyVerdict, serverUpdateAllowed, soundAllowed, speakGate, type Intent, type Restorable } from './consent'

let lk: typeof import('livekit-client') | null = null
let room: Room | null = null
let last: { endpoint: string; token: string } | null = null
let pttDown = false
const audioBox = () => document.getElementById('voice-audio') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'voice-audio', hidden: true }))

export const myState = () => {
  const { me, voice, voiceStates } = getState()
  return me && voice.channelId ? voiceStates[voiceKey(voice.guildId)]?.[me.id] : undefined
}
const bump = () => setVoice({ tracks: getState().voice.tracks + 1 })

Object.assign(cv.hooks, {
  bump, audioBox,
  onConnected: () => (setVoice({ status: 'connected' }), void syncMic(), bump()),
  onReconnecting: () => setVoice({ status: 'connecting' }),
  onLost: () => lost(),
  // the browser's own "Stop sharing" button
  onScreenEnded: () => getState().voice.stream && (setVoice({ stream: false }), sendState(), void cv.stopScreen().then(bump)),
})
let lostWarned = ''
micHooks.lost = (name) => {
  if (lostWarned === voiceSettings().input) return // once per missing device, not on every recapture
  lostWarned = voiceSettings().input
  toast(name ? t('Microphone “{name}” not found. Using the default microphone.', { name }) : t('Your chosen microphone was not found. Using the default microphone.'))
}

function sendState() {
  const v = getState().voice
  if (!v.guildId && !v.channelId) return
  sendOp(4, { guild_id: v.guildId, channel_id: v.channelId, self_mute: v.selfMute || v.selfDeaf, self_deaf: v.selfDeaf, self_video: v.video, self_stream: v.stream })
}

// A server's VOICE_SERVER_UPDATE is followed only for a join started on this device (this intent) or the call it became
// (voice/consent.ts): a server cannot open a media connection, and so the microphone, by itself.
let intent: Intent | null = null
const intend = (guildId: string | null, channelId: string) => void (intent = intentFor(guildId, channelId, Date.now()))
let speakUntil = 0
/** "Become a Speaker" / starting a stage: our own promotion, not muted on arrival. */
export const intendSpeak = () => void (speakUntil = Date.now() + 15_000)

// Round 7: the microphone never turns on because a server gave speaking back (stage invite, SPEAK granted, server mute
// lifted, our voice state in READY or GUILD_CREATE): `heldBack` is set while the server does not let us speak and stays
// until the user unmutes or joins; the server giving it back mutes us and asks (gate below).
let heldBack = false
let prompted = false
// A reconnect may restore only a call that was connected when its gateway dropped (snapshot taken then; undefined = no drop
// seen since the last READY), to the same channel and media host, with the microphone as it was.
let dropped: Restorable | null | undefined
let rejoinHost: string | null = null
// when the media connection of the call was lost: the server ends it when our gateway closes, maybe before we see the close
let lostAt = 0
let micAtLoss = false
const restorable = (): Restorable | null => {
  const v = getState().voice
  const ok = v.status === 'connected' || (v.status === 'error' && Date.now() - lostAt < 5000)
  return ok && last && v.channelId ? { guildId: v.guildId, channelId: v.channelId, host: mediaHost(last.endpoint), mic: v.status === 'connected' ? micWanted() : micAtLoss } : null
}
const lost = () => ((lostAt = Date.now()), (micAtLoss = micWanted()), setVoice({ status: 'error', error: 'Lost the voice connection.' }))
/** Gateway hook: the connection `from` (undefined = the primary server) dropped or was told to identify again. */
export function voiceDropped(from?: string) {
  if (from === nodeOf(getState().voice.guildId) && dropped === undefined) dropped = restorable()
}

let ringOnJoin: string | null = null
/** Joins a guild voice channel, or a DM / group DM call with `guildId` null (CONTRACT-v4); `ring` rings the others once we are in. */
export function joinVoice(guildId: string | null, channelId: string, opts: { ring?: boolean } = {}) {
  ringOnJoin = opts.ring ? channelId : null
  const v = getState().voice
  if (v.channelId === channelId && v.status !== 'error') return
  teardown() // the server moves our single voice state; the new room comes with VOICE_SERVER_UPDATE
  heldBack = prompted = false
  dropped = undefined
  rejoinHost = null
  intend(guildId, channelId)
  const s = voiceSettings()
  setVoice({ guildId, channelId, status: 'waiting', error: '', selfMute: s.selfMute, selfDeaf: s.selfDeaf, video: false, stream: false })
  sendState()
  waitForServer()
}

// The server ignores joins it does not allow (no CONNECT, channel full) without an error event.
let joinTimer = 0
function waitForServer() {
  clearTimeout(joinTimer)
  joinTimer = setTimeout(() => {
    if (getState().voice.status === 'waiting') (intent = null), setVoice({ status: 'error', error: "Couldn't join the voice channel." })
  }, 5000)
}

export function leaveVoice() {
  const v = getState().voice
  if (v.channelId) sendOp(4, { guild_id: v.guildId, channel_id: null, self_mute: v.selfMute, self_deaf: v.selfDeaf })
  endCall()
  setVoice({ ...idleVoice, selfMute: v.selfMute, selfDeaf: v.selfDeaf })
}
/** The call is over (left, ended by the server, logout): nothing of it may come back. */
function endCall() {
  teardown()
  heldBack = prompted = false
  dropped = undefined
  rejoinHost = null
}

const join = joins()
function teardown() {
  join.bump() // a LiveKit join still loading or connecting is stale now
  clearTimeout(joinTimer)
  intent = null
  lostAt = 0
  const r = room
  room = null
  last = null
  r?.disconnect().catch(() => {})
  cv.close()
  document.getElementById('voice-audio')?.replaceChildren()
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try { window.speechSynthesis.cancel() } catch {}
  }
}


// Remote voices play through Web Audio (needed for volumes above 100 %). livekit-client's own context uses the smallest
// buffer ('interactive'), which runs dry and crackles like static on a busy PC (a game running); 'playback' buffers more
// (some tens of ms). One context for every call, as cillvoice.ts does with its own.
let playCtx: AudioContext | null = null
const playbackContext = () => (playCtx && playCtx.state !== 'closed' ? playCtx : (playCtx = new AudioContext({ latencyHint: 'playback' })))

/** The media server of the current call, for the connection details: "cillvoice" or "LiveKit". */
export const voiceBackend = () => (!last ? null : last.endpoint === 'cillvoice' ? 'cillvoice' : 'LiveKit')

async function connectRoom(endpoint: string, token: string) {
  teardown()
  last = { endpoint, token }
  if (endpoint === 'cillvoice') return cv.connect(token)
  setVoice({ status: 'connecting', error: '', speaking: {} })
  // whose call this is, before any await: a switch while livekit-client loads must not hand this room another origin
  const origin = nodeOf(getState().voice.guildId)
  let started
  try {
    started = await join.start(async () => (lk ??= await import('livekit-client')))
  } catch {
    return setVoice({ status: 'error', error: 'Could not load the voice module.' })
  }
  if (!started) return // left or switched while loading
  const { Room, RoomEvent } = started.lib
  installStartBitrateHint()
  const s = voiceSettings()
  const chId = getState().voice.channelId
  const hifi = Boolean(chId && getState().channels[chId]?.quality_mode === 'hifi')
  const r = new Room({
    adaptiveStream: true, dynacast: true, webAudioMix: { audioContext: playbackContext() },
    audioCaptureDefaults: captureConstraints(s, undefined, hifi),
    publishDefaults: publishOptions(s),
    videoCaptureDefaults: { deviceId: s.camera || undefined },
    audioOutput: { deviceId: s.output || undefined },
  })
  room = r
  roomNode = origin // whose LiveKit this is: its identities are that node's user ids
  last = { endpoint, token }
  const live = () => room === r
  r.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => live() && setVoice({ speaking: speakingOf(speakers) }))
    .on(RoomEvent.TrackSubscribed, (track: Track, _pub, p: RemoteParticipant) => {
      if (!live()) return
      if (track.kind === 'audio') audioBox().appendChild(track.attach())
      applyVolume(p)
      bump()
    })
    .on(RoomEvent.TrackUnsubscribed, (track: Track) => (track.detach().forEach((el) => el.remove()), bump()))
    .on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => (applyVolume(p), bump(), void dropAv1(r)))
    .on(RoomEvent.ParticipantAttributesChanged, () => void dropAv1(r))
    .on(RoomEvent.ParticipantDisconnected, bump)
    .on(RoomEvent.TrackMuted, bump)
    .on(RoomEvent.TrackUnmuted, bump)
    .on(RoomEvent.LocalTrackPublished, bump)
    .on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
      if (!live()) return // an old room's tracks say nothing about the current call
      // The browser's own "Stop sharing" button ends the screen share without going through us.
      const v = getState().voice
      if (pub.source === 'screen_share' && v.stream && !republishing) (setVoice({ stream: false }), sendState())
      bump()
    })
    .on(RoomEvent.Reconnecting, () => live() && setVoice({ status: 'connecting' }))
    .on(RoomEvent.Reconnected, () => live() && setVoice({ status: 'connected' }))
    .on(RoomEvent.Disconnected, () => live() && lost())
    .on(RoomEvent.MediaDevicesError, (e: Error) => live() && setVoice({ error: `Device error: ${e.message}` }))
    // Stage: the server grants the microphone when we become a speaker; publish once the grant arrives.
    .on(RoomEvent.ParticipantPermissionsChanged, (_prev: unknown, p: Participant) => live() && p === r.localParticipant && void syncMic())
  try {
    await r.connect(endpoint, token) // already a ws(s) URL (mediaUrl)
  } catch (e) {
    if (live()) setVoice({ status: 'error', error: `Could not connect to voice${e instanceof Error && e.message ? `: ${e.message}` : '.'}` })
    return
  }
  if (!live()) return void r.disconnect()
  // Speakers announced while connect() was pending are already in activeSpeakers; resetting to {} would drop them.
  setVoice({ status: 'connected', speaking: speakingOf(r.activeSpeakers) })
  r.remoteParticipants.forEach(applyVolume)
  if (!decodesAv1()) void r.localParticipant.setAttributes({ av1: '0' }).catch(() => {}) // needs canUpdateOwnMetadata (server 7.4+)
  await syncMic()
  bump()
}

/**
 * AV1 on LiveKit: LiveKit sends no AV1 to a browser it rules out (every Safari) or that cannot decode it, and the H.264
 * backup copy it should then ask for never reaches such a viewer (LiveKit 1.13.7 with livekit-client 2.23: the backup's
 * subscribed quality stays OFF, scripts/e2e-v5-voice.cjs 6c3). So viewers without AV1 say so in a participant attribute,
 * and a sharer leaves AV1 out while one of them is in the room, republishing a running AV1 share as H.264 when one joins.
 * shortcut: the share stays H.264 after they leave; the next share uses AV1 again.
 */
const decodesAv1 = () => lk?.getBrowser()?.name !== 'Safari' && !!globalThis.RTCRtpReceiver?.getCapabilities?.('video')?.codecs.some((c) => c.mimeType === 'video/AV1')
const av1Blocked = (r: Room) => [...r.remoteParticipants.values()].some((p) => p.attributes.av1 === '0')
let republishing = false
async function dropAv1(r: Room) {
  const track = r.localParticipant.getTrackPublication('screen_share' as Track.Source.ScreenShare)?.videoTrack
  if (!track || track.codec !== 'av1' || !av1Blocked(r) || republishing) return
  republishing = true
  try {
    const q = voiceSettings().stream
    const o = screenOptions(q, (await screenCodecs(q)).filter((c) => c !== 'av1'))
    await r.localParticipant.unpublishTrack(track, false)
    await r.localParticipant.publishTrack(track, { ...o.publish, source: 'screen_share' as Track.Source.ScreenShare })
  } catch (e) {
    setVoice({ error: `Couldn't share your screen${e instanceof Error ? `: ${e.message}` : '.'}` })
  } finally {
    republishing = false
    bump()
  }
}

/** Retries the LiveKit connection with the last token (valid for 6 h), or asks the gateway for a new one. */
export function retryVoice() {
  const v = getState().voice
  if (last) return void connectRoom(last.endpoint, last.token)
  if (v.channelId) (intend(v.guildId, v.channelId), setVoice({ status: 'waiting', error: '' }), sendState(), waitForServer())
}

const deafened = () => getState().voice.selfDeaf || !!myState()?.deaf

function applyVolume(p: RemoteParticipant) {
  const s = voiceSettings()
  // Capped at 300 % overall to protect ears when user and output volume are both raised.
  const id = userOf(p) ?? ''
  const vol = deafened() ? 0 : Math.min(3, (s.volumes[id] ?? 1) * s.outputVolume)
  const streamVol = deafened() ? 0 : Math.min(3, (s.screenVolumes?.[id] ?? s.volumes[`${id}-screen`] ?? 1) * s.outputVolume)
  p.setVolume(vol)
  p.setVolume(streamVol, 'screen_share_audio' as Track.Source.ScreenShareAudio)
}

/** Whether the server lets us speak in our channel: SPEAK, no server mute or deafen; on a stage only as a speaker
 *  (our voice state says suppress false; unknown counts as audience). */
function serverAllows() {
  const v = getState().voice
  const ch = v.channelId ? getState().channels[v.channelId] : undefined
  const st = myState()
  return has(permsOf(getState(), v.guildId ?? undefined, ch), P.SPEAK) && !st?.mute && !st?.deaf && (ch?.type === 13 ? st?.suppress === false : !st?.suppress)
}
/** Whether the microphone should be sending now. */
function micWanted() {
  const v = getState().voice
  return serverAllows() && !heldBack && !v.selfMute && !v.selfDeaf && (voiceSettings().mode === 'vad' || pttDown)
}
/** Speaking given back by the server (any event) never opens the microphone: muted, and the user is asked. */
function gate() {
  if (!getState().voice.channelId) return
  const g = speakGate({ held: heldBack, prompted }, serverAllows(), speakUntil, Date.now())
  heldBack = g.held
  prompted = g.prompted
  if (g.prompt) mutedByServer('invited')
}

/** Publishes or mutes the microphone to match self mute/deafen, server mute/deafen, SPEAK and push-to-talk. */
async function syncMic() {
  gate()
  const r = room
  const v = getState().voice
  if (cv.active() && v.status === 'connected') {
    await cv.syncMic(micWanted()).catch((e) => setVoice({ error: `Couldn't use your microphone${e instanceof Error ? `: ${e.message}` : '.'}` }))
    return cv.applyVolumes()
  }
  if (!r || v.status !== 'connected') return
  const on = micWanted()
  const pub = r.localParticipant.getTrackPublication('microphone' as Track.Source.Microphone)
  try {
    const chId = getState().voice.channelId
    const hifi = Boolean(chId && getState().channels[chId]?.quality_mode === 'hifi')
    const set = () => r.localParticipant.setMicrophoneEnabled(on, captureConstraints(voiceSettings(), undefined, hifi), publishOptions())
    if (on && !pub) await withMic(set) // a new capture: resolve the saved device first
    else if (pub) await set()
    if (on) await syncGain()
  } catch (e) {
    setVoice({ error: `Couldn't use your microphone${e instanceof Error ? `: ${e.message}` : '.'}` })
  }
  r.remoteParticipants.forEach(applyVolume)
}

export function setSelfMute(mute: boolean) {
  const v = getState().voice
  // Unmuting while deafened undeafens too.
  const patch = { selfMute: mute, selfDeaf: mute ? v.selfDeaf : false }
  if (!mute) heldBack = prompted = false // the user's own unmute: what the server allows now may be sent
  if (v.channelId) playKind(v.selfDeaf && !mute ? 'deafen' : 'mute', mute)
  saveVoiceSettings(patch)
  setVoice(patch)
  sendState()
  void syncMic()
}

// Deafening also mutes (the mute buttons show it); undeafening restores the mute state from before.
let mutedBeforeDeaf = false
export function setSelfDeaf(deaf: boolean) {
  const v = getState().voice
  if (deaf && !v.selfDeaf) mutedBeforeDeaf = v.selfMute
  const patch = { selfDeaf: deaf, selfMute: deaf || (v.selfDeaf ? mutedBeforeDeaf : v.selfMute) }
  if (!patch.selfMute) heldBack = prompted = false
  if (v.channelId && deaf !== v.selfDeaf) playKind('deafen', deaf)
  saveVoiceSettings(patch)
  setVoice(patch)
  sendState()
  void syncMic()
}

export async function toggleCamera() {
  const r = room
  const v = getState().voice
  if (!r && !cv.active()) return
  try {
    if (cv.active()) await cv.setCamera(!v.video)
    else await r!.localParticipant.setCameraEnabled(!v.video, { deviceId: voiceSettings().camera || undefined })
    setVoice({ video: !v.video })
    sendState()
  } catch (e) {
    setVoice({ error: `Couldn't start your camera${e instanceof Error ? `: ${e.message}` : '.'}` })
  }
  bump()
}

export async function toggleScreen() {
  const r = room
  const g = join.now()
  const v = getState().voice
  if (!r && !cv.active()) return
  try {
    if (cv.active()) await (v.stream ? cv.stopScreen() : cv.startScreen(voiceSettings().stream))
    else await r!.localParticipant.setScreenShareEnabled(!v.stream, { audio: true, selfBrowserSurface: 'exclude' })
    if (staleSince(g)) return void (!cv.active() && !v.stream && r!.localParticipant.setScreenShareEnabled(false).catch(() => {}))
    setVoice({ stream: !v.stream })
    sendState()
  } catch (e) {
    if (staleSince(g)) return
    // Cancelling the browser's picker lands here too; that is not worth an error.
    if (!(e instanceof Error && e.name === 'NotAllowedError')) setVoice({ error: `Couldn't share your screen${e instanceof Error ? `: ${e.message}` : '.'}` })
  }
  bump()
}

// DTX off by default: with a constant noise floor (studio/XLR interfaces) its on/off gating sounds choppy and static.
const publishOptions = (s: VoiceSettings = voiceSettings()) => ({ audioPreset: { maxBitrate: s.bitrate }, dtx: s.dtx, red: true })

const micTrack = () => room?.localParticipant.getTrackPublication('microphone' as Track.Source.Microphone)?.track as LocalAudioTrack | undefined

/** Attaches, updates or removes the mic processor to match input volume and DSP chain. */
async function syncGain() {
  if (cv.active()) return cv.syncGain().catch((e) => setVoice({ error: `Couldn't apply the input volume${e instanceof Error ? `: ${e.message}` : '.'}` }))
  const track = micTrack()
  if (!track) return
  const s = voiceSettings()
  const chId = getState().voice.channelId
  const hifi = Boolean(chId && getState().channels[chId]?.quality_mode === 'hifi')
  const g = s.inputGain
  const mode = hifi ? 'off' : noiseMode(s)
  const denoise = mode === 'speex' || mode === 'enhanced' || mode === 'studio' ? mode : null
  const extras = hifi ? {} : { noiseGate: s.noiseGate, highPass: s.highPassFilter, compressor: s.voiceCompressor }
  const needsProcessing = g !== 1 || !!denoise || !!extras.noiseGate?.enabled || !!extras.highPass || !!extras.compressor

  const proc = track.getProcessor()
  try {
    if (!needsProcessing) {
      if (proc) await track.stopProcessor()
    } else if (proc instanceof GainProcessor && proc.matchesConfig(denoise, extras)) {
      proc.setGain(g)
    } else {
      await track.setProcessor(new GainProcessor(g, denoise, extras))
    }
  } catch (e) {
    if (!denoise) return setVoice({ error: `Couldn't apply the input volume${e instanceof Error ? `: ${e.message}` : '.'}` })
    markRnnoiseFailed(e)
    setVoice({ error: t('Noise suppression engine is unavailable ({reason}). Using Standard.', { reason: rnnoiseFailure() }) })
    await (track as unknown as { restartTrack: (c: MediaTrackConstraints) => Promise<void> }).restartTrack(captureConstraints(s, undefined, hifi)).catch(() => {})
    if (track.getProcessor()) await track.stopProcessor().catch(() => {})
    return syncGain()
  }
}

export async function setInputGain(v: number) {
  saveVoiceSettings({ inputGain: v })
  await syncGain()
}

export function setOutputVolume(v: number) {
  saveVoiceSettings({ outputVolume: v })
  room?.remoteParticipants.forEach(applyVolume)
  cv.applyVolumes()
}

const screenOptions = (q: StreamQuality, codecs: VideoCodecName[]) => {
  const s = voiceSettings()
  const captureAudio = s.screenAudio !== false && s.screenAudioMode !== 'none'
  return {
    capture: {
      audio: captureAudio ? ({ suppressLocalAudioPlayback: true } as any) : false,
      selfBrowserSurface: 'exclude' as const,
      surfaceSwitching: 'include' as const,
      systemAudio: s.screenAudioMode === 'application' ? ('exclude' as const) : ('include' as const),
      preferCurrentTab: false,
      resolution: { ...RESOLUTIONS[q.resolution], frameRate: q.fps },
      contentHint: q.mode,
    },
    publish: {
      screenShareEncoding: { maxBitrate: streamBitrate(q), maxFramerate: q.fps },
      degradationPreference: SCREEN_DEGRADATION,
      // AV1, H.264 (or VP9) when chosen and encodable. AV1 goes out as simulcast with one layer per stream (needs LiveKit
      // > 1.13.6), which also keeps our content hint: as SVC, livekit-client forces 'motion' on screen shares.
      videoCodec: codecs[0],
      ...(codecs[0] === 'av1' && { scalabilityMode: AV1_MODE }),
      // LiveKit asks us to add this copy when a viewer cannot decode the first codec (needs dynacast): H.264 behind AV1, else VP8
      backupCodec: { codec: codecs[0] === 'av1' && codecs.includes('h264') ? ('h264' as const) : ('vp8' as const) },
    },
  }
}

/** Starts screen sharing with the chosen quality (remembered for next time). */
// A screen share start or switch belongs to the call it began in: after a leave or switch it stops what it captured and
// changes nothing (join generation, voice/join.ts).
const stopAll = (m: MediaStream) => m.getTracks().forEach((t) => t.stop())
const staleSince = (g: number) => join.now() !== g

export async function startScreenShare(q: StreamQuality, captureCardDeviceId?: string) {
  saveVoiceSettings({ stream: q })
  const r = room
  const g = join.now()
  if ((!r && !cv.active()) || getState().voice.stream) return
  try {
    if (cv.active()) await cv.startScreen(q, captureCardDeviceId)
    else {
      const o = screenOptions(q, (await screenCodecs(q)).filter((c) => c !== 'av1' || !av1Blocked(r!)))
      if (captureCardDeviceId) {
        lk ??= await import('livekit-client')
        const { width, height } = RESOLUTIONS[q.resolution]
        const s = voiceSettings()
        const captureAudio = s.screenAudio !== false && s.screenAudioMode !== 'none'
        const m = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: captureCardDeviceId }, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: q.fps } },
          audio: captureAudio ? { deviceId: captureCardDeviceId } : false,
        })
        try {
          if (staleSince(g)) return stopAll(m)
          const vTrack = m.getVideoTracks()[0]
          if (!vTrack) throw new Error('No video track found on capture card')
          vTrack.contentHint = q.mode
          const localVideo = new lk.LocalVideoTrack(vTrack, undefined, false)
          localVideo.source = 'screen_share' as Track.Source.ScreenShare
          await r!.localParticipant.publishTrack(localVideo, { ...o.publish, source: 'screen_share' as Track.Source.ScreenShare })
          const aTrack = m.getAudioTracks()[0]
          if (aTrack && !staleSince(g)) {
            const localAudio = new lk.LocalAudioTrack(aTrack, undefined, false)
            localAudio.source = 'screen_share_audio' as Track.Source.ScreenShareAudio
            await r!.localParticipant.publishTrack(localAudio, { source: 'screen_share_audio' as Track.Source.ScreenShareAudio })
          }
          if (staleSince(g)) return stopAll(m)
        } catch (e) {
          stopAll(m)
          throw e
        }
      } else {
        await r!.localParticipant.setScreenShareEnabled(true, o.capture, o.publish)
        if (staleSince(g)) return void r!.localParticipant.setScreenShareEnabled(false).catch(() => {})
      }
    }
    if (staleSince(g)) return
    setVoice({ stream: true })
    sendState()
  } catch (e) {
    if (staleSince(g)) return
    // Cancelling the browser's picker lands here too; that is not worth an error.
    if (!(e instanceof Error && e.name === 'NotAllowedError')) setVoice({ error: `Couldn't share your screen${e instanceof Error ? `: ${e.message}` : '.'}` })
  }
  bump()
}

/** Changes which window/screen is streamed while screen sharing is active. */
export async function switchScreenShare(q: StreamQuality = voiceSettings().stream, captureCardDeviceId?: string) {
  const r = room
  const g = join.now()
  const v = getState().voice
  if ((!r && !cv.active()) || !v.stream) return
  try {
    if (cv.active()) {
      await cv.switchScreen(q, captureCardDeviceId)
    } else {
      const o = screenOptions(q, (await screenCodecs(q)).filter((c) => c !== 'av1' || !av1Blocked(r!)))
      let newTracks: LocalTrack[]
      if (captureCardDeviceId) {
        lk ??= await import('livekit-client')
        const { width, height } = RESOLUTIONS[q.resolution]
        const s = voiceSettings()
        const captureAudio = s.screenAudio !== false && s.screenAudioMode !== 'none'
        const m = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: captureCardDeviceId }, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: q.fps } },
          audio: captureAudio ? { deviceId: captureCardDeviceId } : false,
        })
        const vTrack = m.getVideoTracks()[0]
        if (!vTrack) throw new Error('No video track found on capture card')
        vTrack.contentHint = q.mode
        const localVideo = new lk.LocalVideoTrack(vTrack, undefined, false)
        localVideo.source = 'screen_share' as Track.Source.ScreenShare
        newTracks = [localVideo]
        const aTrack = m.getAudioTracks()[0]
        if (aTrack) {
          const localAudio = new lk.LocalAudioTrack(aTrack, undefined, false)
          localAudio.source = 'screen_share_audio' as Track.Source.ScreenShareAudio
          newTracks.push(localAudio)
        }
      } else {
        newTracks = await r!.localParticipant.createScreenTracks(o.capture)
      }
      if (staleSince(g)) return newTracks.forEach((t) => t.stop())
      try {
        const oldScreen = r!.localParticipant.getTrackPublication('screen_share' as Track.Source.ScreenShare)
        if (oldScreen?.track) await r!.localParticipant.unpublishTrack(oldScreen.track)
        const oldAudio = r!.localParticipant.getTrackPublication('screen_share_audio' as Track.Source.ScreenShareAudio)
        if (oldAudio?.track) await r!.localParticipant.unpublishTrack(oldAudio.track)
        for (const t of newTracks) {
          if (staleSince(g)) return newTracks.forEach((x) => x.stop())
          await r!.localParticipant.publishTrack(t, { ...o.publish, source: t.source })
        }
      } catch (e) {
        newTracks.forEach((t) => t.stop()) // never leave a capture running that nothing publishes
        throw e
      }
    }
    if (staleSince(g)) return
    bump()
  } catch (e) {
    if (staleSince(g)) return
    if (!(e instanceof Error && e.name === 'NotAllowedError')) {
      setVoice({ error: `Couldn't change screen share${e instanceof Error ? `: ${e.message}` : '.'}` })
    }
  }
}

/** Explicitly stops an active screen share. */
export async function stopScreenShare() {
  const r = room
  const g = join.now()
  const v = getState().voice
  if ((!r && !cv.active()) || !v.stream) return
  try {
    if (cv.active()) await cv.stopScreen()
    else await r!.localParticipant.setScreenShareEnabled(false)
    if (staleSince(g)) return // the call it was for is gone; the next one has its own state
    setVoice({ stream: false })
    sendState()
  } catch (e) {
    if (staleSince(g)) return
    if (!(e instanceof Error && e.name === 'NotAllowedError')) {
      setVoice({ error: `Couldn't stop screen share${e instanceof Error ? `: ${e.message}` : '.'}` })
    }
  }
  bump()
}

/** Changes the quality of a running screen share without restarting it. */
export async function setStreamQuality(q: StreamQuality) {
  saveVoiceSettings({ stream: q })
  if (cv.active()) return cv.setStreamQuality(q).catch((e) => setVoice({ error: `Couldn't change the stream quality${e instanceof Error ? `: ${e.message}` : '.'}` }))
  const track = room?.localParticipant.getTrackPublication('screen_share' as Track.Source.ScreenShare)?.track as LocalVideoTrack | undefined
  if (!track) return
  const { width, height } = RESOLUTIONS[q.resolution]
  try {
    track.mediaStreamTrack.contentHint = q.mode
    await track.mediaStreamTrack.applyConstraints({ width: { max: width }, height: { max: height }, frameRate: { max: q.fps } })
    if (track.sender) {
      const p = track.sender.getParameters()
      // Scale every simulcast layer by the same factor so the low-quality layer stays small.
      const top = Math.max(...(p.encodings ?? []).map((e) => e.maxBitrate ?? 0))
      const factor = top > 0 ? streamBitrate(q) / top : 1
      p.encodings?.forEach((e) => ((e.maxBitrate = Math.round((e.maxBitrate ?? streamBitrate(q)) * factor)), (e.maxFramerate = q.fps)))
      p.degradationPreference = SCREEN_DEGRADATION
      await track.sender.setParameters(p)
    }
  } catch (e) {
    setVoice({ error: `Couldn't change the stream quality${e instanceof Error ? `: ${e.message}` : '.'}` })
  }
}

type AudioPatch = Partial<Pick<VoiceSettings, 'noiseSuppression' | 'echoCancellation' | 'autoGainControl' | 'bitrate' | 'virtualMicOverride' | 'noiseGate' | 'highPassFilter' | 'voiceCompressor'>>
/**
 * Voice processing / quality settings, applied live to a published mic: capture changes restart the track with new
 * constraints, bitrate goes through the sender's encodings. DTX is negotiated per publication and applies on the next join.
 */
export async function setAudioProcessing(patch: AudioPatch) {
  saveVoiceSettings(patch)
  if (cv.active()) return cv.setAudioProcessing(patch).catch(() => setVoice({ error: "Couldn't apply the audio setting" }))
  const r = room
  const track = r?.localParticipant.getTrackPublication('microphone' as Track.Source.Microphone)?.track
  if (!r || !track) return
  try {
    if (
      'noiseSuppression' in patch ||
      'echoCancellation' in patch ||
      'autoGainControl' in patch ||
      'virtualMicOverride' in patch ||
      'noiseGate' in patch ||
      'highPassFilter' in patch ||
      'voiceCompressor' in patch
    ) await restartMic()
    if ('bitrate' in patch && track.sender) {
      const params = track.sender.getParameters()
      params.encodings = (params.encodings?.length ? params.encodings : [{}]).map((e) => ({ ...e, maxBitrate: voiceSettings().bitrate }))
      await track.sender.setParameters(params)
    }
  } catch {
    setVoice({ error: "Couldn't apply the audio setting" })
  }
}

/** The raw WebRTC stats of our microphone sender (or, when not publishing, of a received audio track). */
export async function statsReport(): Promise<RTCStatsReport | undefined> {
  if (cv.active()) return cv.stats()
  const r = room
  if (!r) return undefined
  const mic = r.localParticipant.getTrackPublication('microphone' as Track.Source.Microphone)?.track
  if (mic) return mic.getRTCStatsReport()
  for (const p of r.remoteParticipants.values())
    for (const pub of p.audioTrackPublications.values()) if (pub.track) return pub.track.getRTCStatsReport()
  return undefined
}

/** getStats() of our screen share sender and of the first screen share we receive, for the encoder/decoder details. */
export async function screenStats(): Promise<{ send?: RTCStatsReport; recv?: RTCStatsReport }> {
  if (cv.active()) return cv.screenStats()
  const r = room
  if (!r) return {}
  const own = r.localParticipant.getTrackPublication('screen_share' as Track.Source.ScreenShare)?.track
  const remote = [...r.remoteParticipants.values()].map((p) => p.getTrackPublication('screen_share' as Track.Source.ScreenShare)?.track).find(Boolean)
  const [send, recv] = await Promise.all([own?.getRTCStatsReport(), remote?.getRTCStatsReport()])
  return { send, recv }
}

const SB_MUTED_KEY = 'cillcord:sbMutedUsers'
const sbMutedUsers = new Set<string>((() => {
  try {
    const raw = localStorage.getItem(SB_MUTED_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
})())

export const isSoundboardMuted = (userId: string) => sbMutedUsers.has(userId)
export function toggleMuteSoundboard(userId: string) {
  if (sbMutedUsers.has(userId)) sbMutedUsers.delete(userId)
  else sbMutedUsers.add(userId)
  try {
    localStorage.setItem(SB_MUTED_KEY, JSON.stringify([...sbMutedUsers]))
  } catch {}
}

/** Plays a soundboard sound locally (VOICE_CHANNEL_EFFECT_SEND or the popover preview). */
export function playSound(soundId: string, volume = 1, url = cdn(`/soundboard-sounds/${soundId}`), userId?: string) {
  if (userId && isSoundboardMuted(userId)) return
  const s = voiceSettings()
  if (s.soundboardVolume <= 0) return
  const effectiveGain = volume * s.soundboardVolume
  const a = new Audio(url)
  a.volume = Math.max(0, Math.min(1, effectiveGain))
  const out = voiceSettings().output
  const sink = (a as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId
  if (out && sink) void sink.call(a, out).catch(() => {})
  void a.play().catch(() => {})
}

// AFK: after the guild's afk_timeout without input or speaking, move ourselves to its AFK channel (CONTRACT-v3 section 1).
let lastActive = Date.now()
const active = () => void (lastActive = Date.now())
for (const ev of ['keydown', 'pointerdown', 'pointermove', 'wheel']) addEventListener(ev, active, { passive: true, capture: true })
setInterval(() => {
  const s = getState()
  const v = s.voice
  if (s.me && v.speaking[s.me.id]) return active()
  const g = v.guildId ? s.guilds[v.guildId] : undefined
  // round 7 (T-R7-1): only from a call that is connected; a failed or waiting join is no call to move
  if (!g?.afk_channel_id || !v.channelId || v.channelId === g.afk_channel_id || !afkMayMove(v.status, !!last)) return
  if (Date.now() - lastActive >= (g.afk_timeout ?? 300) * 1000) {
    active()
    // the server ignores a join it does not allow, and leaving first would drop us from a working call
    const afk = s.channels[g.afk_channel_id]
    if (afk && canJoinVoice(s, g.id, afk)) afkMove(g.id, g.afk_channel_id)
  }
}, 5000)

/** The AFK move is a server move (channel and timeout are the server's): muted on arrival, no permission window. */
function afkMove(guildId: string, channelId: string) {
  mutedByServer('moved')
  teardown()
  intend(guildId, channelId) // its answer is followed; the microphone stays muted
  setVoice({ channelId, status: 'waiting', error: '', video: false, stream: false })
  sendState()
  waitForServer()
}

// Volumes are kept by our user ids; a node room's identities are that node's ids (userOf maps them).
const participantOf = (userId: string) => (room ? [...room.remoteParticipants.values()].find((p) => userOf(p) === userId) : undefined)

export function setUserVolume(userId: string, volume: number) {
  saveVoiceSettings({ volumes: { ...voiceSettings().volumes, [userId]: volume } })
  const p = participantOf(userId)
  if (p) applyVolume(p)
  cv.applyVolumes()
}

export function setStreamVolume(userId: string, volume: number) {
  const s = voiceSettings()
  saveVoiceSettings({
    volumes: { ...s.volumes, [`${userId}-screen`]: volume },
    screenVolumes: { ...(s.screenVolumes ?? {}), [userId]: volume },
  })
  const p = participantOf(userId)
  if (p) applyVolume(p)
  cv.applyVolumes()
}

export function getStreamVolume(userId: string): number {
  const s = voiceSettings()
  return s.screenVolumes?.[userId] ?? s.volumes[`${userId}-screen`] ?? 1
}

/** Recaptures our LiveKit mic with the resolved device and the processing in effect (a noise-removing virtual mic turns ours off). */
async function restartMic() {
  const track = micTrack()
  if (!track) return
  const chId = getState().voice.channelId
  const hifi = Boolean(chId && getState().channels[chId]?.quality_mode === 'hifi')
  await withMic(() => (track as unknown as { restartTrack: (c: MediaTrackConstraints) => Promise<void> }).restartTrack(captureConstraints(voiceSettings(), undefined, hifi)))
  await syncGain() // Updates the DSP chain (Speex/RNNoise/GTCRN, gate, filters)
}

/** Label of the microphone captured right now ('' when none), for Voice & Video. */
export const micLabel = () => (cv.active() ? cv.micLabel() : (micTrack()?.mediaStreamTrack?.label ?? ''))

/** The one place device choices are saved; a mic keeps its label too, to be found again when its id changes. */
export async function setDevice(kind: 'audioinput' | 'audiooutput' | 'videoinput', id: string, label = '') {
  saveVoiceSettings(kind === 'audioinput' ? { input: id, inputLabel: id ? label : '' } : kind === 'audiooutput' ? { output: id } : { camera: id })
  if (kind === 'audioinput') await restartMic().catch((e) => setVoice({ error: `Device error: ${e instanceof Error ? e.message : e}` }))
  else await room?.switchActiveDevice(kind, id || 'default').catch(() => {})
  await cv.setDevice(kind).catch((e) => setVoice({ error: `Device error: ${e instanceof Error ? e.message : e}` }))
}

export const setInputMode = (mode: 'vad' | 'ptt', pttKey?: string) => {
  saveVoiceSettings({ mode, ...(pttKey && { pttKey }) })
  void syncMic()
}

export type { VideoTrackLike } from './cillvoice'
export type Tile = { userId: string; source: 'camera' | 'screen'; track: cv.VideoTrackLike }
/** Video tracks currently available (own and subscribed), for the participant grid. */
export function videoTiles(): Tile[] {
  if (cv.active()) return cv.tiles(getState().me?.id ?? '')
  const r = room
  if (!r) return []
  const out: Tile[] = []
  for (const p of [r.localParticipant, ...r.remoteParticipants.values()])
    for (const pub of p.videoTrackPublications.values())
      if (pub.track && !pub.isMuted && userOf(p)) out.push({ userId: userOf(p)!, source: pub.source === 'screen_share' ? 'screen' : 'camera', track: pub.track })
  return out
}

// Push-to-talk works while the tab has focus.
addEventListener('keydown', (e) => {
  if (e.repeat || pttDown || voiceSettings().mode !== 'ptt' || e.code !== voiceSettings().pttKey) return
  pttDown = true
  void syncMic()
})
addEventListener('keyup', (e) => {
  if (!pttDown || e.code !== voiceSettings().pttKey) return
  pttDown = false
  void syncMic()
})
addEventListener('blur', () => {
  if (pttDown) (pttDown = false), void syncMic()
})

/** Mutes us after the server changed our call (a move, a stage promotion): the user unmutes when ready. */
function mutedByServer(why: 'moved' | 'invited') {
  if (!getState().voice.selfMute) setSelfMute(true)
  toast(why === 'moved'
    ? t('You were moved to another voice channel. Your microphone is muted; unmute when you are ready.')
    : t('You were invited to speak. Your microphone is muted; unmute when you are ready.'))
}

/** Gateway hook: called after the store applied each dispatch; `from` = the node it came from (undefined: the primary
 *  server's connection). Round 7: every event about our call counts only from the connection the call is on; a hub event
 *  never touches a node call, nor a node event a hub call. */
export function voiceEvent(t: string, d: any, from?: string) {
  const s = getState()
  const v = s.voice
  if (t === 'LOGOUT') return void (endCall(), setVoice(idleVoice)) // client-internal (gateway.ts logout)
  if (!v.channelId || from !== nodeOf(v.guildId)) return
  const idle = () => (endCall(), setVoice({ ...idleVoice, selfMute: v.selfMute, selfDeaf: v.selfDeaf }))
  switch (t) {
    case 'READY': {
      // A new gateway session lost our voice state on the server. READY never makes a join: only a call that was
      // connected when the connection dropped comes back (same channel, same media host, microphone as it was); a join
      // the user started just now is asked again; anything else (waiting, failed, not configured) ends here.
      const snap = dropped !== undefined ? dropped : restorable()
      dropped = undefined
      const exists = v.guildId ? s.guilds[v.guildId] : s.channels[v.channelId]
      const verdict = exists ? readyVerdict(v, snap, intent, Date.now()) : 'end'
      if (verdict === 'end') return idle()
      if (verdict === 'rejoin') {
        intend(v.guildId, v.channelId)
        rejoinHost = snap!.host
        setVoice({ status: 'waiting', error: '', video: false, stream: false }) // camera and screen never come back by themselves
      }
      sendState()
      return waitForServer()
    }
    case 'VOICE_SERVER_UPDATE': {
      const established = !!last && v.status !== 'error' && v.status !== 'idle' && v.status !== 'unconfigured'
      if (!serverUpdateAllowed(d, intent, { guildId: v.guildId, channelId: v.channelId, established }, Date.now())) return void console.warn('voice: ignored a VOICE_SERVER_UPDATE for a call not started here')
      if (!d.endpoint) return void (teardown(), setVoice({ status: 'unconfigured', error: 'Voice is not configured on this server' }))
      const url = mediaUrl(d.endpoint, from ? (instanceById(from)?.url ?? '') : apiOrigin())
      const host = rejoinHost
      rejoinHost = null
      if (!url || typeof d.token !== 'string' || (host && mediaHost(url) !== host)) {
        console.warn('voice: ignored a VOICE_SERVER_UPDATE naming a media server that is not this server\'s (or not the one of the call)')
        // a call already running stays as it is; a join waiting for this answer fails
        if (!established) (intent = null), setVoice({ status: 'error', error: 'The server named a voice server that is not its own.' })
        return
      }
      return void connectRoom(url, d.token)
    }
    case 'VOICE_STATE_UPDATE': {
      if (d.user_id !== s.me?.id) return
      // Joined elsewhere on the same server (hub or one node); a voice state from another node never ends this call.
      if (nodeOf(d.guild_id) !== nodeOf(v.guildId)) return
      if (d.channel_id && d.session_id !== s.sessionId) return idle()
      if ((d.guild_id ?? null) !== v.guildId) return
      if (ringOnJoin && d.channel_id === ringOnJoin) (api(`/channels/${ringOnJoin}/call/ring`, { method: 'POST', body: { recipients: null } }).catch(() => {}), (ringOnJoin = null))
      if (!d.channel_id) return idle() // disconnected by someone or something
      if (d.channel_id !== v.channelId) {
        // moved by a moderator; a fresh VOICE_SERVER_UPDATE follows. Never a DM call, never to another server.
        const verdict = moveVerdict(v.guildId, d, s.channels[d.channel_id], intent, Date.now())
        if (verdict === 'ignore') return
        setVoice({ channelId: d.channel_id })
        // muted after the channel changed: the mute's voice state must name the new channel, or it moves us back
        if (verdict === 'moved') mutedByServer('moved')
      }
      return void syncMic() // the server may take the microphone away; giving it back asks the user (gate)
    }
    // what the server lets us do in the call changed (roles, member mute, channel overwrites or type): checked again
    case 'GUILD_MEMBER_UPDATE': case 'GUILD_ROLE_UPDATE': case 'GUILD_ROLE_DELETE': case 'CHANNEL_UPDATE': case 'GUILD_CREATE': case 'GUILD_UPDATE':
      return void ((d?.guild_id ?? d?.id) === v.guildId && syncMic())
    case 'VOICE_CHANNEL_EFFECT_SEND': {
      if (d.channel_id !== v.channelId) return
      // v6: `entrance: true` is someone's entrance sound (a soundboard sound or their own upload at `sound_url`); it replaces the join chime
      if (d.entrance) entranceHeard.set(d.user_id, Date.now())
      // round 7: a sound loads only from the connection's own host (a node's are on its origin already)
      const url = d.sound_url ? cdn(d.sound_url) : undefined
      if (d.sound_id && !deafened() && !(d.entrance && s.settings.sound_settings?.muted) && soundAllowed(url, from ? (instanceById(from)?.url ?? '') : apiOrigin()))
        playSound(String(d.sound_id), d.sound_volume ?? 1, url, d.user_id)
      setVoice({ effects: { ...v.effects, [d.user_id]: d.emoji?.name ?? '🔊' } })
      setTimeout(() => {
        const { [d.user_id]: _, ...rest } = getState().voice.effects
        setVoice({ effects: rest })
      }, 3000)
      return
    }
    case 'CILLVOICE_ANSWER': case 'CILLVOICE_TRACKS': case 'CILLVOICE_SPEAKING': case 'CILLVOICE_ERROR':
      if (d?.channel_id != null && d.channel_id !== v.channelId) return
      return cv.event(t, d)
    case 'CHANNEL_DELETE':
      if (d.id === v.channelId) idle()
      return
    case 'GUILD_DELETE':
      if (d.id === v.guildId) idle()
      return
  }
}
