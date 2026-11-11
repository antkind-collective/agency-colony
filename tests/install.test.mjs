// The browser installer: identity rewriting, feature selection, and the rule
// that nothing happens without proving ownership of the site.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { identityFrom, applyIdentity, FREE_MAIL, PLACEHOLDER_PREFIX } = require('../netlify/functions/lib/identity.js');
const core = require('../netlify/functions/lib/install-core.js');
const install = require('../netlify/functions/install.js');

const id = identityFrom({ adminEmail: 'Boss@Example.org', companyName: 'Acme', host: 'acme.netlify.app', supabaseHost: 'abc.supabase.co' });

test('a free mail domain is refused: everyone on it would count as staff', () => {
  assert.throws(() => identityFrom({ adminEmail: `me@${[...FREE_MAIL][0]}`, companyName: 'X' }), /own domain/);
});
test('the owner becomes real; other role addresses can never belong to anyone', () => {
  assert.equal(applyIdentity("'admin@youragency.com'", id), "'boss@example.org'");
  assert.equal(applyIdentity('finance@youragency.com', id), `${PLACEHOLDER_PREFIX}finance@example.org`);
});
test('a role placeholder cannot overwrite the owner in an access map', () => {
  const out = applyIdentity("{'admin@youragency.com':'admin','creative-lead@youragency.com':'leadership'}", id);
  assert.equal(eval(`(${out})`)['boss@example.org'], 'admin');
});
test('domains work plain, in regexes and in hosts', () => {
  assert.equal(applyIdentity('@youragency.com', id), '@example.org');
  assert.equal(applyIdentity('/@youragency\\.com$/', id), '/@example\\.org$/');
  assert.equal(applyIdentity('https://app.youragency.com/x', id), 'https://acme.netlify.app/x');
  assert.equal(applyIdentity('Your Agency', id), 'Acme');
});
test('an installed copy is one site: it is Colony and sends nobody elsewhere', () => {
  const src = applyIdentity(readFileSync(new URL('../js/config.js', import.meta.url), 'utf8'), id);
  const start = src.indexOf('const STAFF_HOST');
  const end = src.indexOf('// ── Google Workspace reseller');
  assert.ok(start > 0 && end > start);
  const api = new Function(`${src.slice(start, end)}; return { isCircleHost, productName, homeHostFor };`)();
  assert.equal(api.isCircleHost('acme.netlify.app'), false);
  assert.equal(api.productName('acme.netlify.app'), 'Colony');
  assert.equal(api.homeHostFor('partner', 'acme.netlify.app'), null);
  assert.equal(api.homeHostFor('employee', 'acme.netlify.app'), null);
});
test('a company name cannot break out of the code it is written into', () => {
  assert.equal(identityFrom({ adminEmail: 'a@example.org', companyName: `O'Neil "<x>` }).name, 'ONeil x');
});
test('only ticked features write settings', () => {
  assert.deepEqual(core.envForIntegrations({ ai: { apiKey: 'k' } }), { ANTHROPIC_API_KEY: 'k' });
  assert.deepEqual(core.envForIntegrations({}), {});
});
test('a ticked feature with an empty field is refused', () => {
  assert.throws(() => core.envForIntegrations({ slack: { token: ' ' } }), /fill in every field/);
});
test('a Google key file is cut down to the two fields Colony uses', () => {
  const out = JSON.parse(core.compactServiceAccount(JSON.stringify({ client_email: 'a', private_key: 'b', project_id: 'c' })));
  assert.deepEqual(Object.keys(out).sort(), ['client_email', 'private_key']);
});
test('sign-in needs a method, and email links need email', () => {
  assert.throws(() => core.validateLogin({}, {}), /at least one/);
  assert.throws(() => core.validateLogin({ emailLink: true }, {}), /Email feature/);
  assert.doesNotThrow(() => core.validateLogin({ emailLink: true }, { email: {} }));
});
test('a pasted Client ID keeps only the ID, and anything else is refused', () => {
  const real = '123-abc.apps.googleusercontent.com';
  assert.equal(core.googleClientId(` https://${real}/ `), real);
  const cfg = core.authConfig({ siteUrl: 'https://a.netlify.app', login: { google: { clientId: `https://${real}/`, clientSecret: 's' } } });
  assert.equal(cfg.external_google_client_id, real);
  assert.throws(() => core.validateLogin({ google: { clientId: 'GOCSPX-abc', clientSecret: 's' } }, {}), /doesn't look right/);
});
test('without Workspace, nobody is emailed to make an account', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /window\.open\(href, '_blank'\);\n  \/\/ Only stamped once/);
  assert.match(app, /Which address did you create for/);
  assert.match(app, /'Create' : 'Add'\} @/);
});
test('the redirect list names this site only', () => {
  const cfg = core.authConfig({ siteUrl: 'https://a.netlify.app', login: { emailLink: true } });
  assert.equal(cfg.uri_allow_list, 'https://a.netlify.app/**');
  assert.equal(cfg.external_google_enabled, false);
});
test('settings too large for Netlify are refused before they break a deploy', () => {
  assert.throws(() => core.assertEnvFits({}, { A: 'x'.repeat(4000) }), /too large/);
});
test('an unknown or inherited action is refused before any network call', async () => {
  const saved = globalThis.fetch; let called = 0; globalThis.fetch = async () => { called += 1; throw new Error('no'); };
  try {
    for (const action of ['nope', 'constructor', '__proto__']) {
      const res = await install.handler({ httpMethod: 'POST', headers: { host: 'a.netlify.app' }, body: JSON.stringify({ action, netlifyToken: 't' }) });
      assert.equal(res.statusCode, 400);
    }
    assert.equal(called, 0);
  } finally { globalThis.fetch = saved; }
});
test('a token that does not own this site stops every action', async () => {
  const saved = globalThis.fetch; const urls = [];
  globalThis.fetch = async (u) => { urls.push(String(u)); return new Response('{}', { status: 404 }); };
  try {
    for (const action of Object.keys(install._test.actions)) {
      urls.length = 0;
      const res = await install.handler({ httpMethod: 'POST', headers: { host: 'victim.netlify.app' }, body: JSON.stringify({ action, netlifyToken: 'stranger', supabaseToken: 's', ref: 'abcdefghijkl' }) });
      assert.equal(res.statusCode, 403, action);
      assert.deepEqual(urls, ['https://api.netlify.com/api/v1/sites/victim.netlify.app'], action);
    }
  } finally { globalThis.fetch = saved; }
});
test('no token, no work', async () => {
  const res = await install.handler({ httpMethod: 'POST', headers: { host: 'a.netlify.app' }, body: JSON.stringify({ action: 'connect' }) });
  assert.equal(res.statusCode, 401);
});
test('the database is created before Google is asked about, because Google needs its address', () => {
  const page = readFileSync(new URL('../install.html', import.meta.url), 'utf8');
  const install = page.slice(page.indexOf("$('install').addEventListener"));
  assert.doesNotMatch(install, /createProject/);
  assert.match(page, /function databaseReady\(\) \{\n  \$\('google-redirect'\)\.textContent/);
});
test('a retried database creation reuses the first attempt instead of failing', async () => {
  const saved = globalThis.fetch; const posts = [];
  globalThis.fetch = async (u, o = {}) => {
    if (o.method === 'POST') posts.push(String(u));
    const body = String(u).includes('/projects') ? [{ name: 'Acme Colony', organization_slug: 'org1', ref: 'abcdefghijkl' }] : {};
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const out = await install._test.actions.createProject({ supabaseToken: 's', org: 'org1', region: 'x', companyName: 'Acme', adminEmail: 'a@example.org' });
    assert.equal(out.ref, 'abcdefghijkl');
    assert.deepEqual(posts, []);
  } finally { globalThis.fetch = saved; }
});
