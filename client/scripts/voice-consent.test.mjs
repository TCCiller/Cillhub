// Which VOICE_SERVER_UPDATEs and moves the client follows (src/voice/consent.ts, secloop round 6 C-R6-1). Run: npm test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { afkMayMove, intentFor, mediaHost, mediaUrl, moveVerdict, readyVerdict, serverUpdateAllowed, soundAllowed, speakGate, INTENT_MS } from '../src/voice/consent.ts'

const NOW = 1_000_000
const idle = { guildId: null, channelId: null, established: false }
const waiting = (guildId, channelId) => ({ guildId, channelId, established: false })
const inCall = (guildId, channelId) => ({ guildId, channelId, established: true })

test('legitimate answers are followed', () => {
  // join a guild channel: op 4 → answer for that guild and channel
  assert.ok(serverUpdateAllowed({ guild_id: 'g', channel_id: 'v1' }, intentFor('g', 'v1', NOW), waiting('g', 'v1'), NOW + 300))
  // accept a DM call / start one: guild null
  assert.ok(serverUpdateAllowed({ guild_id: null, channel_id: 'dm' }, intentFor(null, 'dm', NOW), waiting(null, 'dm'), NOW + 300))
  assert.ok(serverUpdateAllowed({ channel_id: 'dm' }, intentFor(null, 'dm', NOW), waiting(null, 'dm'), NOW + 300)) // guild_id left out
  // "voice is not configured" answer (endpoint null) for the asked channel
  assert.ok(serverUpdateAllowed({ guild_id: null, channel_id: 'dm', endpoint: null }, intentFor(null, 'dm', NOW), waiting(null, 'dm'), NOW))
  // gateway reconnect (READY → op 4 again for the call we are in): READY records a fresh intent
  assert.ok(serverUpdateAllowed({ guild_id: 'g', channel_id: 'v1' }, intentFor('g', 'v1', NOW), inCall('g', 'v1'), NOW + 1000))
  // a moderator moved us (our voice state already named v2, so the call's channel is v2): answer for v2
  assert.ok(serverUpdateAllowed({ guild_id: 'g', channel_id: 'v2' }, null, inCall('g', 'v2'), NOW))
  // switching channels ourselves while in a call (joinVoice: new intent)
  assert.ok(serverUpdateAllowed({ guild_id: 'g', channel_id: 'v3' }, intentFor('g', 'v3', NOW), waiting('g', 'v3'), NOW))
})

test('unsolicited answers are ignored', () => {
  // idle, never joined: null guild + a DM channel (the C-R6-1 attack), or a guild the user is in
  assert.ok(!serverUpdateAllowed({ guild_id: null, channel_id: 'dm' }, null, idle, NOW))
  assert.ok(!serverUpdateAllowed({ guild_id: 'g', channel_id: 'v1' }, null, idle, NOW))
  // after a call ended (leave/teardown cleared the intent; the call is idle again)
  assert.ok(!serverUpdateAllowed({ guild_id: null, channel_id: 'dm' }, null, idle, NOW))
  // while waiting for another channel, same guild, other guild, or a DM
  const i = intentFor('g', 'v1', NOW)
  assert.ok(!serverUpdateAllowed({ guild_id: 'g', channel_id: 'v2' }, i, waiting('g', 'v1'), NOW))
  assert.ok(!serverUpdateAllowed({ guild_id: 'h', channel_id: 'v1' }, i, waiting('g', 'v1'), NOW))
  assert.ok(!serverUpdateAllowed({ guild_id: null, channel_id: 'v1' }, i, waiting('g', 'v1'), NOW))
  // an intent too old to count
  assert.ok(!serverUpdateAllowed({ guild_id: 'g', channel_id: 'v1' }, i, waiting('g', 'v1'), NOW + INTENT_MS + 1))
  // in a call: an answer for another channel or another guild (a move comes with our voice state first)
  assert.ok(!serverUpdateAllowed({ guild_id: 'g', channel_id: 'v9' }, null, inCall('g', 'v1'), NOW))
  assert.ok(!serverUpdateAllowed({ guild_id: null, channel_id: 'dm2' }, null, inCall(null, 'dm'), NOW))
  // a call that failed or was left is not established
  assert.ok(!serverUpdateAllowed({ guild_id: 'g', channel_id: 'v1' }, null, waiting('g', 'v1'), NOW))
  // wrong types
  assert.ok(!serverUpdateAllowed({ guild_id: 'g' }, i, waiting('g', 'v1'), NOW))
  assert.ok(!serverUpdateAllowed({ guild_id: 5, channel_id: 'v1' }, i, waiting('g', 'v1'), NOW))
})

test('moves: only a guild voice channel of the same server, and mute unless we chose it', () => {
  const voice = { guild_id: 'g', type: 2 }
  assert.equal(moveVerdict('g', { channel_id: 'v2' }, voice, null, NOW), 'moved')
  assert.equal(moveVerdict('g', { channel_id: 'v2' }, { guild_id: 'g', type: 13 }, null, NOW), 'moved')
  assert.equal(moveVerdict('g', { channel_id: 'v2' }, voice, intentFor('g', 'v2', NOW), NOW), 'own')
  assert.equal(moveVerdict('g', { channel_id: 'v2' }, voice, intentFor('g', 'v3', NOW), NOW), 'moved')
  assert.equal(moveVerdict(null, { channel_id: 'dm2' }, { guild_id: null, type: 1 }, null, NOW), 'ignore') // DM calls never move
  assert.equal(moveVerdict('g', { channel_id: 'x' }, { guild_id: 'h', type: 2 }, null, NOW), 'ignore') // another server
  assert.equal(moveVerdict('g', { channel_id: 'x' }, { guild_id: 'g', type: 0 }, null, NOW), 'ignore') // a text channel
  assert.equal(moveVerdict('g', { channel_id: 'x' }, undefined, null, NOW), 'ignore') // unknown
})

test('media endpoints: cillvoice or the connection\'s own host', () => {
  const hub = 'https://hub.example'
  assert.equal(mediaUrl('cillvoice', hub), 'cillvoice')
  assert.equal(mediaUrl('wss://hub.example/livekit', hub), 'wss://hub.example/livekit')
  assert.equal(mediaUrl('https://hub.example/livekit', hub), 'wss://hub.example/livekit')
  assert.equal(mediaUrl('wss://hub.example:7880', hub), 'wss://hub.example:7880') // LiveKit's own port on that host
  assert.equal(mediaUrl('/livekit', hub), 'wss://hub.example/livekit')
  assert.equal(mediaUrl('hub.example/livekit', hub), 'wss://hub.example/livekit')
  assert.equal(mediaUrl('ws://127.0.0.1:7880', 'http://127.0.0.1:3988'), 'ws://127.0.0.1:7880') // local test server
  for (const bad of ['wss://attacker.example', 'wss://hub.example.attacker.example/', 'wss://attacker.example/hub.example', 'ws://hub.example/livekit',
    'wss://user:pw@hub.example/', '//attacker.example/x', 'attacker.example', 'javascript:alert(1)', '', null, 5, undefined])
    assert.equal(mediaUrl(bad, hub), null, String(bad))
  // a node's event may only name that node's host
  assert.equal(mediaUrl('https://node.example/livekit', 'https://node.example'), 'wss://node.example/livekit')
  assert.equal(mediaUrl('wss://hub.example/livekit', 'https://node.example'), null)
  assert.equal(mediaUrl('wss://x', ''), null) // no known origin
})

// ---------- round 7 ----------
test('READY never makes a join: only a call connected when the gateway dropped comes back (A-R7-3b, C-R7-1)', () => {
  const was = { guildId: 'g', channelId: 'v1', host: 'chat.example:7880', mic: true }
  // reconnect of a live call: same channel → rejoin
  assert.equal(readyVerdict({ guildId: 'g', channelId: 'v1', status: 'error' }, was, null, NOW), 'rejoin')
  assert.equal(readyVerdict({ guildId: 'g', channelId: 'v1', status: 'connected' }, was, null, NOW), 'rejoin')
  // a failed, timed-out or "not configured" join left in the panel: ends (no intent, no window)
  for (const status of ['error', 'unconfigured', 'waiting', 'connecting']) assert.equal(readyVerdict({ guildId: 'g', channelId: 'v1', status }, null, null, NOW), 'end')
  // an old intent does not count; a stage listener's channel that was not connected neither
  assert.equal(readyVerdict({ guildId: 'g', channelId: 'v1', status: 'waiting' }, null, intentFor('g', 'v1', NOW - INTENT_MS - 1), NOW), 'end')
  // the snapshot is of another channel (the user switched while offline, or the server moved the record)
  assert.equal(readyVerdict({ guildId: 'g', channelId: 'v2', status: 'error' }, was, null, NOW), 'end')
  assert.equal(readyVerdict({ guildId: 'h', channelId: 'v1', status: 'error' }, was, null, NOW), 'end')
  assert.equal(readyVerdict({ guildId: null, channelId: 'v1', status: 'error' }, was, null, NOW), 'end')
  // a join the user started a moment ago is asked again with its own intent
  assert.equal(readyVerdict({ guildId: 'g', channelId: 'v1', status: 'waiting' }, null, intentFor('g', 'v1', NOW), NOW + 100), 'again')
  assert.equal(readyVerdict({ guildId: 'g', channelId: 'v1', status: 'error' }, null, intentFor('g', 'v1', NOW), NOW + 100), 'end')
})

test('the media host of a rejoin must stay the same', () => {
  assert.equal(mediaHost('wss://Chat.Example:7880/rtc'), 'chat.example:7880')
  assert.equal(mediaHost('cillvoice'), 'cillvoice')
  assert.notEqual(mediaHost('wss://chat.example:7881'), mediaHost('wss://chat.example:7880'))
  assert.equal(mediaHost('not a url'), '')
})

test('speaking given back by a server never opens the microphone (A-R7-3a, A-R7-5)', () => {
  const free = { held: false, prompted: false }
  // allowed from the start of a join (the user's own join): nothing held
  assert.deepEqual(speakGate(free, true, 0, NOW), { held: false, prompted: false, prompt: false })
  // stage audience / no SPEAK / server-muted: held
  const held = speakGate(free, false, 0, NOW)
  assert.deepEqual(held, { held: true, prompted: false, prompt: false })
  // invited, SPEAK granted, server mute lifted, suppress:false in READY: prompt once, stay held
  const given = speakGate(held, true, 0, NOW)
  assert.deepEqual(given, { held: true, prompted: true, prompt: true })
  assert.deepEqual(speakGate(given, true, 0, NOW + 1), { held: true, prompted: true, prompt: false })
  // the user asked to speak in the last seconds ("Become a Speaker", starting a stage): not held
  assert.deepEqual(speakGate(held, true, NOW + 10_000, NOW), { held: false, prompted: false, prompt: false })
  // taken away again and given back again: asked again
  const again = speakGate(speakGate(given, false, 0, NOW + 2), true, 0, NOW + 3)
  assert.equal(again.prompt, true)
})

test('the AFK move only moves a connected call (T-R7-1)', () => {
  assert.ok(afkMayMove('connected', true))
  for (const s of ['error', 'unconfigured', 'waiting', 'connecting', 'idle']) assert.ok(!afkMayMove(s, true))
  assert.ok(!afkMayMove('connected', false))
})

test('sounds named by a server load only from that connection (info, red team row 61)', () => {
  assert.ok(soundAllowed(undefined, 'https://chat.example'))
  assert.ok(soundAllowed('https://chat.example/user-sounds/1', 'https://chat.example'))
  assert.ok(!soundAllowed('https://other.example/a.ogg', 'https://chat.example'))
  assert.ok(!soundAllowed('http://chat.example/a.ogg', 'https://chat.example'))
  assert.ok(!soundAllowed('https://chat.example:8443/a.ogg', 'https://chat.example'))
  assert.ok(!soundAllowed('https://chat.example/a.ogg', ''))
})
