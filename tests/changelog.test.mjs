// "What's new in Colony" on the home page reads changelog.json. It sat
// unedited for six months while a lot shipped (28 Sep 2026), so the
// pre-push hook (.githooks/pre-push -> scripts/check-changelog.sh) blocks a
// push that changes what people see without adding a line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entries = JSON.parse(readFileSync(new URL('../changelog.json', import.meta.url), 'utf8'));
const script = fileURLToPath(new URL('../scripts/check-changelog.sh', import.meta.url));

test('changelog entries are well-formed and newest first', () => {
  // audience: who sees it under "What's new" (7 Oct 2026); none = everyone.
  const AUDIENCES = ['everyone', 'leadership', 'hiring', 'briefs', 'admin'];
  for (const e of entries) {
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(String(e.text || '').trim(), `empty text on ${e.date}`);
    for (const a of [].concat(e.audience ?? [])) assert.ok(AUDIENCES.includes(a), `unknown audience "${a}" on ${e.date}`);
  }
  const dates = entries.map((e) => e.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'chlog-'));
  const git = (...a) => execSync(`git ${a.join(' ')}`, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  writeFileSync(join(dir, 'app.js'), '1'); writeFileSync(join(dir, 'changelog.json'), '[]');
  mkdirSync(join(dir, 'supabase')); writeFileSync(join(dir, 'supabase/x.sql'), '1');
  git('add', '-A'); git('commit', '-qm', 'base');
  const commit = (file, body, msg) => { writeFileSync(join(dir, file), body); git('add', '-A'); git('commit', '-qm', `"${msg}"`); return git('rev-parse', 'HEAD'); };
  const run = (base, head) => spawnSync('bash', [script, base, head], { cwd: dir, encoding: 'utf8' }).status;
  return { git, commit, run, base: git('rev-parse', 'HEAD') };
}

test('What\'s new filters by audience in the app', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /updateIsForMe\(u\)/);
  for (const a of ['everyone', 'leadership', 'hiring', 'briefs', 'admin']) assert.match(app, new RegExp(`\\b${a}: \\(\\) =>`));
});

test('a visible change without a changelog line is blocked', () => {
  const r = repo();
  assert.equal(r.run(r.base, r.commit('app.js', '2', 'tweak')), 1);
});

test('a visible change with a changelog line passes', () => {
  const r = repo();
  r.commit('app.js', '2', 'tweak');
  assert.equal(r.run(r.base, r.commit('changelog.json', '[{}]', 'note')), 0);
});

test('[no-changelog] in a commit message passes; back-end-only changes pass', () => {
  const r = repo();
  assert.equal(r.run(r.base, r.commit('app.js', '2', 'footer spacing [no-changelog]')), 0);
  const r2 = repo();
  assert.equal(r2.run(r2.base, r2.commit('supabase/x.sql', '2', 'migration')), 0);
});
