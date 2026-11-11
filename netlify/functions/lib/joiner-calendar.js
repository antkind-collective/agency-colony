// Joiner meetings (7 Oct 2026) — pure logic, no Google, no Supabase.
//
// Once a hire's Colony access is switched on (hires.activated_at, set when the
// hiring manager activates them — 8 Oct 2026; it used to be their first
// sign-in), Colony adds them as a guest to the recurring All
// Hands and Thirsty Thursday series in Alex's calendar (she organises both),
// with sendUpdates=none: nobody else is emailed, and the meetings simply
// appear on the joiner's calendar.

// The recurring series (checked in Alex's calendar, 7 Oct 2026). Override with
// app_config.joiner_calendar_events: [{ name, eventId }].
const SERIES = [
  { name: 'All Hands', eventId: '15s8fk1pa7q2dhrvuf2sq3hlm8_R20261005T050000' },
  { name: 'Thirsty Thursday', eventId: '7qiuibigh3iuc33cm99p7r7msk_R20261008T120000' }
];

// Hires to add now: activated, not added yet.
function joinersToAdd(hires) {
  return (hires || []).filter((h) => h.work_email && h.activated_at && !h.calendar_added_at && h.stage !== 'cancelled');
}

// The attendee list with this email added, or null when already there.
function withAttendee(attendees, email) {
  const list = Array.isArray(attendees) ? attendees : [];
  const e = String(email).toLowerCase();
  if (list.some((a) => String(a.email || '').toLowerCase() === e)) return null;
  return [...list, { email: e }];
}

module.exports = { SERIES, joinersToAdd, withAttendee };
