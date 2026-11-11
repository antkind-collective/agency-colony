// Domain-wide delegation must stay at exactly four scopes (Friday audit, Admin
// console client YOUR_SERVICE_ACCOUNT_CLIENT_ID). A call that impersonates the admin
// mailbox with a fifth scope fails at Google only once it runs in production,
// and a session adding one could ask Alex to "just grant it". This pins the
// line in code: every googleAccessToken() call either impersonates with one of
// the four, or signs in as the service account itself ({ asSelf: true }, e.g.
// Google Analytics since 26 Oct 2026), which uses no delegation at all.
// (Audit 30 Oct 2026.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../netlify/functions/', import.meta.url));
const DELEGATED = new Set([
  'https://www.googleapis.com/auth/admin.directory.user',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/admin.directory.group.member',
  'https://www.googleapis.com/auth/calendar.events'
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

test('delegated Google tokens use only the four granted scopes', () => {
  const files = walk(ROOT).map((f) => ({ f: f.replace(ROOT, ''), src: readFileSync(f, 'utf8') }));
  const consts = new Map();
  for (const { src } of files) {
    for (const m of src.matchAll(/const\s+([A-Z_]+)\s*=\s*['"`](https:\/\/www\.googleapis\.com\/auth\/[^'"`]+)['"`]/g)) consts.set(m[1], m[2]);
  }
  const offenders = [];
  let delegatedCalls = 0;
  for (const { f, src } of files) {
    for (const m of src.matchAll(/googleAccessToken\(\s*([^,)]+)\s*(,[^)]*)?\)/g)) {
      if (/^scope$/.test(m[1].trim())) continue; // the definition itself
      if (m[2] && /asSelf\s*:\s*true/.test(m[2])) continue;
      delegatedCalls += 1;
      const arg = m[1].trim();
      const scope = consts.get(arg) ?? arg.replace(/^['"`]|['"`]$/g, '');
      if (!DELEGATED.has(scope)) offenders.push(`${f}: ${arg} = ${scope}`);
    }
  }
  assert.ok(delegatedCalls >= 5, `expected the provisioning/Drive/calendar calls, found ${delegatedCalls}`);
  assert.deepEqual(offenders, [], 'a delegated call asks for a scope the Admin console does not grant');
});
