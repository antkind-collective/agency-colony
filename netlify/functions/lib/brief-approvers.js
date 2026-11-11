// Who approves a brief on the client side. `briefs.approver_name` is the name
// picked on the request form from the org's contacts ("Nina", "Mira
// Holt", "Nina, Mira"), or typed by hand under "Other". Rhea enters
// most briefs herself on the client's behalf, so "whoever submitted it" is usually
// her, not the client (21 Oct 2026): mail goes to the approvers.
//
// A name matches a contact on their full name or their first name. No match
// (blank, or a typed name nobody has a login for) falls back to the org's
// coordinators, who already get every other brief update.
function approverRecipients(approverName, partners) {
  const names = String(approverName || '')
    .split(/,|&|\band\b/i)
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  const matched = [];
  for (const name of names) {
    const hit = partners.find((p) => {
      const full = String(p.full_name || '').trim().toLowerCase();
      return full && (full === name || full.split(/\s+/)[0] === name);
    });
    if (hit && !matched.includes(hit)) matched.push(hit);
  }
  if (matched.length) return matched;
  return partners.filter((p) => p.partner_role === 'coordinator');
}

// "21 Oct" for a yyyy-mm-dd date, read as a calendar day (no timezone shift).
function shortDate(iso) {
  const d = new Date(`${String(iso || '').slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

module.exports = { approverRecipients, shortDate };
