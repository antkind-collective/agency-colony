// Turns the placeholders in this repo into one agency's real details. Used by
// the build (app files) and the installer (database migrations), so a person
// deploying Colony never edits code.
//
// Only the owner's address becomes real. Every other placeholder (finance@,
// creative-lead@ ...) becomes unassigned-finance@ on their domain. Those lists
// grant access, so plain "finance@theirdomain" might be a real colleague;
// pointing them all at the owner would make `{ owner: 'admin', owner:
// 'leadership' }` silently demote the owner; and the database insists staff
// addresses are on the company domain, so a fake domain won't install.
const PLACEHOLDER_PREFIX = 'unassigned-';
const KEEP_ON_DOMAIN = new Set(['noreply', 'all', 'name', 'firstname']);

const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com',
  'pm.me', 'zoho.com', 'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'fastmail.com', 'hey.com', 'rediffmail.com']);

function identityFrom({ adminEmail, companyName, host, supabaseHost }) {
  const email = String(adminEmail || '').trim().toLowerCase();
  const match = email.match(/^[^\s@]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/);
  if (!match) throw new Error('Enter a valid work email address.');
  const domain = match[1];
  // Everyone at the domain counts as staff, so a shared mail provider would
  // let any stranger with a free account in.
  if (FREE_MAIL.has(domain)) throw new Error(`Use an address on your company's own domain, with any email provider. Anyone with a ${domain} address would count as your staff. No domain? See CUSTOMIZE.md in your GitHub repo.`);
  const name = String(companyName || '').trim().replace(/[<>"'`\\$]/g, '');
  if (!name) throw new Error('Enter your company name.');
  return { adminEmail: email, domain, name, host: host || `app.${domain}`, supabaseHost: supabaseHost || '' };
}

function applyIdentity(text, id) {
  const esc = (s) => s.replace(/\./g, '\\.');
  let t = String(text);
  // Hosts first, plain and regex-escaped.
  for (const sub of ['app', 'clients']) {
    t = t.split(`${sub}\\.youragency\\.com`).join(esc(id.host)).split(`${sub}.youragency.com`).join(id.host);
  }
  if (id.supabaseHost) t = t.split('your-project.supabase.co').join(id.supabaseHost);
  // Full addresses.
  t = t.replace(/([A-Za-z0-9._+-]+)@youragency(\\?)\.com/g, (all, local, slash) => {
    const dot = (s) => (slash ? esc(s) : s);
    if (local === 'admin') return dot(id.adminEmail);
    if (KEEP_ON_DOMAIN.has(local)) return `${local}@${dot(id.domain)}`;
    return `${PLACEHOLDER_PREFIX}${local}@${dot(id.domain)}`;
  });
  // Bare domain ("@youragency.com", hd: 'youragency.com').
  t = t.split('youragency\\.com').join(esc(id.domain)).split('youragency.com').join(id.domain);
  return t.split('Your Agency').join(id.name);
}

module.exports = { identityFrom, applyIdentity, PLACEHOLDER_PREFIX, FREE_MAIL };
