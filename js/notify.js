/* ── Your Agency notifications: pure action-item builder ──
   Classic script — loads after utils.js, before app.js. PURE ONLY.
   v1 philosophy: notifications are COMPUTED from live data, not stored —
   an item exists exactly while the underlying action is needed (approving a
   leave makes it vanish). No table, no read-state. First source: pending
   leave approvals routed to the signed-in user via approver_emails.
   Future sources slot in here (analytics due, invoice missing, policy ack). */

// approver_emails arrives as a JSON array via PostgREST, but tolerate the
// raw Postgres '{a@x,b@y}' string form too.
function approverEmailList(value) {
  if (Array.isArray(value)) return value.map(normalizeEmail);
  return String(value || '')
    .replace(/^\{|\}$/g, '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);
}

// Days between two ISO dates (b - a).
function daysBetweenIso(aIso, bIso) {
  const a = parseIsoDateLocal(String(aIso || '').slice(0, 10));
  const b = parseIsoDateLocal(String(bIso || '').slice(0, 10));
  if (!a || !b) return 0;
  return Math.round((b - a) / 86400000);
}

// ctx: { myEmail, myEmployeeId, isSuperadmin, leaveRows, todayIso,
//        signals: { invoiceDue, policyAckPending, featureReplies } }
// Returns [{ key, icon, text, detail, screen }]. Sources (all personal):
//  1. pending approvals routed to me        4. my invoice missing (25th→eom)
//  2. my own leave decided (last 3 days)    5. policy ack pending
//  3. superadmin escalation: any approval   6. replies to my board requests
//     waiting >7d (not already mine)           (last 14d, loader-filtered)
function buildActionItems({ myEmail, myEmployeeId, isSuperadmin, leaveRows, todayIso, signals }) {
  const me = normalizeEmail(myEmail);
  if (!me) return [];
  const items = [];
  const s = signals || {};

  for (const lr of leaveRows || []) {
    const empName = (lr.employee?.full_name || 'Someone').split(' ')[0];
    // 2. my own decided leave, informational, auto-expires after 3 days
    if (myEmployeeId && lr.employee_id === myEmployeeId && lr.decided_at &&
        (lr.status === 'approved' || lr.status === 'rejected') &&
        daysBetweenIso(lr.decided_at, todayIso) <= 3) {
      const ok = lr.status === 'approved';
      items.push({
        key: `decided-${lr.id}-${lr.status}`,
        icon: ok ? '✅' : '❌',
        text: `Your ${lr.leave_type || 'leave'} (${formatDateForLabel(lr.start_date)}) was ${lr.status}`,
        detail: 'tap to view your leave',
        screen: 'leave-center',
        sortKey: lr.decided_at
      });
      continue;
    }
    if (lr.status !== 'pending') continue;
    const routedToMe = approverEmailList(lr.approver_emails).includes(me);
    const waitedDays = daysBetweenIso(String(lr.created_at || '').slice(0, 10), todayIso);
    // 3. superadmin escalation for anything stuck >7 days
    if (!routedToMe && isSuperadmin && waitedDays > 7) {
      items.push({
        key: `escalation-${lr.id}`,
        icon: '⏰',
        text: `Escalation: ${empName}'s ${lr.leave_type || 'leave'} stuck ${waitedDays} days`,
        detail: `approver: ${approverEmailList(lr.approver_emails).join(', ') || 'unset'}`,
        screen: 'leave-center',
        sortKey: lr.created_at || ''
      });
      continue;
    }
    if (!routedToMe) continue;
    const name = (lr.employee?.full_name || 'Someone').split(' ')[0];
    const sick = lr.leave_type === 'SL';
    const submitted = String(lr.created_at || '').slice(0, 10);
    let waited = '';
    if (submitted && todayIso) {
      const days = Math.max(0, Math.round((parseIsoDateLocal(todayIso) - parseIsoDateLocal(submitted)) / 86400000));
      waited = days === 0 ? 'submitted today' : `waiting ${days} day${days > 1 ? 's' : ''}`;
    }
    items.push({
      key: `leave-${lr.id}`,
      icon: sick ? '🤒' : '🏖️',
      text: `Approve ${name}'s ${lr.leave_type || 'leave'} — ${formatDateForLabel(lr.start_date)}${lr.is_half_day ? ' (½ day)' : ''}`,
      detail: `${waited}${waited ? ' · ' : ''}tap to open approvals`,
      screen: 'leave-center',
      sortKey: lr.created_at || ''
    });
  }
  // 4. my invoice missing during the 25th→month-end window (nags until uploaded)
  if (s.invoiceDue) {
    items.push({
      key: `invoice-${String(todayIso || '').slice(0, 7)}`,
      icon: '🧾',
      text: 'Your invoice for this month is missing',
      detail: 'upload before month-end · tap to open Invoice Center',
      screen: 'invoice-center',
      sortKey: 'zz1'
    });
  }
  // 5. policy acknowledgment pending
  if (s.policyAckPending) {
    items.push({
      key: 'policy-ack-remote_working_policy',
      icon: '📋',
      text: 'Remote Work Policy needs your acknowledgment',
      detail: 'tap to read and acknowledge',
      screen: 'policy',
      sortKey: 'zz2'
    });
  }
  // 7. new joiners awaiting setup (approvers only — the loader supplies rows
  //    only to Alex/Nadia). Sorts FIRST: a project-based person is locked out
  //    of every client until this is actioned, so it must not sit below a
  //    fortnight-old board reply. Vanishes the moment they're activated —
  //    computed, never stored, so it can't rot into a stale to-do.
  for (const p of s.pendingSetups || []) {
    const who = String(p.fullName || 'A new joiner').split(' ')[0];
    const blocked = employmentIsScoped(p.employmentType);
    items.push({
      key: `setup-pending-${p.id}`,
      icon: blocked ? '🔒' : '🧑‍💼',
      text: `Set up ${who} — ${employmentTypeLabel(p.employmentType).toLowerCase()}, awaiting approval`,
      detail: blocked
        ? `no client access until activated${p.requestedTeam ? ` · asked for ${p.requestedTeam}` : ''}`
        : `confirm their team${p.requestedTeam ? ` (asked for ${p.requestedTeam})` : ''}`,
      screen: 'admin-settings',
      anchor: 'pendingSetupPanel',
      sortKey: `!${p.createdAt || ''}`
    });
  }
  // 8. brief pipeline (the client Brief Tracking). Counts in keys so a changed count
  //    re-alerts; zero counts emit nothing (computed, never stored).
  if (s.briefsAwaitingReview) {
    items.push({
      key: `briefs-review-${s.briefsAwaitingReview}`,
      icon: '📝',
      text: `${s.briefsAwaitingReview} the client brief${s.briefsAwaitingReview > 1 ? 's' : ''} ready for review`,
      detail: 'tap to open the briefs board',
      screen: 'briefs-pipeline',
      sortKey: 'zz3'
    });
  }
  if (s.briefQuickOpen) {
    items.push({
      key: `briefs-quick-${s.briefQuickOpen}`,
      icon: '📣',
      text: `${s.briefQuickOpen} quick request${s.briefQuickOpen > 1 ? 's' : ''} from the client to acknowledge`,
      detail: 'tap to open the briefs board',
      screen: 'briefs-pipeline',
      sortKey: 'zz3'
    });
  }
  if (s.briefOverdue) {
    items.push({
      key: `briefs-overdue-${s.briefOverdue}`,
      icon: '⏰',
      text: `${s.briefOverdue} brief deliverable${s.briefOverdue > 1 ? 's are' : ' is'} past SLA`,
      detail: 'tap to open the briefs board',
      screen: 'briefs-pipeline',
      sortKey: 'zz3'
    });
  }
  if (s.briefAssignedToMe) {
    items.push({
      key: `briefs-mine-${s.briefAssignedToMe}`,
      icon: '🎨',
      text: `${s.briefAssignedToMe} brief deliverable${s.briefAssignedToMe > 1 ? 's' : ''} assigned to you`,
      detail: 'tap to open the briefs board',
      screen: 'briefs-pipeline',
      sortKey: 'zz3'
    });
  }
  // 9. hiring pipeline — hires at a stage that's waiting on ME.
  if (s.hiresMyTurn) {
    items.push({
      key: `hires-turn-${s.hiresMyTurn}`,
      icon: '🧑‍💼',
      text: `${s.hiresMyTurn} hire${s.hiresMyTurn > 1 ? 's' : ''} waiting on you`,
      detail: 'tap to open Hiring in Team Directory',
      screen: 'people-directory',
      anchor: 'hiringPanel',
      sortKey: '!hiring'
    });
  }
  // 6. replies to MY board requests (loader supplies last-14-days, not-mine)
  for (const fr of s.featureReplies || []) {
    const who = String(fr.replierName || 'Someone').split(' ')[0];
    const excerpt = String(fr.requestText || '').replace(/\s+/g, ' ').trim().slice(0, 44);
    items.push({
      key: `feature-reply-${fr.id}`,
      icon: '💬',
      text: `${who} replied to your "${excerpt}${String(fr.requestText || '').trim().length > 44 ? '…' : ''}"`,
      detail: 'tap to open the bugs & features board',
      screen: 'feature-requests',
      sortKey: fr.createdAt || ''
    });
  }
  items.sort((a, b) => String(a.sortKey).localeCompare(String(b.sortKey)));
  return items;
}

// Unseen = items whose key isn't in the seen set (panel-open marks all seen).
function countUnseenItems(items, seenKeys) {
  const seen = seenKeys instanceof Set ? seenKeys : new Set(seenKeys || []);
  return (items || []).filter(i => !seen.has(i.key)).length;
}
