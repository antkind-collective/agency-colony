// Out of Google Workspace licences (7 Oct 2026): Colony asks the
// reseller for one by itself and keeps retrying the account, instead of
// stopping at "Google refused" and waiting for someone to notice.
//
// The reseller's people mirror js/config.js (WORKSPACE_VENDOR_*); app_config
// 'workspace_vendor' ({to, cc, greeting}) overrides without a deploy.
const VENDOR = {
  to: 'reseller@example.com',
  cc: ['reseller-2@example.com', 'reseller-support@example.com', 'am-lead@youragency.com', 'admin@youragency.com'],
  greeting: 'Kay'
};
// Replies go to a person, not to Colony's noreply sender.
const REPLY_TO = 'admin@youragency.com';
// Ask again only if this long has passed with no account.
const ASK_AGAIN_AFTER_MS = 3 * 86400000;

function isLicenceError(message) {
  return /insufficient licen[cs]es?|licen[cs]e.*(exceed|not available|unavailable)/i.test(String(message || ''));
}

function shouldAsk(requestedAtIso, now = new Date()) {
  if (!requestedAtIso) return true;
  return now.getTime() - Date.parse(requestedAtIso) >= ASK_AGAIN_AFTER_MS;
}

function licenceRequestEmail(hire, vendor = VENDOR) {
  const first = String(hire.full_name || 'a new joiner').split(' ')[0];
  const start = hire.start_date
    ? new Date(`${hire.start_date}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
    : null;
  const text = `Hi ${vendor.greeting || 'there'},\n\n`
    + `Could you please add one more Google Workspace licence to youragency.com? We're out of free seats, and Google is refusing to create a new user for ${first}${start ? `, who joins on ${start}` : ''}.\n\n`
    + `We'll create the account ourselves once the seat is there, so we just need the licence.\n\n`
    + `Best,\nAlex`;
  const html = text.split('\n\n').map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`).join('');
  return { subject: 'One more Google Workspace licence for youragency.com', text, html };
}

module.exports = { VENDOR, REPLY_TO, ASK_AGAIN_AFTER_MS, isLicenceError, shouldAsk, licenceRequestEmail };
