import { snowflake } from '../snowflake.js';
import { get, run, memberIds, json } from '../db.js';
import { invalid, list, snowflakeField } from '../errors.js';
import { P } from '../permissions.js';
import { sendToUsers, guildParts } from '../gateway.js';
import { loadGuild } from './guilds.js';

// Attach guide to guild object in gateway payload
guildParts.push(g => {
  const row = get('SELECT * FROM guild_server_guide WHERE guild_id = ?', g.id);
  if (!row) return { guide: null };
  return {
    guide: {
      guild_id: g.id,
      enabled: !!row.enabled,
      welcome_message: row.welcome_message ?? null,
      new_member_actions: json(row.new_member_actions, []),
      resource_pages: json(row.resource_pages, []),
    },
  };
});

function getGuide(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  const row = get('SELECT * FROM guild_server_guide WHERE guild_id = ?', g.id);
  return {
    guild_id: g.id,
    enabled: row ? !!row.enabled : false,
    welcome_message: row?.welcome_message ?? null,
    new_member_actions: row ? json(row.new_member_actions, []) : [],
    resource_pages: row ? json(row.resource_pages, []) : [],
  };
}

function putGuide(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD);
  const body = ctx.body ?? {};
  const enabled = body.enabled !== undefined ? !!body.enabled : true;
  const welcomeMessage = body.welcome_message != null ? String(body.welcome_message).slice(0, 2000) : null;
  const entries = field => {
    const rows = body[field] === undefined ? [] : list(body, field);
    if (rows.length > 5) throw invalid(field, 'BASE_TYPE_MAX_LENGTH', 'At most 5 entries.');
    return rows.map((entry, i) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw invalid(`${field}.${i}`, 'BASE_TYPE_OBJECT', 'Must be an object.');
      }
      const channelId = snowflakeField(entry, 'channel_id');
      if (!get('SELECT 1 FROM channels WHERE id = ? AND guild_id = ?', channelId, g.id)) {
        throw invalid(`${field}.${i}.channel_id`, 'BASE_TYPE_CHOICES', 'Channel must belong to this guild.');
      }
      return {
        id: typeof entry.id === 'string' && /^\d{1,19}$/.test(entry.id) ? entry.id : snowflake(),
        title: String(entry.title || '').slice(0, 100),
        description: entry.description ? String(entry.description).slice(0, 500) : null,
        channel_id: channelId,
        icon: entry.icon ? String(entry.icon).slice(0, 100) : null,
      };
    });
  };
  const newMemberActions = entries('new_member_actions');
  const resourcePages = entries('resource_pages');

  run(`
    INSERT INTO guild_server_guide (guild_id, enabled, welcome_message, new_member_actions, resource_pages)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      enabled = excluded.enabled,
      welcome_message = excluded.welcome_message,
      new_member_actions = excluded.new_member_actions,
      resource_pages = excluded.resource_pages
  `, g.id, Number(enabled), welcomeMessage, JSON.stringify(newMemberActions), JSON.stringify(resourcePages));

  const out = {
    guild_id: g.id,
    enabled,
    welcome_message: welcomeMessage,
    new_member_actions: newMemberActions,
    resource_pages: resourcePages,
  };
  sendToUsers(memberIds(g.id), 'GUILD_UPDATE', { id: g.id, guide: out });
  return out;
}

export default [
  ['GET', '/guilds/:id/guide', getGuide],
  ['PUT', '/guilds/:id/guide', putGuide],
];
