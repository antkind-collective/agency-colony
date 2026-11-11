// S7: people with no emergency contact on file (5 and 7 Oct 2026).
// They were emailed with a deadline; Colony sends one reminder on the working
// day before it, and after the deadline their access pauses until they add one.
// The deadline lives in app_config 'emergency_contact_deadline' (YYYY-MM-DD).
const { isWorkingDayIso, shiftIso } = require('./brief-reminders');

const DEFAULT_DEADLINE = '2026-10-09';

// The working day before the deadline.
function reminderDayIso(deadlineIso, holidays = []) {
  let d = shiftIso(deadlineIso, -1);
  while (!isWorkingDayIso(d, holidays)) d = shiftIso(d, -1);
  return d;
}

// Onboarded, active, no phone on file. Shared accounts never finish onboarding,
// so they never qualify.
function missingContact(employees) {
  return (employees || []).filter((e) => e.is_active && e.onboarding_completed && !String(e.emergency_contact_phone || '').trim());
}

function reminderEmail(employee, deadlineIso, colonyUrl) {
  const name = String(employee.full_name || '').trim().split(/\s+/)[0] || 'there';
  const day = new Date(`${deadlineIso}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const weekday = day.split(',')[0];
  const subject = `Reminder: add an emergency contact in Colony by ${weekday}`;
  const lines = [
    `Hi ${name},`,
    `A quick reminder that we still don't have an emergency contact for you: someone we can reach if anything ever happens to you at work.`,
    `It takes a minute. Open Colony (${colonyUrl}), tap the 📞 item in your notifications, and add a name and phone number on your profile.`,
    `Please add it by ${day}. From the day after, Colony will pause your access until it's on file. You'll only need to add the contact to get straight back in.`,
    `Thank you!`,
    `Agency Colony`
  ];
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.6;max-width:560px">${lines.map((l) => `<p>${l
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(colonyUrl, `<a href="${colonyUrl}">${colonyUrl.replace(/^https:\/\//, '')}</a>`)}</p>`).join('')}</div>`;
  return { subject, html, text: lines.join('\n\n') };
}

// Past the deadline (the day after it, IST): anyone still missing a contact,
// not already paused and not the superadmin, is paused.
function toPause(employees, todayIso, deadlineIso, superadminEmail = 'admin@youragency.com') {
  if (!(todayIso > deadlineIso)) return [];
  return missingContact(employees).filter((e) => !e.access_paused_at && String(e.email || '').toLowerCase() !== superadminEmail);
}

function pausedEmail(employee, colonyUrl) {
  const name = String(employee.full_name || '').trim().split(/\s+/)[0] || 'there';
  const lines = [
    `Hi ${name},`,
    `As we mentioned, your Colony access is paused until we have an emergency contact for you.`,
    `Open Colony (${colonyUrl}) and it will ask for a name and phone number. Once you save them, you're straight back in.`,
    `Thank you!`,
    `Agency Colony`
  ];
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.6;max-width:560px">${lines.map((l) => `<p>${l
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(colonyUrl, `<a href="${colonyUrl}">${colonyUrl.replace(/^https:\/\//, '')}</a>`)}</p>`).join('')}</div>`;
  return { subject: 'Your Colony access is paused: add an emergency contact to continue', html, text: lines.join('\n\n') };
}

module.exports = { DEFAULT_DEADLINE, reminderDayIso, missingContact, reminderEmail, toPause, pausedEmail };
