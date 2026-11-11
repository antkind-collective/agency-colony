// The browser installer's back end (install.html). It stores nothing: the
// owner's Netlify and Supabase tokens arrive with each request and are dropped
// when it ends. Every action first proves the Netlify token owns THIS site, so
// a stranger who finds the page can do nothing.
const { randomBytes, createSign } = require('node:crypto');
const { identityFrom, applyIdentity, PLACEHOLDER_PREFIX } = require('./lib/identity');
const core = require('./lib/install-core');

const NETLIFY = 'https://api.netlify.com/api/v1';
const SUPABASE = 'https://api.supabase.com/v1';
const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

class Stop extends Error { constructor(message, status = 400, extra = {}) { super(message); this.status = status; this.extra = extra; } }

async function call(base, token, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(9000)
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { message: text.slice(0, 200) }; }
  if (res.status === 429) throw new Stop('Busy, retrying.', 429, { retry: true });
  return { ok: res.ok, status: res.status, data };
}
const netlify = (t, p, o) => call(NETLIFY, t, p, o);
const supabase = (t, p, o) => call(SUPABASE, t, p, o);

async function must(promise, what) {
  const r = await promise;
  if (!r.ok) throw new Stop(`${what} (${r.data?.message || r.data?.error || `HTTP ${r.status}`})`, 502);
  return r.data;
}

async function ownedSite(token, host) {
  if (!token) throw new Stop('Paste your Netlify token first.', 401);
  const r = await netlify(token, `/sites/${encodeURIComponent(host)}`);
  if (!r.ok) throw new Stop("That Netlify token doesn't own this site. Use a token from the account that deployed it.", 403);
  return r.data;
}

function refOf(body) {
  if (!core.PROJECT_REF.test(String(body.ref || ''))) throw new Stop('Unknown database project.');
  return body.ref;
}

// All at once: one at a time could outlast the function's time limit.
async function setEnv(site, token, env) {
  await Promise.all(Object.entries(env).map(async ([key, value]) => {
    const payload = { key, values: [{ value: String(value), context: 'all' }] };
    const path = `/accounts/${site.account_id}/env`;
    const put = await netlify(token, `${path}/${encodeURIComponent(key)}?site_id=${site.id}`, { method: 'PUT', body: payload });
    if (put.ok) return;
    await must(netlify(token, `${path}?site_id=${site.id}`, { method: 'POST', body: [payload] }), `Couldn't save ${key} on Netlify`);
  }));
}

const rebuild = (site, token) => must(netlify(token, `/sites/${site.id}/builds`, { method: 'POST', body: {} }), "Couldn't start the rebuild on Netlify");

const b64url = (b) => Buffer.from(b).toString('base64url');
async function testGoogle(values) {
  const sa = JSON.parse(core.compactServiceAccount(values.keyFile));
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: sa.client_email, sub: values.adminEmail, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 300,
    scope: 'https://www.googleapis.com/auth/admin.directory.user'
  }))}`;
  let sig;
  try { sig = createSign('RSA-SHA256').update(head).sign(sa.private_key, 'base64url'); } catch (e) { throw new Stop('The private key in that file is damaged. Download a new one.'); }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${sig}` }),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Stop("Google refused. Check the Client ID and scopes were added under Domain-wide delegation, and that the admin email is a super-admin. Google can take a few minutes to apply them.");
}

async function testIntegration(id, values) {
  core.requireFields(id, values);
  const opts = { signal: AbortSignal.timeout(8000) };
  if (id === 'email') {
    const r = await fetch('https://api.resend.com/domains', { ...opts, headers: { Authorization: `Bearer ${values.apiKey}` } });
    const body = await r.json().catch(() => ({}));
    // A send-only key can't list domains, and that still proves it is real.
    if (!r.ok && body?.name !== 'restricted_api_key') throw new Stop('Resend refused that key.');
  } else if (id === 'ai') {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=1', { ...opts, headers: { 'x-api-key': values.apiKey, 'anthropic-version': '2023-06-01' } });
    if (!r.ok) throw new Stop('Anthropic refused that key.');
  } else if (id === 'slack') {
    const r = await fetch('https://slack.com/api/auth.test', { ...opts, method: 'POST', headers: { Authorization: `Bearer ${values.token}` } });
    const body = await r.json().catch(() => ({}));
    if (!body.ok) throw new Stop('Slack refused that token.');
  } else if (id === 'papersign') {
    const r = await fetch('https://api.paperform.co/v1/papersign/folders', { ...opts, headers: { Authorization: `Bearer ${values.token}`, Accept: 'application/json' } });
    if (r.status === 401 || r.status === 403) throw new Stop('Papersign refused that token.');
  } else if (id === 'google') {
    await testGoogle(values);
  }
}

const bundle = () => require('./lib/migrations-bundle.json');
const CHOSEN_KEYS = ['RESEND_API_KEY', 'ANTHROPIC_API_KEY', 'SLACK_BOT_TOKEN', 'PAPERSIGN_API_TOKEN', 'GOOGLE_SA_JSON'];
const currentEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(SUPABASE_|RESEND_|EMAIL_SENDER|ANTHROPIC_|SLACK_|PAPERSIGN_|GOOGLE_|AGENCY_|APP_BASE_URL|LOGIN_)/.test(k)));

const actions = {
  async connect(b, site) {
    if (!b.supabaseToken && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return { configured: true, enabled: CHOSEN_KEYS.filter((k) => process.env[k]) };
    }
    if (!b.supabaseToken) throw new Stop('Paste your Supabase token first.', 401);
    const orgs = await supabase(b.supabaseToken, '/organizations');
    if (!orgs.ok) throw new Stop('Supabase refused that token.', 403);
    return { configured: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY), siteUrl: site.ssl_url, orgs: orgs.data.map((o) => ({ slug: o.slug || o.id, name: o.name })), enabled: CHOSEN_KEYS.filter((k) => process.env[k]) };
  },
  async test(b) { await testIntegration(b.id, b.values); return { ok: true }; },
  async createProject(b) {
    identityFrom(b);
    const name = `${String(b.companyName).trim().slice(0, 40)} Colony`;
    // Supabase can take longer than one request allows, and the page then asks
    // again. Reuse what the first attempt made instead of failing on the name.
    const projects = await must(supabase(b.supabaseToken, '/projects'), "Couldn't read your Supabase projects");
    const existing = projects.find((p) => p.name === name && (p.organization_slug === b.org || p.organization_id === b.org));
    if (existing) return { ref: existing.ref || existing.id };
    const data = await must(supabase(b.supabaseToken, '/projects', { method: 'POST', body: {
      name, organization_slug: b.org, region: b.region, db_pass: randomBytes(24).toString('base64url')
    } }), "Couldn't create the database. Supabase's free plan allows 2 projects per organization");
    return { ref: data.ref || data.id };
  },
  async projectStatus(b) {
    const data = await must(supabase(b.supabaseToken, `/projects/${refOf(b)}`), "Couldn't check the database");
    return { ready: data.status === 'ACTIVE_HEALTHY', status: data.status };
  },
  async prepare(b) {
    const ref = refOf(b);
    const q = (query) => must(supabase(b.supabaseToken, `/projects/${ref}/database/query`, { method: 'POST', body: { query } }), 'The database refused the setup');
    await q('create schema if not exists colony_install; create table if not exists colony_install.applied (name text primary key, at timestamptz not null default now()); revoke all on schema colony_install from public, anon, authenticated;');
    const done = new Set((await q('select name from colony_install.applied')).map((r) => r.name));
    const all = Object.keys(bundle()).sort();
    return { total: all.length, pending: all.filter((n) => !done.has(n)) };
  },
  // One file per request. Files must not share a transaction: a later one can
  // use an enum value an earlier one added, which Postgres refuses.
  async migrate(b, site, host) {
    const ref = refOf(b);
    const sql = bundle()[b.name];
    if (sql === undefined) throw new Stop('Unknown migration.');
    const id = identityFrom({ ...b, host, supabaseHost: `${ref}.supabase.co` });
    const query = `${applyIdentity(sql, id)}\n;insert into colony_install.applied(name) values (${core.sqlText(b.name)}) on conflict do nothing;`;
    const run = (q) => supabase(b.supabaseToken, `/projects/${ref}/database/query`, { method: 'POST', body: { query: q } });
    const res = await run(query);
    if (!res.ok) {
      // A retry of a step that did finish, after the first reply was lost.
      const done = await run(`select 1 as done from colony_install.applied where name = ${core.sqlText(b.name)}`);
      if (!(done.ok && done.data.length)) throw new Stop(`Database step ${b.name} failed (${res.data?.message || `HTTP ${res.status}`})`, 502);
    }
    return { ok: true };
  },
  async finish(b, site, host) {
    const ref = refOf(b);
    const id = identityFrom({ ...b, host, supabaseHost: `${ref}.supabase.co` });
    core.validateLogin(b.login, b.integrations);
    const siteUrl = site.ssl_url || `https://${host}`;
    const featureEnv = core.envForIntegrations(b.integrations);
    await must(supabase(b.supabaseToken, `/projects/${ref}/postgrest`, { method: 'PATCH', body: { db_schema: 'public, graphql_public, app' } }), "Couldn't open the app's tables to the API");
    await must(supabase(b.supabaseToken, `/projects/${ref}/config/auth`, { method: 'PATCH', body: core.authConfig({ siteUrl, login: b.login, email: b.integrations?.email }) }), "Couldn't set up sign-in");
    // Example staff from the seed data, on a database created minutes ago.
    // Delete, not deactivate: the access triggers put is_active back when
    // there is no signed-in superadmin.
    await must(supabase(b.supabaseToken, `/projects/${ref}/database/query`, { method: 'POST', body: { query: `update app.departments set approver_email = ${core.sqlText(id.adminEmail)} where approver_email like '${PLACEHOLDER_PREFIX}%'; delete from app.employees where email like '${PLACEHOLDER_PREFIX}%';` } }), "Couldn't clear the example staff");
    const keys = await must(supabase(b.supabaseToken, `/projects/${ref}/api-keys?reveal=true`), "Couldn't read the database keys");
    const anon = keys.find((k) => k.name === 'anon')?.api_key;
    const service = keys.find((k) => k.name === 'service_role')?.api_key;
    if (!anon || !service) throw new Stop("Supabase didn't return this project's keys.", 502);
    const env = {
      SUPABASE_URL: `https://${ref}.supabase.co`, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: service,
      APP_BASE_URL: siteUrl, AGENCY_ADMIN_EMAIL: id.adminEmail, AGENCY_NAME: id.name,
      LOGIN_GOOGLE: b.login.google ? '1' : '0', LOGIN_EMAIL: b.login.emailLink ? '1' : '0', ...featureEnv
    };
    core.assertEnvFits({}, env);
    await setEnv(site, b.netlifyToken, env);
    await rebuild(site, b.netlifyToken);
    return { siteUrl, webhookKey: featureEnv.PAPERSIGN_WEBHOOK_KEY || null };
  },
  // Adding a feature later: paste, test, save.
  async saveIntegrations(b, site) {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Stop('Finish the install first.');
    const env = core.envForIntegrations(b.integrations);
    core.assertEnvFits(currentEnv(), env);
    await setEnv(site, b.netlifyToken, env);
    await rebuild(site, b.netlifyToken);
    return { ok: true };
  },
  async buildStatus(b, site) {
    const deploys = await must(netlify(b.netlifyToken, `/sites/${site.id}/deploys?per_page=1`), "Couldn't check the build");
    return { state: deploys[0]?.state || 'unknown' };
  }
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only.' });
  try {
    const b = JSON.parse(event.body || '{}');
    const host = String(event.headers?.host || '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(actions, b.action)) throw new Stop('Unknown action.');
    const site = await ownedSite(b.netlifyToken, host);
    return json(200, await actions[b.action](b, site, host));
  } catch (e) {
    if (e instanceof Stop) return json(e.status, { error: e.message, ...e.extra });
    if (e?.name === 'TimeoutError') return json(429, { error: 'Busy, retrying.', retry: true });
    return json(400, { error: e.message || 'Something went wrong.' });
  }
};
exports._test = { actions, testIntegration, Stop };
