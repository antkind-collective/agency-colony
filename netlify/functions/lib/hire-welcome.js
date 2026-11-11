// Joiner welcome email (7 Oct 2026) — pure logic, no Supabase, no mail.
//
// People start on Mondays and should be at that morning's All Hands, so a
// Monday-morning email is too late. Two WORKING days before the start date
// (weekends and Your Agency holidays skipped: Monday start -> the Thursday before)
// the hire gets one email at their @youragency.com and personal addresses: how to
// sign in to Colony, the first All Hands and Thirsty Thursday, and Slack.
// A hire signed later than that gets it on the next run, up to the start day.
// No @youragency.com account yet -> no email; the hiring lead is alerted instead.

const { isWorkingDayIso, shiftIso } = require('./brief-reminders');

const SEND_WORKING_DAYS_BEFORE = 2;
const READY_STAGES = ['signed', 'payroll_done'];

// Meeting rhythm and links (checked in Alex's calendar, 7 Oct 2026). Override
// with app_config.joiner_welcome (same shape).
const DEFAULTS = {
  colonyUrl: 'https://app.youragency.com',
  slackUrl: 'https://youragency.slack.com',
  slackChannels: ['#youragency-all', '#youragency-random'],
  allHands: { weekday: 1, time: '10:30 am', meet: 'https://meet.google.com/kjo-haaa-exv' },
  thirstyThursday: { anchor: '2026-10-08', everyDays: 14, time: '5:30 pm', meet: 'https://meet.google.com/hrf-nhse-yfc' }
};

// The day the welcome goes out: SEND_WORKING_DAYS_BEFORE working days before
// the start date.
function welcomeSendDate(startIso, holidays = []) {
  let d = startIso;
  let counted = 0;
  while (counted < SEND_WORKING_DAYS_BEFORE) {
    d = shiftIso(d, -1);
    if (isWorkingDayIso(d, holidays)) counted += 1;
  }
  return d;
}

// hires: [{ id, stage, start_date, welcome_sent_at, work_email }]
// -> { send: [...], noAccount: [...] }
function welcomeDue(hires, todayIso, holidays = []) {
  const send = []; const noAccount = [];
  for (const h of hires || []) {
    if (!h.start_date || h.welcome_sent_at || !READY_STAGES.includes(h.stage)) continue;
    // No account wanted: no welcome, and no "account missing" alert either.
    if (h.workspace_not_needed && !h.work_email) continue;
    const start = String(h.start_date).slice(0, 10);
    if (todayIso > start || todayIso < welcomeSendDate(start, holidays)) continue;
    (h.work_email ? send : noAccount).push(h);
  }
  return { send, noAccount };
}

// First occurrence on or after a date.
function firstWeekdayOnOrAfter(startIso, weekday) {
  let d = startIso;
  for (let i = 0; i < 7; i++) {
    if (new Date(`${d}T00:00:00Z`).getUTCDay() === weekday) return d;
    d = shiftIso(d, 1);
  }
  return startIso;
}
function firstFortnightlyOnOrAfter(startIso, anchorIso, everyDays) {
  const dayMs = 86400000;
  const diff = Math.round((Date.parse(`${startIso}T00:00:00Z`) - Date.parse(`${anchorIso}T00:00:00Z`)) / dayMs);
  const steps = Math.max(0, Math.ceil(diff / everyDays));
  return shiftIso(anchorIso, steps * everyDays);
}

module.exports = { welcomeSendDate, welcomeDue, firstWeekdayOnOrAfter, firstFortnightlyOnOrAfter, DEFAULTS, SEND_WORKING_DAYS_BEFORE };
