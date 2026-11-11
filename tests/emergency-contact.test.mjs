// S7 reminder: who gets it, on which day, and what it says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { reminderDayIso, missingContact, reminderEmail } = require('../netlify/functions/lib/emergency-contact.js');

test('reminderDayIso: the working day before the deadline', () => {
  assert.equal(reminderDayIso('2026-10-09'), '2026-10-08');
  assert.equal(reminderDayIso('2026-10-12'), '2026-10-09', 'Monday deadline: the Friday before');
});

test('missingContact: onboarded, active, no phone; shared accounts excluded', () => {
  const out = missingContact([
    { full_name: 'A', is_active: true, onboarding_completed: true, emergency_contact_phone: null },
    { full_name: 'B', is_active: true, onboarding_completed: true, emergency_contact_phone: '+91 1' },
    { full_name: 'studio', is_active: true, onboarding_completed: false, emergency_contact_phone: null },
    { full_name: 'C', is_active: false, onboarding_completed: true, emergency_contact_phone: '' }
  ]);
  assert.deepEqual(out.map((e) => e.full_name), ['A']);
});

test('reminderEmail: polite, names the deadline and the pause', () => {
  const m = reminderEmail({ full_name: 'Ruby Ford' }, '2026-10-09', 'https://app.youragency.com');
  assert.equal(m.subject, 'Reminder: add an emergency contact in Colony by Friday');
  assert.match(m.text, /^Hi Ruby,/);
  assert.match(m.text, /Friday, 9 October/);
  assert.match(m.text, /pause your access until it's on file/);
});

test('toPause: only after the deadline, never the superadmin, never twice', () => {
  const { toPause } = require('../netlify/functions/lib/emergency-contact.js');
  const emps = [
    { full_name: 'A', email: 'a@youragency.com', is_active: true, onboarding_completed: true, emergency_contact_phone: null },
    { full_name: 'Alex', email: 'admin@youragency.com', is_active: true, onboarding_completed: true, emergency_contact_phone: null },
    { full_name: 'P', email: 'p@youragency.com', is_active: true, onboarding_completed: true, emergency_contact_phone: null, access_paused_at: '2026-10-10T00:00:00Z' }
  ];
  assert.deepEqual(toPause(emps, '2026-10-09', '2026-10-09'), [], 'not on the deadline day itself');
  assert.deepEqual(toPause(emps, '2026-10-10', '2026-10-09').map((e) => e.full_name), ['A']);
});
