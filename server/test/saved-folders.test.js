import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, guildWith } from './helpers.js';

let srv, api, g, alice, bob;
before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob']);
  ({ alice, bob } = g.users);
});
after(() => srv.stop());

test('saved folders and message tags: CRUD folders, assign message to folder with tags, delete folder sets NULL', async () => {
  // 1. Initial list of folders
  const init = (await api('GET', '/users/@me/saved-folders', alice.token)).body;
  assert.deepEqual(init, []);

  // 2. Create folder
  const createRes = await api('POST', '/users/@me/saved-folders', alice.token, {
    name: 'Work References',
    color: '#ff5722',
    icon: 'briefcase',
  });
  assert.equal(createRes.status, 201);
  assert.ok(createRes.body.id);
  assert.equal(createRes.body.name, 'Work References');
  assert.equal(createRes.body.color, '#ff5722');
  assert.equal(createRes.body.icon, 'briefcase');
  assert.equal(createRes.body.user_id, alice.id);

  const folderId = createRes.body.id;

  // 3. List folders shows created folder
  const list = (await api('GET', '/users/@me/saved-folders', alice.token)).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, folderId);

  // 4. Bob cannot view/modify Alice's folder
  const bobPatch = await api('PATCH', `/users/@me/saved-folders/${folderId}`, bob.token, { name: 'Hacked' });
  assert.equal(bobPatch.status, 404);

  // 5. Alice updates folder
  const patchRes = await api('PATCH', `/users/@me/saved-folders/${folderId}`, alice.token, {
    name: 'Important Work',
    color: '#00e676',
  });
  assert.equal(patchRes.status, 200);
  assert.equal(patchRes.body.name, 'Important Work');
  assert.equal(patchRes.body.color, '#00e676');

  // 6. Post a message to general and bookmark it
  const msg = (await api('POST', `/channels/${g.general.id}/messages`, bob.token, { content: 'Please review this quarterly report' })).body;
  const saveRes = await api('PUT', `/users/@me/saved-messages/${g.general.id}/${msg.id}`, alice.token, {});
  assert.ok(saveRes.status === 200 || saveRes.status === 204);

  // 7. PATCH saved-messages/:id with folder_id and tags
  const patchMsg = await api('PATCH', `/users/@me/saved-messages/${msg.id}`, alice.token, {
    folder_id: folderId,
    tags: ['work', 'q3-report', 'urgent'],
  });
  assert.equal(patchMsg.status, 200);
  assert.equal(patchMsg.body.save_data.folder_id, folderId);
  assert.deepEqual(patchMsg.body.save_data.tags, ['work', 'q3-report', 'urgent']);

  // 8. Verify GET saved-messages
  const savedList = (await api('GET', '/users/@me/saved-messages', alice.token)).body.results;
  const target = savedList.find(s => s.save_data.message_id === msg.id);
  assert.ok(target);
  assert.equal(target.save_data.folder_id, folderId);
  assert.deepEqual(target.save_data.tags, ['work', 'q3-report', 'urgent']);

  // 9. Delete folder
  const delRes = await api('DELETE', `/users/@me/saved-folders/${folderId}`, alice.token);
  assert.ok(delRes.status === 204 || delRes.status === 200);

  // 10. Folder is gone
  const emptyFolders = (await api('GET', '/users/@me/saved-folders', alice.token)).body;
  assert.deepEqual(emptyFolders, []);

  // 11. Saved message has folder_id = null, tags preserved
  const savedAfterDel = (await api('GET', '/users/@me/saved-messages', alice.token)).body.results;
  const targetAfter = savedAfterDel.find(s => s.save_data.message_id === msg.id);
  assert.ok(targetAfter);
  assert.equal(targetAfter.save_data.folder_id, null);
  assert.deepEqual(targetAfter.save_data.tags, ['work', 'q3-report', 'urgent']);
});

test('saved folders and message tags enforce type, length and count bounds', async () => {
  const maxName = 'f'.repeat(64);
  const overName = 'f'.repeat(65);

  for (const badName of [undefined, null, '', '   ', 123, { name: 'obj' }, ['arr'], overName]) {
    const res = await api('POST', '/users/@me/saved-folders', alice.token, { name: badName });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 50035);
  }

  const first = await api('POST', '/users/@me/saved-folders', alice.token, { name: `  ${maxName}  ` });
  assert.equal(first.status, 201);
  assert.equal(first.body.name, maxName);

  for (const badName of [null, '', '   ', 123, { name: 'obj' }, ['arr'], overName]) {
    const res = await api('PATCH', `/users/@me/saved-folders/${first.body.id}`, alice.token, { name: badName });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 50035);
  }
  assert.equal((await api('GET', '/users/@me/saved-folders', alice.token)).body[0].name, maxName);

  const renamed = await api('PATCH', `/users/@me/saved-folders/${first.body.id}`, alice.token, { name: 'Folder 1' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, 'Folder 1');

  for (let i = 2; i <= 50; i++) {
    const res = await api('POST', '/users/@me/saved-folders', alice.token, { name: `Folder ${i}` });
    assert.equal(res.status, 201);
  }
  const overCap = await api('POST', '/users/@me/saved-folders', alice.token, { name: 'Folder 51' });
  assert.equal(overCap.status, 400);
  assert.equal(overCap.body.code, 50035);
  assert.equal((await api('GET', '/users/@me/saved-folders', alice.token)).body.length, 50);

  // Per-user cap does not block another user from creating folders
  const bobFolder = await api('POST', '/users/@me/saved-folders', bob.token, { name: 'Bob Folder' });
  assert.equal(bobFolder.status, 201);

  const msg = (await api('POST', `/channels/${g.general.id}/messages`, bob.token, { content: 'Tag bounds test' })).body;
  await api('PUT', `/users/@me/saved-messages/${g.general.id}/${msg.id}`, alice.token, {});

  const maxTag = 't'.repeat(32);
  const overTag = 't'.repeat(33);
  const twentyTags = Array.from({ length: 20 }, (_, i) => `tag-${i}`);
  const twentyOneTags = Array.from({ length: 21 }, (_, i) => `tag-${i}`);

  for (const badTags of [null, 'tag', 123, {}, [''], ['   '], [123], [{}], [overTag], ['ok', overTag], twentyOneTags]) {
    const res = await api('PATCH', `/users/@me/saved-messages/${msg.id}`, alice.token, { tags: badTags });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 50035);
  }

  const maxTagRes = await api('PATCH', `/users/@me/saved-messages/${msg.id}`, alice.token, {
    tags: [`  ${maxTag}  `, ...twentyTags.slice(1)],
  });
  assert.equal(maxTagRes.status, 200);
  assert.equal(maxTagRes.body.save_data.tags.length, 20);
  assert.equal(maxTagRes.body.save_data.tags[0], maxTag);
});
