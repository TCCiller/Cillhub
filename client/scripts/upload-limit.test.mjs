// The composer and slash-command file options enforce the server's upload limit (src/chat/uploadLimit.ts). Run: npm test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DEFAULT_MAX_UPLOAD, limitMb, uploadLimit } from '../src/chat/uploadLimit.ts'

const MB = 1024 * 1024

test("the server's limit counts both ways: 100 MB lets 30 MB through, 8 MB stops 20 MB before it uploads", () => {
  assert.equal(uploadLimit(100 * MB, false), 100 * MB)
  assert.ok(30 * MB <= uploadLimit(100 * MB, false))
  assert.ok(20 * MB > uploadLimit(8 * MB, false))
  assert.equal(limitMb(uploadLimit(8 * MB, false)), 8)
})

test('the default until the instance info is loaded, for malformed values and for linked node channels', () => {
  for (const v of [undefined, null, 0, -1, 1.5, NaN, Infinity, '50000000', {}]) assert.equal(uploadLimit(v, false), DEFAULT_MAX_UPLOAD, String(v))
  assert.equal(uploadLimit(100 * MB, true), DEFAULT_MAX_UPLOAD)
  assert.equal(limitMb(DEFAULT_MAX_UPLOAD), 25)
})

test('no upload path keeps its own fixed 25 MB limit', () => {
  for (const f of ['../src/chat/Composer.tsx', '../src/commands/CommandUi.tsx']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /25 \* 1024 \* 1024|'25 MB'|max 25 MB/, f)
    assert.match(src, /uploadLimit\(useInstance\(\)\?\.max_upload_bytes/, f)
  }
})
