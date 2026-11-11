// Joiner Slack check (7 Oct 2026) — pure logic, no network.
//
// A hire counts as "on Slack" when their @youragency.com address belongs to a
// Slack member who is in BOTH company channels. Slack is the source of truth;
// nobody ticks it by hand. The channels are Slack default channels, so joining
// the workspace normally puts them in both.

// Channel ids (checked 7 Oct 2026). Override with app_config.joiner_slack_channels.
const CHANNELS = [
  { name: '#youragency-all', id: 'C05UZUL4DD2' },
  { name: '#youragency-random', id: 'C08V5MH9X2B' }
];

function hiresToCheck(hires) {
  // Once activated (8 Oct 2026): that is when the Slack invite goes out.
  return (hires || []).filter((h) => h.work_email && h.activated_at && !h.slack_joined_at && h.stage !== 'cancelled');
}

// Activated, not on Slack yet, never sent the invite.
function hiresToInvite(hires) {
  return hiresToCheck(hires).filter((h) => !h.slack_invited_at);
}

const DOWNLOADS = 'https://slack.com/downloads';

// The Slack invite email (youragency.slack.com takes any @youragency.com address).
function slackInviteEmail(hire, cfg) {
  const name = String(hire.full_name || '').trim().split(/\s+/)[0] || 'there';
  const channels = cfg.slackChannels.join(' and ');
  const host = cfg.slackUrl.replace(/^https:\/\//, '');
  const lines = [
    `Hi ${name},`,
    `Your Colony access is on. One more thing: join the team on Slack.`,
    `Go to ${host} and sign in with your Your Agency Google account, ${hire.work_email}. You'll land in ${channels}, where the whole team talks.`,
    // Most of the team lives in the apps, not the browser (30 Oct 2026).
    `Then install Slack on your computer from ${DOWNLOADS.replace(/^https:\/\//, '')} and on your phone from the App Store or Google Play, and sign in to both with the same account, so you see messages without keeping a tab open.`,
    `See you there,`,
    `Your Agency`
  ];
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.6;max-width:560px">${lines.map((l) => `<p>${l
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(host, `<a href="${cfg.slackUrl}">${host}</a>`)
    .replace(DOWNLOADS.replace(/^https:\/\//, ''), `<a href="${DOWNLOADS}">${DOWNLOADS.replace(/^https:\/\//, '')}</a>`)}</p>`).join('')}</div>`;
  return { subject: `Join Your Agency on Slack, ${name}`, html, text: lines.join('\n\n') };
}

// memberSets: [Set(userIds) per channel]
function inAllChannels(userId, memberSets) {
  return Boolean(userId) && memberSets.length > 0 && memberSets.every((s) => s.has(userId));
}

module.exports = { CHANNELS, hiresToCheck, hiresToInvite, slackInviteEmail, inAllChannels };
