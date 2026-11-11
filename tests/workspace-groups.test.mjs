import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { addGroupMember, listGroupMembers, groupFailureNote, allGroupAddress } = require('../netlify/functions/lib/workspace-groups.js');

const reply = (status, body) => async () => ({ ok: status < 300, status, json: async () => body });

test('all group defaults to all@youragency.com', () => {
  delete process.env.WORKSPACE_ALL_GROUP;
  assert.equal(allGroupAddress(), 'all@youragency.com');
});

test('addGroupMember: added, already a member, or a real failure', async () => {
  assert.deepEqual(await addGroupMember('t', 'all@youragency.com', 'a@youragency.com', reply(200, {})), { ok: true, already: false });
  // Google answers 409 "Member already exists" — the retry must treat it as done.
  assert.deepEqual(await addGroupMember('t', 'all@youragency.com', 'a@youragency.com', reply(409, { error: { message: 'Member already exists.' } })), { ok: true, already: true });
  const bad = await addGroupMember('t', 'all@youragency.com', 'a@youragency.com', reply(404, { error: { message: 'Resource Not Found: memberKey' } }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /memberKey/);
});

test('addGroupMember posts a MEMBER to the group', async () => {
  let seen;
  await addGroupMember('tok', 'all@youragency.com', 'new@youragency.com', async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({}) }; });
  assert.equal(seen.url, 'https://admin.googleapis.com/admin/directory/v1/groups/all%40youragency.com/members');
  assert.deepEqual(JSON.parse(seen.init.body), { email: 'new@youragency.com', role: 'MEMBER' });
  assert.equal(seen.init.headers.Authorization, 'Bearer tok');
});

test('listGroupMembers follows pages and lower-cases', async () => {
  const pages = [{ members: [{ email: 'A@youragency.com' }], nextPageToken: 'p2' }, { members: [{ email: 'b@youragency.com' }] }];
  let i = 0;
  const got = await listGroupMembers('t', 'all@youragency.com', async () => ({ ok: true, status: 200, json: async () => pages[i++] }));
  assert.deepEqual(got, ['a@youragency.com', 'b@youragency.com']);
});

test('groupFailureNote: the missing permission reads as a setup step, not an error code', () => {
  assert.match(groupFailureNote('x@youragency.com', 'unauthorized_client: Client is unauthorized'), /not yet allowed to manage group members/);
  assert.match(groupFailureNote('x@youragency.com', 'HTTP 500'), /retry daily/);
});

test('addGroupMember refuses any address outside @youragency.com, without calling Google', async () => {
  let called = false;
  const spy = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };
  for (const bad of ['someone@example.com', 'x@example.org', 'x@example.net', '', null]) {
    const r = await addGroupMember('t', 'all@youragency.com', bad, spy);
    assert.equal(r.ok, false, String(bad));
    assert.match(r.error, /not a @youragency\.com address/);
  }
  assert.equal(called, false);
});
