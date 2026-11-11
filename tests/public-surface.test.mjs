// What the website serves (24 Sep 2026). netlify.toml publishes the whole
// repository, so every tracked file is a public URL on app.youragency.com and
// clients.youragency.com unless a force-404 rule blocks it. Until today that meant
// CLAUDE.md, docs/ (open security items, the schema, audit reports), all
// migrations, tests, function source and CSVs naming staff with personal
// Gmail addresses were downloadable by anyone.
//
// Every tracked file must be either on PUBLIC below (what the two apps load)
// or blocked by a 404 rule. A new file fails this test until someone decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOML = readFileSync(`${ROOT}netlify.toml`, 'utf8');

// Served on purpose. Netlify never serves netlify.toml or dotfiles.
const PUBLIC = [
  /^index\.html$/, /^app\.js$/, /^styles\.css$/, /^robots\.txt$/,
  /^js\/[^/]+\.js$/, /^vendor\//, /^assets\//,
  /^changelog\.json$/,                       // Colony home; 404 on Circle
  /^nda\.html$/,                             // the NDA link's form (22 Oct 2026); one-time token, no data in the page
  /^data\/sustainability-calendar-\d{4}\.json$/, // Colony home; 404 on Circle
  // Uncommon Labs microsite (Mar 2026): public on purpose (24 Sep 2026).
  /^uncommon\//,
  /^netlify\.toml$/, /^\./,   // Netlify serves no dotfile (checked: .env.example, .gitignore 404)
];

// Path-only force-404 rules (host-specific ones do not protect the other host).
const blocked = [...TOML.matchAll(/\[\[redirects\]\]\s*\n\s*from = "(\/[^"]*)"\s*\n\s*to = "[^"]*"\s*\n\s*status = 404\s*\n\s*force = true/g)]
  .map((m) => m[1]);
const isBlocked = (file) => blocked.some((rule) => (rule.endsWith('/*')
  ? `/${file}`.startsWith(rule.slice(0, -1))
  : `/${file}` === rule));

let tracked = [];
try {
  tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
} catch { /* not a git checkout */ }

test('every tracked file is either meant to be public or blocked from the website', { skip: !tracked.length && 'not a git checkout' }, () => {
  const exposed = tracked.filter((f) => !PUBLIC.some((re) => re.test(f)) && !isBlocked(f));
  assert.deepEqual(exposed, [], 'these files would be downloadable by anyone — add a force-404 rule to netlify.toml or, if they must be public, to PUBLIC here');
});

test('repo documents and staff data are blocked on every host', () => {
  for (const f of ['CLAUDE.md', 'docs/OPEN.md', 'docs/SCHEMA.md', 'supabase/migrations/x.sql', 'setup/IMPORT_EMPLOYEES_SAFE_PREVIEW.csv',
    'sample_data/employees_sample.csv', 'netlify/functions/runtime-config.js', 'tests/x.mjs', '_build/build-circle.mjs', 'package.json']) {
    assert.ok(isBlocked(f), `${f} is not blocked`);
  }
});


// Netlify's secret scan fails the build when a value of a secret env var
// appears in any file it publishes. A literal Papersign webhook key in the
// public-export scrub list stopped every deploy from 1 Oct 2026 (audit, 2 Oct).
// The scrub lists name placeholders; the key itself comes from the environment.
