import { randomUUID } from 'node:crypto';
import { get, all, run } from '../db.js';
import { HttpError, notFound, str } from '../errors.js';
import { parseTags, savedObj } from './later.js';

const MAX_FOLDERS = 50;
const MAX_FOLDER_NAME = 64;

function listFolders(ctx) {
  return all('SELECT * FROM saved_message_folders WHERE user_id = ? ORDER BY created_at ASC', ctx.user.id);
}

function createFolder(ctx) {
  const name = str(ctx.body ?? {}, 'name', 1, MAX_FOLDER_NAME);
  const count = get('SELECT COUNT(*) AS n FROM saved_message_folders WHERE user_id = ?', ctx.user.id).n;
  if (count >= MAX_FOLDERS) throw new HttpError(400, 50035, `Maximum of ${MAX_FOLDERS} folders reached`);
  const color = ctx.body?.color ? String(ctx.body.color).slice(0, 32) : null;
  const icon = ctx.body?.icon ? String(ctx.body.icon).slice(0, 64) : null;
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  run('INSERT INTO saved_message_folders (id, user_id, name, color, icon, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, ctx.user.id, name, color, icon, createdAt);

  ctx.status = 201;
  return { id, user_id: ctx.user.id, name, color, icon, created_at: createdAt };
}

function updateFolder(ctx) {
  const folder = get('SELECT * FROM saved_message_folders WHERE id = ? AND user_id = ?', ctx.params.id, ctx.user.id);
  if (!folder) throw notFound(10008, 'Folder');

  const name = ctx.body?.name !== undefined ? str(ctx.body, 'name', 1, MAX_FOLDER_NAME) : folder.name;
  const color = ctx.body?.color !== undefined ? (ctx.body.color ? String(ctx.body.color).slice(0, 32) : null) : folder.color;
  const icon = ctx.body?.icon !== undefined ? (ctx.body.icon ? String(ctx.body.icon).slice(0, 64) : null) : folder.icon;

  run('UPDATE saved_message_folders SET name = ?, color = ?, icon = ? WHERE id = ? AND user_id = ?',
    name, color, icon, folder.id, ctx.user.id);

  return { ...folder, name, color, icon };
}

function deleteFolder(ctx) {
  const folder = get('SELECT * FROM saved_message_folders WHERE id = ? AND user_id = ?', ctx.params.id, ctx.user.id);
  if (!folder) throw notFound(10008, 'Folder');

  run('UPDATE saved_messages SET folder_id = NULL WHERE user_id = ? AND folder_id = ?', ctx.user.id, folder.id);
  run('DELETE FROM saved_message_folders WHERE id = ? AND user_id = ?', folder.id, ctx.user.id);
  ctx.status = 204;
}

function updateSavedMessage(ctx) {
  const saved = get('SELECT * FROM saved_messages WHERE user_id = ? AND message_id = ?', ctx.user.id, ctx.params.id);
  if (!saved) throw notFound(10008, 'Saved Message');

  let folderId = saved.folder_id;
  if (ctx.body?.folder_id !== undefined) {
    if (ctx.body.folder_id === null || ctx.body.folder_id === '') {
      folderId = null;
    } else {
      const folder = typeof ctx.body.folder_id === 'string'
        && get('SELECT id FROM saved_message_folders WHERE id = ? AND user_id = ?', ctx.body.folder_id, ctx.user.id);
      if (!folder) throw notFound(10008, 'Folder');
      folderId = folder.id;
    }
  }

  let tags = saved.tags;
  if (ctx.body?.tags !== undefined) tags = parseTags(ctx.body);

  run('UPDATE saved_messages SET folder_id = ?, tags = ? WHERE user_id = ? AND message_id = ?',
    folderId, tags, ctx.user.id, ctx.params.id);

  const updated = get('SELECT * FROM saved_messages WHERE user_id = ? AND message_id = ?', ctx.user.id, ctx.params.id);
  return savedObj(updated);
}

const user = { userOnly: true };
export default [
  ['GET', '/users/@me/saved-folders', listFolders, user],
  ['POST', '/users/@me/saved-folders', createFolder, user],
  ['PATCH', '/users/@me/saved-folders/:id', updateFolder, user],
  ['DELETE', '/users/@me/saved-folders/:id', deleteFolder, user],
  ['PATCH', '/users/@me/saved-messages/:id', updateSavedMessage, user],
];
