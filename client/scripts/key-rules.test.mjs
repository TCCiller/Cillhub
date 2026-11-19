// Keys while typing, capture keybinds and the incoming-call shortcut (src/keyboard/keyrules.ts, secloop round 7
// A-R7-1, A-R7-2). Run: npm test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptKey, bindable, CAPTURE_ACTIONS, firesWhileTyping, strongCombo } from '../src/keyboard/keyrules.ts'

const key = (code, mods = {}) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, code, ...mods })

test('capture actions never take a key that types text (A-R7-2)', () => {
  for (const a of ['toggle-mute', 'toggle-deafen', 'toggle-camera', 'toggle-screen']) assert.ok(CAPTURE_ACTIONS.includes(a))
  for (const weak of ['KeyE', 'Space', 'Shift+KeyE', 'Shift+Space', 'Digit1', 'Enter', 'Backquote', 'Escape', 'Numpad5']) {
    assert.ok(!strongCombo(weak), weak)
    for (const a of CAPTURE_ACTIONS) assert.ok(!bindable(a, weak), `${a} ${weak}`)
  }
  for (const strong of ['Ctrl+Shift+KeyM', 'Alt+KeyE', 'Ctrl+KeyC', 'F9', 'Shift+F12', 'Pause', 'Insert', 'MediaPlayPause'])
    for (const a of CAPTURE_ACTIONS) assert.ok(bindable(a, strong), `${a} ${strong}`)
  // other actions keep any key; an unbound capture action is fine
  assert.ok(bindable('prev-channel', 'KeyJ'))
  assert.ok(bindable('toggle-camera', ''))
})

test('no key that types text runs a keybind while typing (A-R7-2)', () => {
  assert.ok(!firesWhileTyping(key('KeyE'), true))
  assert.ok(!firesWhileTyping(key('Space'), true))
  assert.ok(!firesWhileTyping(key('KeyE', { shiftKey: true }), true))
  assert.ok(firesWhileTyping(key('KeyE', { ctrlKey: true }), true))
  assert.ok(firesWhileTyping(key('KeyE', { metaKey: true }), true))
  assert.ok(firesWhileTyping(key('ArrowUp', { altKey: true }), true))
  assert.ok(firesWhileTyping(key('Escape'), true)) // mark as read keeps working from the composer
  assert.ok(firesWhileTyping(key('F9'), true))
  assert.ok(firesWhileTyping(key('KeyE'), false)) // outside a text field a bare key may run its action
})

test('an incoming call is accepted only by the dedicated key, not while typing, not in its first second (A-R7-1)', () => {
  const ca = key('KeyA', { ctrlKey: true, altKey: true })
  assert.ok(acceptKey(ca, 1500, false))
  assert.ok(acceptKey(key('KeyA', { metaKey: true, altKey: true }), 1500, false))
  assert.ok(!acceptKey(ca, 999, false)) // first second
  assert.ok(!acceptKey(ca, 5000, true)) // focus in a text field
  assert.ok(!acceptKey({ ...ca, repeat: true }, 5000, false))
  for (const k of [key('Space'), key('Enter'), key('KeyA'), key('KeyA', { ctrlKey: true }), key('KeyA', { altKey: true }), key('KeyA', { ctrlKey: true, altKey: true, shiftKey: true })])
    assert.ok(!acceptKey(k, 5000, false), JSON.stringify(k))
})
