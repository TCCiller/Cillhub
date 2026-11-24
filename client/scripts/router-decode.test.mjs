// Safe URI component decoding for address segments and fragments (src/routerDecode.ts, src/App.tsx, src/legal/LegalPages.tsx).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import module from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { decodePart } from '../src/routerDecode.ts'

test('decodePart returns the decoded string for valid input and the raw input for malformed percent sequences', () => {
  assert.equal(decodePart('abc-123'), 'abc-123')
  assert.equal(decodePart('hello%20world'), 'hello world')
  assert.equal(decodePart('%C3%A4%C3%B6%C3%BC'), 'äöü')
  assert.equal(decodePart('code%2Fslash'), 'code/slash')
  assert.equal(decodePart(''), '')

  for (const malformed of ['%', '%2', '%GG', '%E0%A4%A', 'invite%', 'abc%E0%A4%AZ']) {
    assert.equal(decodePart(malformed), malformed, malformed)
  }
})

test('invite and template routes render without throwing on malformed percent sequences', async () => {
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
    pathname: '/invite/%',
    search: '',
    hash: '',
    href: 'https://chat.example/invite/%',
  }
  globalThis.history = {
    pushState: (_s, _t, to) => { globalThis.location.pathname = String(to) },
    replaceState: (_s, _t, to) => { globalThis.location.pathname = String(to) },
  }
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
  globalThis.setInterval = (...args) => origSetInterval(...args).unref()

  const hooks = module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.endsWith('?url')) {
        return { url: 'data:text/javascript,export default ""', shortCircuit: true }
      }
      if (specifier === 'livekit-client') {
        return { url: 'data:text/javascript,export class Room {} export const RoomEvent = {}, Track = {}, VideoPresets = {}, ConnectionQuality = {}, DisconnectReason = {}', shortCircuit: true }
      }
      if (specifier === './components/Shell' && context.parentURL?.endsWith('/client/src/App.tsx')) {
        return { url: 'data:text/javascript,export const Shell = () => null', shortCircuit: true }
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
      if (url.endsWith('.css')) {
        return { format: 'module', shortCircuit: true, source: 'export default {}' }
      }
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
        const patched = outputText.replace(
          /\buseSyncExternalStore\(/g,
          '((s, g, ssr = g) => useSyncExternalStore(s, g, ssr))(',
        )
        return { format: 'module', shortCircuit: true, source: patched }
      }
      return nextLoad(url, context)
    },
  })

  try {
    const { App } = await import('../src/App.tsx')
    for (const badCode of ['%', '%2', '%GG', '%E0%A4%A']) {
      globalThis.location.pathname = `/invite/${badCode}`
      const html = renderToStaticMarkup(createElement(App))
      assert.match(html, /Loading invite…/)
    }

    globalThis.location.pathname = '/template/%E0%A4%A'
    assert.doesNotThrow(() => renderToStaticMarkup(createElement(App)))
    assert.equal(globalThis.sessionStorage.getItem('template-code'), '%E0%A4%A')
  } finally {
    hooks.deregister()
    globalThis.setInterval = origSetInterval
  }
})
