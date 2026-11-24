// How fetched message pages join a channel's loaded window (src/chat/messageWindow.ts). Run: npm test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { replaceWindow, windowToken, withNewer, withOlder } from '../src/chat/messageWindow.ts'

const msgs = (...ids) => ids.map((id) => ({ id: String(id) }))
const ids = (list) => list?.map((m) => m.id)

test('an older page goes in front, sorted, without duplicates', () => {
  assert.deepEqual(ids(withOlder('a', msgs(10, 11), msgs(9, 7, 8, 10), '10', windowToken('a'))), ['7', '8', '9', '10', '11'])
})

test('opening a search result in an unloaded channel: the latest page arriving after the jump is dropped', () => {
  const token = windowToken('b') // the channel view asks for the latest page ...
  replaceWindow('b') // ... the jump's page arrives first and replaces the window
  const around = msgs(100, 101, 102)
  assert.equal(withOlder('b', around, msgs(500, 501), undefined, token), null, 'newest messages must not land above the jumped-to ones')
  assert.deepEqual(ids(withOlder('b', around, msgs(500, 501), undefined, windowToken('b'))), ['500', '501', '100', '101', '102'], 'a page asked after it applies')
})

test('an older page is dropped once the list no longer starts where it was asked from', () => {
  // scrolled up from 10, then a jump (or live trimming) changed the window: prepending would leave a gap
  assert.equal(withOlder('c', msgs(100, 101), msgs(8, 9), '10', windowToken('c')), null)
  assert.equal(withOlder('c', undefined, msgs(8, 9), '10', windowToken('c')), null)
})

test('a newer page goes after the newest sent message, only while that is still the one it was asked from', () => {
  assert.deepEqual(ids(withNewer(msgs(1, 2), msgs(4, 3, 2), '2')), ['1', '2', '3', '4'])
  assert.equal(withNewer(msgs(50, 51), msgs(3), '2'), null, 'the window was replaced meanwhile')
})
