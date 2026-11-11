// Out of office FYI email (4 Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { oooEmail } = require('../netlify/functions/ooo-notify.js');

test('the FYI names the person, the dates and says nothing needs approving', () => {
  const e = oooEmail({ start_date: '2026-11-06', end_date: '2026-11-06', is_half_day: true, note: 'Doctor', employee: { full_name: 'Mara' } }, 'https://app.youragency.com');
  assert.equal(e.subject, 'FYI: Mara is out of office 06 Nov 2026 (half day)');
  assert.match(e.text, /Their note: Doctor/);
  assert.match(e.text, /Nothing to approve/);
  assert.match(e.html, /#leave-center/);
});

test('a range reads from and to, and markup in a note is escaped', () => {
  const e = oooEmail({ start_date: '2026-11-10', end_date: '2026-11-12', is_half_day: false, note: '<b>x</b>', employee: { full_name: 'Ruby Ford' } }, 'https://app.youragency.com');
  assert.match(e.subject, /Ruby is out of office 10 Nov 2026 to 12 Nov 2026$/);
  assert.ok(!e.html.includes('<b>x</b>'));
});
