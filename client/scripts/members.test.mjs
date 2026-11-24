// Member list merging and direct own-member loading (src/members.ts, src/actions.ts, src/components/Shell.tsx).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import module from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { ensureOwnMembers, withMembers } from '../src/members.ts'

const member = (id, nick = null, roles = []) => ({
  user: { id, username: `u${id}` },
  nick,
  roles,
  joined_at: '2026-01-01T00:00:00.000Z',
})

test('withMembers keeps own and gateway-learned members, updates fetched rows, and leaves other guilds untouched', () => {
  const existing = {
    '1': {
      '999': member('999', 'me', ['mod']),
      '777': member('777', 'gw-user', ['r2']),
      '10': member('10', 'old-nick', ['r1']),
    },
    '2': {
      '20': member('20', 'other-guild', ['r9']),
    },
  }
  const page = [
    member('10', 'new-nick', ['r1', 'r3']),
    member('11', 'page-user', []),
  ]
  const next = withMembers(existing, '1', page)

  assert.deepEqual(next['1']['999'], existing['1']['999'], 'own member stays in map')
  assert.deepEqual(next['1']['777'], existing['1']['777'], 'gateway-learned member stays in map')
  assert.equal(next['1']['10'].nick, 'new-nick', 'fetched row replaces older copy')
  assert.deepEqual(next['1']['10'].roles, ['r1', 'r3'])
  assert.equal(next['1']['11'].nick, 'page-user')
  assert.strictEqual(next['2'], existing['2'], 'other guild members are untouched')
})

test('loadMembers merges into the store and own-member fetch populates myMember even when the member page omits us', async () => {
  const storage = () => {
    const map = new Map()
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
      clear: () => map.clear(),
    }
  }
  globalThis.localStorage = storage()
  globalThis.sessionStorage = storage()
  globalThis.location = {
    origin: 'https://chat.example',
    protocol: 'https:',
    host: 'chat.example',
    hostname: 'chat.example',
    port: '',
    pathname: '/',
    search: '',
    hash: '',
    href: 'https://chat.example/',
  }
  globalThis.history = { pushState() {}, replaceState() {} }
  globalThis.document = {
    compatMode: 'CSS1Compat',
    documentElement: { lang: 'en', dataset: {}, style: { setProperty() {} } },
    title: '',
    querySelector() { return null },
    addEventListener() {},
    removeEventListener() {},
  }
  globalThis.addEventListener = () => {}
  globalThis.removeEventListener = () => {}
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  globalThis.window = globalThis

  const origSetInterval = globalThis.setInterval
  const origFetch = globalThis.fetch
  globalThis.setInterval = (...args) => origSetInterval(...args).unref()

  const requests = []
  let failMeOnce = true
  let pageNick = 'old-first'
  const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
  globalThis.fetch = async (url) => {
    const u = String(url)
    requests.push(u)
    if (u.endsWith('/api/v9/guilds/1/members?limit=1000')) {
      return jsonResponse([member('10', pageNick, ['r1'])])
    }
    if (u.endsWith('/api/v9/guilds/1/members/@me')) {
      if (failMeOnce) {
        failMeOnce = false
        return jsonResponse({ message: 'temporary' }, 503)
      }
      return jsonResponse(member('999', 'latecomer', ['mod']))
    }
    if (u === 'https://node.example/api/v9/guilds/100/members/@me') {
      return jsonResponse(member('555', 'node-me', ['77']))
    }
    return jsonResponse({ message: 'unexpected ' + u }, 404)
  }

  const hooks = module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.endsWith('?url')) {
        return { url: 'data:text/javascript,export default ""', shortCircuit: true }
      }
      if (specifier === 'livekit-client') {
        return { url: 'data:text/javascript,export class Room {} export const RoomEvent = {}, Track = {}, VideoPresets = {}, ConnectionQuality = {}, DisconnectReason = {}', shortCircuit: true }
      }
      if (specifier.startsWith('.') && context.parentURL?.includes('/client/src/')) {
        const base = fileURLToPath(new URL(specifier, context.parentURL))
        for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return { url: pathToFileURL(candidate).href, shortCircuit: true }
          }
        }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default {}' }
      if (url.includes('/client/src/') && url.endsWith('.json')) {
        return { format: 'module', shortCircuit: true, source: `export default ${fs.readFileSync(fileURLToPath(url), 'utf8')}` }
      }
      if (url.includes('/client/src/') && (url.endsWith('.tsx') || url.endsWith('.ts'))) {
        const filePath = fileURLToPath(url)
        const raw = fs.readFileSync(filePath, 'utf8').replace(/\bimport\.meta\.env\b/g, '({})')
        const { outputText } = ts.transpileModule(raw, {
          fileName: filePath,
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
            jsx: ts.JsxEmit.ReactJSX,
          },
        })
        return { format: 'module', shortCircuit: true, source: outputText }
      }
      return nextLoad(url, context)
    },
  })

  try {
    const actions = await import('../src/actions.ts')
    const { apply, getState, setState } = await import('../src/store.ts')
    const { myMember } = await import('../src/selectors.ts')
    const { setView, testNode } = await import('../src/instances/registry.ts')

    assert.equal(typeof actions.loadMyMember, 'function', 'loadMyMember must be exported from actions.ts')

    setState({
      status: 'ready',
      me: { id: '999', username: 'latecomer' },
      users: { '999': { id: '999', username: 'latecomer' } },
      guilds: {
        '1': { id: '1', name: 'Big', owner_id: '10', roles: [] },
        '2': { id: '2', name: 'Other', owner_id: '20', roles: [] },
      },
      members: { '2': { '20': member('20', 'other-guild', []) } },
      membersLoaded: {},
    })

    // 1. Member list page loads first and does NOT include our late-joining user 999.
    await actions.loadMembers('1')
    assert.equal(getState().membersLoaded['1'], true)
    assert.equal(myMember(getState(), '1'), undefined)

    // 2. Own-member path still requests /guilds/1/members/@me even with membersLoaded['1'] === true,
    //    retries after a failure, and populates myMember in the store.
    const requested = new Set()
    ensureOwnMembers(getState(), requested, actions.loadMyMember)
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(requested.has('1'), false, 'failed request clears requested so it can retry')
    assert.equal(myMember(getState(), '1'), undefined)

    ensureOwnMembers(getState(), requested, actions.loadMyMember)
    await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(myMember(getState(), '1')?.roles, ['mod'])
    assert.equal(myMember(getState(), '1')?.nick, 'latecomer')

    // 3. A gateway event adds another member, then loadMembers runs again without either 999 or 777:
    //    both must survive, existing row 10 must update, and guild 2 must stay untouched.
    apply('GUILD_MEMBER_ADD', { guild_id: '1', ...member('777', 'gw-user', ['r2']) })
    pageNick = 'updated-first'
    await actions.loadMembers('1')
    const m1 = getState().members['1']
    assert.equal(m1['999']?.nick, 'latecomer', 'loadMembers must not drop own member')
    assert.equal(m1['777']?.nick, 'gw-user', 'loadMembers must not drop gateway-learned member')
    assert.equal(m1['10']?.nick, 'updated-first', 'loadMembers must update existing row from fetched page')
    assert.equal(getState().members['2']?.['20']?.nick, 'other-guild', 'other guilds must stay untouched')

    // 4. Linked node guild routes GET /guilds/5~100/members/@me to the node and aliases our user id back to hub me.id.
    testNode('5', 'https://node.example', '555', '999')
    setView({
      user: (id) => getState().users[id],
      channel: () => undefined,
      interaction: () => undefined,
      consume: () => {},
      voiceGuild: () => null,
    })
    await actions.loadMyMember('5~100')
    assert.ok(requests.includes('https://node.example/api/v9/guilds/100/members/@me'))
    assert.deepEqual(myMember(getState(), '5~100')?.roles, ['5~77'])
    assert.equal(myMember(getState(), '5~100')?.user.id, '999')
  } finally {
    hooks.deregister()
    globalThis.setInterval = origSetInterval
    globalThis.fetch = origFetch
  }
})
