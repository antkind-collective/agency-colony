// First step of the Netlify build. Before the installer has run, it sends the
// site's home page to install.html. After, it writes the agency's details into
// the app, so nobody edits code. Runs on Netlify's checkout, never a work tree.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { identityFrom, applyIdentity } = require('../netlify/functions/lib/identity.js');

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p); else if (/\.(js|html)$/.test(name)) yield p;
  }
}

// The installer applies migrations itself, and functions can't read repo files
// reliably once bundled, so they travel as one JSON module.
const dir = 'supabase/migrations';
const bundle = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
writeFileSync('netlify/functions/lib/migrations-bundle.json', JSON.stringify(bundle));
console.log(`apply-identity: bundled ${Object.keys(bundle).length} migrations`);

const { AGENCY_ADMIN_EMAIL, AGENCY_NAME, SUPABASE_URL, APP_BASE_URL } = process.env;
if (!AGENCY_ADMIN_EMAIL || !SUPABASE_URL) {
  writeFileSync('_redirects', '/ /install.html 302!\n/index.html /install.html 302!\n');
  console.log('apply-identity: not installed yet, home page goes to the installer');
  process.exit(0);
}
const id = identityFrom({
  adminEmail: AGENCY_ADMIN_EMAIL, companyName: AGENCY_NAME,
  host: new URL(APP_BASE_URL).host, supabaseHost: new URL(SUPABASE_URL).host
});
const files = ['index.html', 'nda.html', 'app.js', ...walk('js'), ...walk('netlify/functions')].filter(existsSync)
  .filter((f) => !/lib\/identity\.js$/.test(f));
let changed = 0;
for (const f of files) {
  const before = readFileSync(f, 'utf8');
  const after = applyIdentity(before, id);
  if (after !== before) { writeFileSync(f, after); changed += 1; }
}
console.log(`apply-identity: ${changed} files set up for ${id.domain}`);
