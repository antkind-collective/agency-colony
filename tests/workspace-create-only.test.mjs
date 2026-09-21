// Colony may CREATE Google Workspace users and nothing else (11 Sep 2026:
// "deleting should always be manual"). The service-account scope cannot be
// narrowed below read-write at Google's end, so this is the line in code: any
// function that reaches the Directory API with anything but a create fails the
// suite. A future session cannot add a delete without deleting this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../netlify/functions/', import.meta.url));
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}
const DIRECTORY_API = /admin\.googleapis\.com\/admin\/directory/;
const FORBIDDEN = [
  { re: /method:\s*['"`](DELETE|PUT|PATCH)['"`]/i, why: 'a non-create HTTP method' },
  { re: /\/users\/[^'"`\s]*\b(delete|undelete|makeAdmin)\b/i, why: 'a user delete/admin endpoint' },
  { re: /\bsuspended\s*:\s*true/i, why: 'suspending a user' },
  { re: /users\.(delete|update|patch|undelete)\b/i, why: 'a non-create users method' }
];

test('Workspace functions can only create users — never delete, suspend or modify', () => {
  const offenders = [];
  let touchesDirectory = 0;
  for (const file of walk(ROOT)) {
    const src = readFileSync(file, 'utf8');
    if (!DIRECTORY_API.test(src)) continue;
    touchesDirectory += 1;
    for (const { re, why } of FORBIDDEN) {
      if (re.test(src)) offenders.push(`${file.replace(ROOT, '')}: ${why}`);
    }
  }
  // Sanity: the guard is watching something. If the provisioning function is
  // ever renamed away, this fails rather than silently guarding nothing.
  assert.ok(touchesDirectory >= 1, 'no function references the Directory API — guard is watching nothing');
  assert.deepEqual(offenders, []);
});
