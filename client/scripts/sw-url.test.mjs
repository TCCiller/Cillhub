import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
const cases = [
  ['//evil.example/a', '/channels/@me'],
  ['/\\evil.example', '/channels/@me'],
  ['https://evil.example', '/channels/@me'],
  ['/channels/1/2', '/channels/1/2'],
  [undefined, '/channels/@me'],
  [123, '/channels/@me'],
]
function worker(existingWindow = false) {
  const handlers = {}, notifications = [], navigations = []
  const win = {
    url: 'https://chat.example/channels/@me',
    focus: async () => win,
    postMessage: message => navigations.push(message.url),
  }
  runInNewContext(source, {
    URL, location: { origin: 'https://chat.example' },
    self: {
      addEventListener: (name, fn) => { handlers[name] = fn },
      registration: { showNotification: async (title, options) => notifications.push({ title, options }) },
      clients: {
        matchAll: async () => existingWindow ? [win] : [],
        openWindow: async url => navigations.push(url),
      },
    },
  })
  const fire = async (name, event) => {
    let pending
    handlers[name]({ ...event, waitUntil: promise => { pending = promise } })
    await pending
  }
  return { fire, notifications, navigations }
}
test('push stores only permitted notification paths and preserves title, body and tag', async () => {
  for (const [url, expected] of cases) {
    const w = worker()
    await w.fire('push', { data: { json: () => ({ url, title: 'Title', body: 'Body', tag: 'Tag' }) } })
    const { title, options } = w.notifications[0]
    assert.equal(options.data.url, expected)
    assert.equal(title, 'Title')
    assert.equal(options.body, 'Body')
    assert.equal(options.tag, 'Tag')
    assert.equal(options.renotify, true)
  }
})
for (const existing of [false, true]) {
  test(`notificationclick validates old notification data before ${existing ? 'posting navigation' : 'opening a window'}`, async () => {
    for (const [url, expected] of cases) {
      const w = worker(existing)
      let closed = false
      await w.fire('notificationclick', { notification: { data: { url }, close: () => { closed = true } } })
      assert.equal(closed, true)
      assert.deepEqual(w.navigations, [expected])
    }
  })
}
