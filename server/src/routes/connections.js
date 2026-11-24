import { randomUUID } from 'node:crypto';
import { get, all, run, json } from '../db.js';
import { HttpError, invalid, notFound, str } from '../errors.js';
import { isHttp } from '../embeds.js';

const MAX_CONNECTIONS = 25;
const MAX_TYPE = 32;
const MAX_NAME = 100;
const MAX_METADATA_BYTES = 1024;
const TYPE_SLUG = /^[a-z0-9][a-z0-9_-]*$/;

function metadataField(body) {
  const v = body?.metadata;
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw invalid('metadata', 'BASE_TYPE_OBJECT', 'Must be a JSON object.');
  if (v.profile_url != null && !isHttp(v.profile_url)) {
    throw invalid('metadata.profile_url', 'URL_TYPE_INVALID_URL', 'Not a well formed http(s) URL.');
  }
  const raw = JSON.stringify(v);
  if (Buffer.byteLength(raw, 'utf8') > MAX_METADATA_BYTES) {
    throw invalid('metadata', 'BASE_TYPE_MAX_LENGTH', `Must be at most ${MAX_METADATA_BYTES} bytes.`);
  }
  return raw;
}

function connectionObj(r) {
  return {
    id: r.id,
    user_id: r.user_id,
    type: r.type,
    name: r.name,
    verified: Boolean(r.verified),
    show_on_profile: Boolean(r.show_on_profile),
    metadata: json(r.metadata, null),
    created_at: r.created_at,
  };
}

function listConnections(ctx) {
  return all('SELECT * FROM user_connections WHERE user_id = ? ORDER BY created_at ASC', ctx.user.id).map(connectionObj);
}

function createConnection(ctx) {
  const b = ctx.body ?? {};
  const type = str(b, 'type', 1, MAX_TYPE).toLowerCase();
  if (!TYPE_SLUG.test(type)) throw invalid('type', 'BASE_TYPE_BAD_VALUE', 'Must be a lower-case slug (letters, digits, _ or -).');
  const name = str(b, 'name', 1, MAX_NAME);
  const metadata = metadataField(b);

  const existing = get('SELECT id FROM user_connections WHERE user_id = ? AND type = ? AND name = ?', ctx.user.id, type, name);
  if (existing) {
    throw new HttpError(400, 50035, 'Connection already exists');
  }
  if (get('SELECT COUNT(*) AS n FROM user_connections WHERE user_id = ?', ctx.user.id).n >= MAX_CONNECTIONS) {
    throw new HttpError(400, 50035, `Maximum number of connections reached (${MAX_CONNECTIONS})`);
  }

  const id = randomUUID();
  const showOnProfile = b.show_on_profile !== undefined ? (b.show_on_profile ? 1 : 0) : 1;
  const createdAt = new Date().toISOString();

  run(`
    INSERT INTO user_connections (id, user_id, type, name, verified, show_on_profile, metadata, created_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?)
  `, id, ctx.user.id, type, name, showOnProfile, metadata, createdAt);

  const row = get('SELECT * FROM user_connections WHERE id = ?', id);
  ctx.status = 201;
  return connectionObj(row);
}

function updateConnection(ctx) {
  const conn = get('SELECT * FROM user_connections WHERE id = ? AND user_id = ?', ctx.params.id, ctx.user.id);
  if (!conn) throw notFound(10013, 'Connection');

  const b = ctx.body ?? {};
  let showOnProfile = conn.show_on_profile;
  if (b.show_on_profile !== undefined) {
    showOnProfile = b.show_on_profile ? 1 : 0;
  }
  let metadata = conn.metadata;
  if (b.metadata !== undefined) {
    metadata = metadataField(b);
  }

  run('UPDATE user_connections SET show_on_profile = ?, metadata = ? WHERE id = ? AND user_id = ?',
    showOnProfile, metadata, conn.id, ctx.user.id);

  const updated = get('SELECT * FROM user_connections WHERE id = ?', conn.id);
  return connectionObj(updated);
}

function deleteConnection(ctx) {
  const conn = get('SELECT * FROM user_connections WHERE id = ? AND user_id = ?', ctx.params.id, ctx.user.id);
  if (!conn) throw notFound(10013, 'Connection');

  run('DELETE FROM user_connections WHERE id = ? AND user_id = ?', conn.id, ctx.user.id);
  ctx.status = 204;
}

const user = { userOnly: true };
export default [
  ['GET', '/users/@me/connections', listConnections, user],
  ['POST', '/users/@me/connections', createConnection, user],
  ['PATCH', '/users/@me/connections/:id', updateConnection, user],
  ['DELETE', '/users/@me/connections/:id', deleteConnection, user],
];
