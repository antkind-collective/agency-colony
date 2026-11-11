// Google Group membership for new @youragency.com accounts (21 Sep 2026:
// "make sure that all of the users that get added also get added to the
// all@youragency.com mailing list").
//
// Needs the service account's domain-wide delegation to include
//   https://www.googleapis.com/auth/admin.directory.group.member
// alongside the Directory user scope. Without it the token exchange fails with
// "unauthorized_client"; callers report that and the daily sync retries, so a
// hire created before the scope was granted is picked up once it is.

const GROUP_MEMBER_SCOPE = 'https://www.googleapis.com/auth/admin.directory.group.member';

function allGroupAddress() {
  return (process.env.WORKSPACE_ALL_GROUP || 'all@youragency.com').trim().toLowerCase();
}

// Adds one address. "Already a member" is success, not an error: the sync
// retries, and someone may have added them by hand.
//
// Only a @youragency.com address is ever added (security audit 23 Sep 2026): the
// address comes from hires.work_email, which the whole hiring crew can edit,
// and all@youragency.com is the all-staff list — an outside address on it would
// receive every internal all-hands mail. The DB constraint
// hires_work_email_youragency says the same thing; this is the second layer.
const AGENCY_ADDRESS = /^[a-z0-9._-]+@youragency\.com$/i;

async function addGroupMember(access, groupKey, email, fetchImpl = fetch) {
  if (!AGENCY_ADDRESS.test(String(email || '').trim())) {
    return { ok: false, status: 0, error: `refused: ${email} is not a @youragency.com address` };
  }
  const res = await fetchImpl(`https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(groupKey)}/members`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, role: 'MEMBER' })
  });
  if (res.ok) return { ok: true, already: false };
  const err = await res.json().catch(() => ({}));
  const message = err?.error?.message || `HTTP ${res.status}`;
  if (res.status === 409 || /member already exists/i.test(message)) return { ok: true, already: true };
  return { ok: false, status: res.status, error: message };
}

// Every member address of a group, following pages. Lower-cased.
async function listGroupMembers(access, groupKey, fetchImpl = fetch) {
  const out = [];
  let pageToken = '';
  do {
    const url = `https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(groupKey)}/members?maxResults=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${access}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
    (body.members || []).forEach((m) => { if (m.email) out.push(String(m.email).toLowerCase()); });
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return out;
}

// What an approver should read when the add fails, in plain words.
function groupFailureNote(email, error) {
  const group = allGroupAddress();
  if (/unauthorized_client|not authorized|insufficient/i.test(String(error))) {
    return `${email} was not added to ${group}: Colony is not yet allowed to manage group members in Google Admin. It will retry daily once that is granted.`;
  }
  return `${email} was not added to ${group} (${error}). Colony will retry daily.`;
}

module.exports = { AGENCY_ADDRESS, GROUP_MEMBER_SCOPE, allGroupAddress, addGroupMember, listGroupMembers, groupFailureNote };
