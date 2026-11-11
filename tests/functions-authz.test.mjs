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
const PUBLIC = new Set(['install.js', 'runtime-config.js',               // anon key + feature flags only
  'nda-intake.js']);  // the NDA link: a one-time token is the permission (tests/nda.test.mjs)
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

test('the webhook escapes the candidate-typed name in its HTML email', () => {
  const s = src('papersign-webhook.js');
  const html = s.slice(s.indexOf('const html = '), s.indexOf('const text = '));
  assert.ok(html.length > 0, 'html template not found');
  assert.doesNotMatch(html, /\$\{hire\.full_name\}/, 'raw hire.full_name in the HTML body');
  assert.match(html, /escapeHtml\(hire\.full_name\)/);
});

test('notify functions do not echo recipients back to the caller', () => {
  for (const f of ['hire-notify.js', 'brief-notify.js', 'client-status-notify.js', 'feature-request-notify.js']) {
    const s = src(f);
    const echoes = /jsonResponse\(200,[^)]*(\brecipients\b|\bemailResult\s*[,}]|sent: results\s*[,}])/.test(s);
    assert.ok(!echoes, `${f} returns addresses`);
  }
});

// Audit 11 Nov 2026: a read-only brief viewer could read a brief, so passed
// callerCanSee, and could then email the client "Delivered".
test('brief-notify refuses staff who can read a brief but not work it', async () => {
  const Module = require('node:module');
  const briefId = '11111111-1111-1111-1111-111111111111';
  const run = async ({ canWork, partner = null }) => {
    const sent = [];
    const chain = (table) => {
      const c = { select: () => c, eq: () => c,
        maybeSingle: async () => ({ data: table === 'partners' ? partner : null }),
        single: async () => ({ data: { id: briefId, title: 'T', org: 'O', status: 'in_creative' } }),
        then: (ok) => ok({ data: [{ id: 'p', email: 'client@example.com', full_name: 'C', partner_role: 'coordinator', is_active: true }] }) };
      return c;
    };
    const stubs = {
      './lib/supabase-admin': { getSupabaseAdmin: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u', email: 'staff@youragency.com' } } }) }, from: chain }) },
      './lib/email': { sendEmail: async (m) => { sent.push(m); return { skipped: false }; } },
      './lib/notifications': { logNotification: async () => {} },
      './lib/config': { getConfig: () => ({ appBaseUrl: 'https://a', circleBaseUrl: 'https://c' }) },
      './lib/caller': { callerCanSee: async () => true, callerCanWorkBrief: async () => canWork },
      './lib/brief-approvers': { approverRecipients: () => [], shortDate: (d) => d }
    };
    const file = require.resolve('../netlify/functions/brief-notify.js');
    const load = Module._load;
    delete require.cache[file];
    Module._load = function (req, ...rest) { return stubs[req] || load.call(this, req, ...rest); };
    try {
      const { handler } = require(file);
      const res = await handler({ httpMethod: 'POST', headers: { authorization: 'Bearer t' }, body: JSON.stringify({ event: 'delivered', briefId }) });
      return { status: res.statusCode, sent: sent.length };
    } finally {
      Module._load = load;
      delete require.cache[file];
    }
  };
  assert.deepEqual(await run({ canWork: false }), { status: 403, sent: 0 }, 'a read-only viewer emailed the client');
  assert.deepEqual(await run({ canWork: true }), { status: 200, sent: 1 }, 'someone who can move the brief must still reach the client');
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
  // Every partner write control keys off canWrite, which is false for staff
  // and follows the DB partner write rule for clients (22 Sep 2026).
  assert.match(detail, /const canWrite = !staffView && partnerCanWriteBrief\(brief, state\.partnerProfile\);/);
  assert.match(detail, /const editable = canWrite &&/);
  assert.match(detail, /!\(canWrite && brief\.status === 'delivered'\)/);
  assert.match(detail, /\['pbdUploadInput', 'pbdLinkUrl', 'pbdCommentInput'\][\s\S]*toggle\('hidden', !canWrite\)/);
  assert.match(fn('uploadPartnerBriefFiles'), /!state\.partnerProfile\) return;/);
  assert.match(fn('applyStaffOnCircleReadOnly'), /'newBriefBtn', 'submitBriefBtn', 'pfComposePanel', 'orgContactsForm'/);
  // It must never UN-hide anything: for a client that re-showed the internal
  // notify bell and policy link (17 Sep 2026).
  assert.match(fn('applyStaffOnCircleReadOnly'), /if \(!readOnly\) return;/);
  assert.doesNotMatch(fn('applyStaffOnCircleReadOnly'), /classList\.toggle\('hidden', readOnly\)/);
});

// Address and emergency contact (202609210001) and date of birth
// (202609250002, S6) are column-revoked from authenticated: a client select naming them fails for EVERYONE, sign-in
// included, and a save that writes them unloaded blanks them (21 Sep 2026).
test('no client query selects the private employee columns; the save writes them only once loaded', () => {
  const files = ['../app.js', ...readdirSync(fileURLToPath(new URL('../js/', import.meta.url))).filter((f) => f.endsWith('.js')).map((f) => `../js/${f}`)];
  for (const f of files) {
    const s = readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
    for (const m of s.matchAll(/\.from\(['"]employees['"]\)\s*\.select\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g)) {
      assert.doesNotMatch(m[1], /personal_address|emergency_contact|date_of_birth|\*/, `${f}: employees select reaches a private column: ${m[1].slice(0, 80)}`);
    }
  }
  const app = readFileSync(fileURLToPath(new URL('../app.js', import.meta.url)), 'utf8');
  assert.match(app, /if \(profilePrivateDetailsFor === targetEmployeeId\) \{[^}]*updatePayload\.date_of_birth = birthdayValue;\s*updatePayload\.emergency_contact_name/);
  assert.doesNotMatch(app, /const updatePayload = \{[^}]*date_of_birth/, 'the profile save writes date_of_birth before it has loaded');
  // Birthdays moved into the home feed's Coming up list (28 Sep 2026).
  assert.match(app, /if \(!e\.birthday_md \|\| !e\.is_active\) return;/, 'Coming up no longer reads birthdays from birthday_md');
});

// Access parity audit, 22 Sep 2026: runtime-config is public and served on
// Circle, so it returns the anon key and feature flags and nothing else.
test('runtime-config returns only the anon connection and feature flags', async () => {
  const saved = { ...process.env };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon';
  process.env.APP_BASE_URL = 'https://staff.example';
  try {
    const { handler } = require(DIR + 'runtime-config.js');
    const res = await handler({});
    const body = JSON.parse(res.body);
    assert.deepEqual(Object.keys(body).sort(),
      ['ai', 'driveMirror', 'loginEmail', 'papersign', 'supabaseAnonKey', 'supabaseUrl', 'workspaceProvisioning']);
    assert.doesNotMatch(res.body, /colony|staff\.example/i);
  } finally {
    process.env = saved;
  }
});

// A partner's org is never assumed (S3, 24 Sep 2026). The add bar arrived
// pre-filled with the client and fell back to it when cleared, so a second client
// invited without retyping it read all of the client's briefs.
test('the partner add bar neither pre-fills nor falls back to an org', () => {
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  const input = html.match(/<input[^>]*id="newPartnerOrg"[^>]*>/)?.[0] || '';
  assert.ok(input, 'newPartnerOrg input not found');
  assert.ok(!/\svalue=/.test(input), `newPartnerOrg is pre-filled: ${input}`);
  const app = readFileSync(fileURLToPath(new URL('../app.js', import.meta.url)), 'utf8');
  const start = app.indexOf('async function addPartner(');
  const body = app.slice(start, app.indexOf('\n}\n', start));
  assert.ok(start >= 0, 'addPartner not found');
  assert.ok(!/\|\|\s*['"][^'"]+['"]/.test(body.split('\n').filter((l) => /org/i.test(l)).join('\n')), 'addPartner falls back to a literal org');
  assert.match(body, /resolvePartnerOrg\(/, 'addPartner no longer resolves the org through resolvePartnerOrg');
});

// The signed-out page redraws the empty client table; the analytics lookup
// inside it must not go out with the anon key (Q1, 24 Sep 2026: a 401 on
// every signed-out load of app.youragency.com).
test('the client table asks for analytics only when signed in', () => {
  const app = readFileSync(fileURLToPath(new URL('../app.js', import.meta.url)), 'utf8');
  const start = app.indexOf('async function renderClientRegistryTable(');
  assert.ok(start >= 0, 'renderClientRegistryTable not found');
  const body = app.slice(start, app.indexOf("from('client_analytics')", start));
  assert.match(body, /if \(state\.isAuthenticated && state\.supabase\) try \{\s*const \{ data: analyticsRows \}/, 'the client_analytics lookup is no longer guarded by a signed-in check');
});
