// Server-side authorisation invariants (security audit, 16 Sep 2026).
//
// Every Netlify function reads with the service-role key, so "the bearer token
// is valid" proves only that SOMEONE is signed in — a client on Circle or a
// candidate included. The audit found four notify functions acting on any id
// in the payload on that basis alone. These checks make the class of bug fail
// the suite instead of waiting for the next audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const DIR = fileURLToPath(new URL('../netlify/functions/', import.meta.url));
const TOML = readFileSync(fileURLToPath(new URL('../netlify.toml', import.meta.url)), 'utf8');
const files = readdirSync(DIR).filter((f) => f.endsWith('.js'));
const src = (f) => readFileSync(DIR + f, 'utf8');

const isCron = (s) => /\.next_run\b/.test(s);
const PUBLIC = new Set(['runtime-config.js']);              // anon key + feature flags only
const WEBHOOK = new Set(['papersign-webhook.js']);          // shared key, no session

// A check that asks WHO the caller is, beyond "their token is valid".
const CALLER_AUTHZ = /callerCanSee\(|callerIs\(|rpc\(\s*['"]is_[a-z_]+['"]\s*\)|\.eq\(\s*['"]auth_user_id['"]\s*,\s*(requester|authUserId|userResponse|who|user)/;

test('every session function authorises the caller, not just the token', () => {
  const missing = [];
  for (const f of files) {
    const s = src(f);
    if (isCron(s) || PUBLIC.has(f) || WEBHOOK.has(f)) continue;
    if (!/auth\.getUser\(/.test(s)) missing.push(`${f}: never verifies a session`);
    else if (!CALLER_AUTHZ.test(s)) missing.push(`${f}: verifies the token but never checks what the caller may do`);
  }
  assert.deepEqual(missing, []);
});

test('scheduled functions guard on next_run and are registered in netlify.toml', () => {
  const crons = files.filter((f) => isCron(src(f)));
  assert.ok(crons.length >= 9, `expected the known crons, found ${crons.length}`);
  for (const f of crons) {
    const name = f.replace(/\.js$/, '');
    assert.match(TOML, new RegExp(`\\[functions\\."${name}"\\]\\s*\\n\\s*schedule\\s*=`), `${name} has no schedule in netlify.toml`);
    assert.doesNotMatch(src(f), /httpMethod\s*!==?\s*['"]POST['"]/, `${name} guards on httpMethod — that killed every cron in 2026`);
  }
});

test('the webhook rejects a missing or wrong key before doing anything', () => {
  const s = src('papersign-webhook.js');
  const keyCheck = s.indexOf('PAPERSIGN_WEBHOOK_KEY');
  assert.ok(keyCheck > 0 && keyCheck < s.indexOf('getSupabaseAdmin()'), 'key check must precede any database access');
  assert.match(s, /if \(!expected \|\|/, 'an unset key must refuse, not accept everything');
});

test('notify functions do not echo recipients back to the caller', () => {
  for (const f of ['hire-notify.js', 'brief-notify.js', 'client-status-notify.js', 'feature-request-notify.js']) {
    const s = src(f);
    const echoes = /jsonResponse\(200,[^)]*(\brecipients\b|\bemailResult\s*[,}]|sent: results\s*[,}])/.test(s);
    assert.ok(!echoes, `${f} returns addresses`);
  }
});

test('nothing a caller can type reaches a feature-request email', () => {
  const s = src('feature-request-notify.js');
  assert.ok(!/payload\.(replyText|newStatus|actorName)/.test(s), 'reads replyText/newStatus/actorName from the payload');
  assert.ok(!/\{\s*type,\s*featureRequestId,\s*actorName\s*\}/.test(s), 'destructures actorName from the payload');
});

test('callerDisplayName takes the name from the row, first + last word', async () => {
  const { callerDisplayName } = require('../netlify/functions/lib/caller.js');
  const table = (rows) => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: rows }) }), maybeSingle: async () => ({ data: rows }) }) }) });
  const admin = (emp, partner) => ({ from: (t) => (t === 'employees' ? table(emp) : table(partner)) });
  assert.equal((await callerDisplayName(admin({ id: 'e', full_name: 'Rhea Anand Rao' }, null), 'u')).name, 'Rhea Rao');
  assert.equal((await callerDisplayName(admin(null, { id: 'p', full_name: 'Mira' }), 'u')).name, 'Mira');
  const nobody = await callerDisplayName(admin(null, null), 'u');
  assert.equal(nobody.name, 'Someone');
  assert.equal(nobody.employeeId, null);
});

// Audit 16 Sep 2026. Every control in Colony is one click for a signed-in
// person, so a page that frames the app is the whole clickjacking attack.
// These headers are served by netlify.toml, which no test read before.
test('every response carries the framing and sniffing headers', () => {
  const global = TOML.match(/\[\[headers\]\]\s*\n\s*for\s*=\s*"\/\*"\s*\n\s*\[headers\.values\]([\s\S]*?)(?=\n\[\[|\n#|$)/);
  assert.ok(global, 'no [[headers]] block for /*');
  const block = global[1];
  assert.match(block, /X-Frame-Options\s*=\s*"DENY"/);
  assert.match(block, /Content-Security-Policy\s*=\s*"frame-ancestors 'none'"/);
  assert.match(block, /X-Content-Type-Options\s*=\s*"nosniff"/);
  assert.match(block, /Referrer-Policy\s*=\s*"strict-origin-when-cross-origin"/);
  // frame-ancestors only: a fuller CSP would have to account for the inline
  // scripts and styles in index.html, and silently breaks the app if it does not.
  const csp = block.match(/Content-Security-Policy\s*=\s*"([^"]*)"/)[1];
  assert.ok(!/script-src|style-src|default-src/.test(csp), `CSP grew beyond frame-ancestors: ${csp}`);
});

// Nothing frames Colony or Circle — the premise of DENY above.
test('the app neither frames nor is framed', () => {
  for (const f of ['../index.html', '../app.js']) {
    const s = readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
    assert.ok(!/<iframe/i.test(s), `${f} has an iframe — re-check X-Frame-Options: DENY`);
    assert.ok(!/window\.(top|parent)\b/.test(s), `${f} reaches for a parent frame`);
  }
});

// Staff on Circle read the client's workspace and reply to feedback — nothing
// else (10 Sep 2026). The 17 Sep audit found the brief edit bar, revision
// button, upload box and org-contact editing all showing for a reviewer there,
// because each gate asked "is this partner a client_viewer?" and a reviewer
// has no partner profile to say no. Source checks, since app.js is not a module.
test('staff on Circle get no write controls beyond feedback replies', () => {
  const app = readFileSync(fileURLToPath(new URL('../app.js', import.meta.url)), 'utf8');
  const fn = (name) => {
    const start = app.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} not found in app.js`);
    return app.slice(start, app.indexOf('\n}\n', start));
  };
  assert.match(fn('canEditOrgContacts'), /if \(state\.staffOnCircle\) return false;/);
  const detail = fn('renderPartnerBriefDetail');
  assert.match(detail, /const staffView = Boolean\(state\.staffOnCircle\) && !state\.partnerProfile;/);
  assert.match(detail, /const editable = !staffView &&/);
  assert.match(detail, /!\(!staffView && brief\.status === 'delivered'/);
  assert.match(detail, /\['pbdUploadInput', 'pbdCommentInput'\][\s\S]*toggle\('hidden', staffView\)/);
  assert.match(fn('uploadPartnerBriefFiles'), /!state\.partnerProfile\) return;/);
  assert.match(fn('applyStaffOnCircleReadOnly'), /'newBriefBtn', 'submitBriefBtn', 'pfComposePanel', 'orgContactsForm'/);
  // It must never UN-hide anything: for a client that re-showed the internal
  // notify bell and policy link (17 Sep 2026).
  assert.match(fn('applyStaffOnCircleReadOnly'), /if \(!readOnly\) return;/);
  assert.doesNotMatch(fn('applyStaffOnCircleReadOnly'), /classList\.toggle\('hidden', readOnly\)/);
});

// Address and emergency contact are column-revoked from authenticated
// (202609210001): a client select naming them fails for EVERYONE, sign-in
// included, and a save that writes them unloaded blanks them (21 Sep 2026).
test('no client query selects the private employee columns; the save writes them only once loaded', () => {
  const files = ['../app.js', ...readdirSync(fileURLToPath(new URL('../js/', import.meta.url))).filter((f) => f.endsWith('.js')).map((f) => `../js/${f}`)];
  for (const f of files) {
    const s = readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
    for (const m of s.matchAll(/\.from\(['"]employees['"]\)\s*\.select\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g)) {
      assert.doesNotMatch(m[1], /personal_address|emergency_contact|\*/, `${f}: employees select reaches a private column: ${m[1].slice(0, 80)}`);
    }
  }
  const app = readFileSync(fileURLToPath(new URL('../app.js', import.meta.url)), 'utf8');
  assert.match(app, /if \(profilePrivateDetailsFor === targetEmployeeId\) \{\s*updatePayload\.emergency_contact_name/);
});
