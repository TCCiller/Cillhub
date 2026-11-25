// Partner MESSAGE_ACK events from older servers must not overwrite our own DM read state (src/store.ts).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import module from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

test('MESSAGE_ACK from another user updates dmRecipientReads only and leaves own readStates untouched', async () => {
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
    const { apply, getState, setState } = await import('../src/store.ts')

    setState({
      status: 'ready',
      me: { id: 'u1', username: 'alice' },
      channels: {
        dm1: { id: 'dm1', type: 1, last_message_id: '500', recipients: [{ id: 'u2', username: 'bob' }] },
      },
      readStates: {
        dm1: { id: 'dm1', last_message_id: '400', mention_count: 3 },
      },
      dmRecipientReads: {},
    })

    // 1. Partner's MESSAGE_ACK (older server): records partner read, does NOT touch own readStates
    apply('MESSAGE_ACK', { channel_id: 'dm1', message_id: '500', user_id: 'u2' })
    assert.deepEqual(
      getState().readStates.dm1,
      { id: 'dm1', last_message_id: '400', mention_count: 3 },
      'partner MESSAGE_ACK must leave own read state and mention_count unchanged',
    )
    assert.equal(getState().dmRecipientReads.dm1?.u2, '500', 'partner read is recorded in dmRecipientReads')

    // 2. When own id is unknown (me: null), a MESSAGE_ACK naming a user is not treated as our own
    setState({ me: null })
    apply('MESSAGE_ACK', { channel_id: 'dm1', message_id: '500', user_id: 'u3' })
    assert.deepEqual(
      getState().readStates.dm1,
      { id: 'dm1', last_message_id: '400', mention_count: 3 },
      'MESSAGE_ACK with user_id while me is null must not overwrite readStates',
    )
    assert.equal(getState().dmRecipientReads.dm1?.u3, '500')

    // 3. MESSAGE_ACK with our own user_id updates own read state and clears mention_count
    setState({ me: { id: 'u1', username: 'alice' } })
    apply('MESSAGE_ACK', { channel_id: 'dm1', message_id: '450', user_id: 'u1' })
    assert.deepEqual(
      getState().readStates.dm1,
      { id: 'dm1', last_message_id: '450', mention_count: 0 },
      'own user_id MESSAGE_ACK updates own read state and clears mentions',
    )

    // 4. MESSAGE_ACK without user_id updates own read state and clears mention_count
    setState({ readStates: { dm1: { id: 'dm1', last_message_id: '450', mention_count: 2 } } })
    apply('MESSAGE_ACK', { channel_id: 'dm1', message_id: '500' })
    assert.deepEqual(
      getState().readStates.dm1,
      { id: 'dm1', last_message_id: '500', mention_count: 0 },
      'MESSAGE_ACK without user_id updates own read state and clears mentions',
    )
  } finally {
    hooks.deregister()
  }
})
