const IST_TIME_ZONE = 'Asia/Kolkata';

function getConfig() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) {
    throw new Error('Missing SUPABASE_URL environment variable.');
  }

  if (!supabaseServiceRoleKey) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY environment variable.');
  }

  return {
    supabaseUrl,
    supabaseServiceRoleKey,
    resendApiKey: process.env.RESEND_API_KEY || '',
    emailSender: process.env.EMAIL_SENDER || 'noreply@youragency.com',
    appBaseUrl: process.env.APP_BASE_URL || 'https://app.youragency.com',
    // Clients live on Circle and cannot sign into Colony at all, so a
    // Colony link in a client's inbox is a dead end. Derived from the Colony
    // URL rather than a second env var: one of the two going stale while the
    // other moved is how you get a link that 404s only for clients.
    circleBaseUrl: (process.env.APP_BASE_URL || 'https://app.youragency.com')
      .replace('app.youragency.com', 'clients.youragency.com')
  };
}

function formatDateInIST(dateInput) {
  const value = dateInput ? new Date(dateInput) : new Date();
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).format(value);
}

function formatDateTimeInIST(dateInput) {
  const value = dateInput ? new Date(dateInput) : new Date();
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(value);
}

const DEFAULT_TIME_ZONE = IST_TIME_ZONE;

// Wall-clock parts in a given IANA zone. The one place that answers "what time
// is it for this person" — the crons previously each hand-rolled
// `new Date(runAt.getTime() + 5.5 * 3600 * 1000)`, which is only correct
// because IST has no DST. That trick silently breaks for anywhere that does
// (Europe), so per-person timing must go through Intl, which reads the tz
// database. Falls back to IST on an unknown zone rather than throwing:
// Intl raises RangeError on a bad zone, and one bad row must not be able to
// silence the nudge for everybody.
function zonedParts(dateInput, timeZone) {
  const value = dateInput ? new Date(dateInput) : new Date();
  let zone = timeZone || DEFAULT_TIME_ZONE;
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false
    }).formatToParts(value);
  } catch (error) {
    zone = DEFAULT_TIME_ZONE;
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false
    }).formatToParts(value);
  }
  const get = (type) => (parts.find((p) => p.type === type) || {}).value;
  // hour12:false yields '24' for midnight in some ICU versions, not '00'.
  const hour = Number(get('hour')) % 24;
  const dayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get('weekday')];
  return {
    zone,
    iso: `${get('year')}-${get('month')}-${get('day')}`,
    hour,
    minute: Number(get('minute')),
    day: dayIndex,
    isWeekend: dayIndex === 0 || dayIndex === 6
  };
}

// The UTC instant of local midnight that starts `iso` in `timeZone` — the
// "since they woke up" boundary for per-person queries. Derived by probing the
// zone's offset at that date rather than assuming a fixed one.
function zonedMidnightUtc(iso, timeZone) {
  const zone = timeZone || DEFAULT_TIME_ZONE;
  const guess = new Date(`${iso}T00:00:00Z`);
  let offsetMs = 0;
  try {
    const asUtc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
    const asZone = new Date(guess.toLocaleString('en-US', { timeZone: zone }));
    offsetMs = asZone.getTime() - asUtc.getTime();
  } catch (error) {
    offsetMs = 5.5 * 60 * 60 * 1000; // IST fallback, mirrors zonedParts
  }
  return new Date(guess.getTime() - offsetMs).toISOString();
}

module.exports = {
  IST_TIME_ZONE,
  DEFAULT_TIME_ZONE,
  getConfig,
  formatDateInIST,
  formatDateTimeInIST,
  zonedParts,
  zonedMidnightUtc
};
