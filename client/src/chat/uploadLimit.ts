// The per-file upload limit the composer enforces: the server's own setting (admin Settings, 1-100 MB; GET /instance
// max_upload_bytes), so a file the server takes is never refused here and one it refuses is caught before it uploads.
// Pure, so scripts/upload-limit.test.mjs can run it.

/** The server default (server/src/instance.js), used until the instance info is loaded. */
export const DEFAULT_MAX_UPLOAD = 25 * 1024 * 1024
const MIB = 1024 * 1024

/** `bytes`: max_upload_bytes of the server the channel lives on. shortcut: a linked node's own limit is not known to the
 *  client, so node channels use the default; read it from the node's /instance if nodes change it. */
export const uploadLimit = (bytes: unknown, onNode: boolean) =>
  !onNode && typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes > 0 ? bytes : DEFAULT_MAX_UPLOAD

/** The limit in whole MB, as the admin sets it. */
export const limitMb = (bytes: number) => Math.max(1, Math.floor(bytes / MIB))
