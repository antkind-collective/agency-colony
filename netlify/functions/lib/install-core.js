// The installer's decisions, kept free of network calls so they can be tested.
const { randomBytes } = require('node:crypto');

// Each optional feature: what it asks for, and what it writes. A feature nobody
// ticks asks for nothing and writes nothing; Colony falls back without it.
const INTEGRATIONS = {
  email: {
    label: 'Email', fields: ['apiKey', 'sender'],
    env: (v) => ({ RESEND_API_KEY: v.apiKey, EMAIL_SENDER: v.sender })
  },
  ai: { label: 'AI summaries', fields: ['apiKey'], env: (v) => ({ ANTHROPIC_API_KEY: v.apiKey }) },
  slack: { label: 'Slack', fields: ['token'], env: (v) => ({ SLACK_BOT_TOKEN: v.token }) },
  papersign: {
    label: 'Papersign', fields: ['token'],
    env: (v) => ({ PAPERSIGN_API_TOKEN: v.token, PAPERSIGN_WEBHOOK_KEY: v.webhookKey || randomBytes(24).toString('hex') })
  },
  google: {
    label: 'Google Workspace', fields: ['keyFile', 'adminEmail'],
    env: (v) => ({ GOOGLE_SA_JSON: compactServiceAccount(v.keyFile), GOOGLE_ADMIN_IMPERSONATE: v.adminEmail })
  }
};

// A downloaded key file is over Netlify's 4KB limit per variable. Colony only
// needs these two fields.
function compactServiceAccount(raw) {
  let sa;
  try { sa = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { throw new Error("That isn't a Google key file. Upload the .json file Google gave you."); }
  if (!sa?.client_email || !sa?.private_key) throw new Error("That key file is missing client_email or private_key. Upload the .json file Google gave you.");
  return JSON.stringify({ client_email: sa.client_email, private_key: sa.private_key });
}

function requireFields(id, values) {
  const def = INTEGRATIONS[id];
  if (!def) throw new Error('Unknown feature.');
  for (const f of def.fields) {
    if (!values || !String(values[f] ?? '').trim()) throw new Error(`${def.label}: fill in every field first.`);
  }
  return def;
}

// Only what was chosen. Empty values never reach the host's settings.
function envForIntegrations(chosen) {
  const env = {};
  for (const [id, values] of Object.entries(chosen || {})) {
    if (!values) continue;
    Object.assign(env, requireFields(id, values).env(values));
  }
  return env;
}

// Pasting can bring extras along (a stray https:// and slash broke a real
// sign-in with "OAuth client was not found"), so keep only the ID itself.
function googleClientId(raw) {
  const match = String(raw || '').match(/\d+-[a-z0-9]+\.apps\.googleusercontent\.com/i);
  if (!match) throw new Error("That Client ID doesn't look right. It should end in .apps.googleusercontent.com.");
  return match[0];
}

function validateLogin(login, chosen) {
  const google = login?.google;
  if (!google && !login?.emailLink) throw new Error('Pick at least one way for people to sign in.');
  if (google && (!String(google.clientId || '').trim() || !String(google.clientSecret || '').trim())) {
    throw new Error('Google sign-in needs both the Client ID and the Client secret.');
  }
  if (google) googleClientId(google.clientId);
  if (login?.emailLink && !chosen?.email) throw new Error('Email sign-in links need the Email feature, so Colony can send them.');
}

// What Supabase's sign-in settings should be for this site.
function authConfig({ siteUrl, login, email }) {
  const cfg = {
    site_url: siteUrl,
    // Only this site. Never a wildcard over netlify.app: anyone can host one.
    uri_allow_list: `${siteUrl}/**`,
    external_google_enabled: Boolean(login.google),
    external_email_enabled: Boolean(login.emailLink)
  };
  if (login.google) {
    cfg.external_google_client_id = googleClientId(login.google.clientId);
    cfg.external_google_secret = login.google.clientSecret.trim();
  }
  if (email?.apiKey) {
    Object.assign(cfg, {
      smtp_host: 'smtp.resend.com', smtp_port: '465', smtp_user: 'resend', smtp_pass: email.apiKey,
      smtp_admin_email: email.sender, smtp_sender_name: 'Colony', rate_limit_email_sent: 30
    });
  }
  return cfg;
}

// AWS caps a function's whole environment at 4KB, and one over-limit deploy
// fails with an error that names nothing.
const ENV_BUDGET = 3800;
function assertEnvFits(existing, next) {
  const all = { ...existing, ...next };
  const size = Object.entries(all).reduce((n, [k, v]) => n + k.length + String(v).length, 0);
  if (size > ENV_BUDGET) throw new Error(`These settings are too large for Netlify (${size} of ${ENV_BUDGET} characters). Turn off a feature and try again.`);
}

const sqlText = (s) => `'${String(s).replace(/'/g, "''")}'`;
const PROJECT_REF = /^[a-z0-9]{10,40}$/;

module.exports = { INTEGRATIONS, googleClientId, compactServiceAccount, requireFields, envForIntegrations, validateLogin, authConfig, assertEnvFits, sqlText, PROJECT_REF };
