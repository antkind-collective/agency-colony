// Adds new joiners to All Hands and Thirsty Thursday after their first Colony
// sign-in (7 Oct 2026). Hourly; judgement in lib/joiner-calendar.js.
// Needs the Calendar scope on the service account's domain-wide delegation
// (https://www.googleapis.com/auth/calendar.events — added by Alex 7 Oct
// 2026). DRY RUN: ?dry=1.

const { getSupabaseAdmin } = require('./lib/supabase-admin');
const { googleAccessToken } = require('./lib/google-auth');
const { logNotification, withCronHeartbeat } = require('./lib/notifications');
const { SERIES, joinersToAdd, withAttendee } = require('./lib/joiner-calendar');

const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
function json(statusCode, body) { return { statusCode, body: JSON.stringify(body, null, 2) }; }

async function gcal(token, method, eventId, body) {
  const res = await fetch(`${API}/${encodeURIComponent(eventId)}${method === 'PATCH' ? '?sendUpdates=none' : ''}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Calendar ${method} ${eventId}: ${data?.error?.message || res.status}`);
  return data;
}

async function handler(event) {
  const dryRun = event?.queryStringParameters?.dry === '1';
  let isScheduled = false;
  try { isScheduled = Boolean(JSON.parse(event?.body || '{}').next_run); } catch (e) { isScheduled = false; }
  if (!isScheduled) return json(403, { error: 'Scheduled function only' });

  const summary = { dryRun, quiet: true, added: 0, planned: [], errors: [] };
  const supabase = getSupabaseAdmin();
  const [hiresRes, cfgRes] = await Promise.all([
    supabase.from('hires').select('id, full_name, work_email, stage, activated_at, calendar_added_at').is('calendar_added_at', null).not('activated_at', 'is', null).limit(500),
    supabase.from('app_config').select('value').eq('key', 'joiner_calendar_events').maybeSingle()
  ]);
  if (hiresRes.error) { summary.errors.push(hiresRes.error.message); return json(500, summary); }
  const due = joinersToAdd(hiresRes.data || []);
  if (!due.length) return json(200, summary);
  summary.quiet = false;
  const series = Array.isArray(cfgRes.data?.value) && cfgRes.data.value.length ? cfgRes.data.value : SERIES;

  let token;
  try { token = await googleAccessToken(CAL_SCOPE); } catch (e) { summary.errors.push(e.message); return json(500, summary); }

  for (const h of due) {
    summary.planned.push({ joiner: h.full_name, email: h.work_email, meetings: series.map((s) => s.name) });
    if (dryRun) continue;
    let ok = true;
    for (const s of series) {
      try {
        const ev = await gcal(token, 'GET', s.eventId);
        const attendees = withAttendee(ev.attendees, h.work_email);
        if (attendees) await gcal(token, 'PATCH', s.eventId, { attendees });
      } catch (e) { ok = false; summary.errors.push(`${h.full_name} → ${s.name}: ${e.message}`); }
    }
    if (!ok) continue; // retried next hour; partial adds are idempotent
    await supabase.from('hires').update({ calendar_added_at: new Date().toISOString() }).eq('id', h.id);
    await logNotification({ kind: 'hire_notify', recipientEmail: 'system', subject: `joiner meetings: added ${h.work_email}`, status: 'skipped',
      payload: { hire_id: h.id, meetings: series.map((s) => s.name) } }).catch(() => {});
    summary.added += 1;
  }
  return json(200, summary);
}

exports.handler = withCronHeartbeat('joiner-calendar', handler);
