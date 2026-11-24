import test from 'node:test'
import assert from 'node:assert/strict'
import { archivedCursor } from '../src/threads/archived.ts'

const threads = [
  { id: '9007199254740993', thread_metadata: { archive_timestamp: '2026-11-23T12:00:00.000Z' } },
  { id: '9007199254740992', thread_metadata: { archive_timestamp: '2026-11-20T12:00:00.000Z' } },
  { id: '9999999999999999', thread_metadata: { archive_timestamp: '2026-11-22T12:00:00.000Z' } },
]
for (const kind of ['public', 'private']) {
  test(`${kind} uses the oldest archive timestamp, regardless of page order`, () => {
    assert.equal(archivedCursor(kind, { threads, has_more: true }), threads[1].thread_metadata.archive_timestamp)
  })
}
test('joined uses the smallest exact snowflake rather than a timestamp or rounded number', () => {
  assert.equal(archivedCursor('joined', { threads, has_more: true }), threads[1].id)
  assert.equal(archivedCursor('joined', { threads: [{ id: '10' }, { id: '9' }], has_more: true }), '9')
})
test('exhausted and empty pages have no next cursor for every kind', () => {
  for (const kind of ['public', 'private', 'joined']) {
    assert.equal(archivedCursor(kind, { threads, has_more: false }), undefined)
    assert.equal(archivedCursor(kind, { threads: [], has_more: true }), undefined)
  }
})
