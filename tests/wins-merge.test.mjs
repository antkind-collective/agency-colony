import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 26 Oct 2026 (Alex): "Salicylates and Chemicals signed" and "New client:
// Salicylates and Chemicals" were two Wins lines for one win.
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

test('a signed deal and its new client are one Wins line', () => {
  assert.match(app, /deal:deals\(deal_name, stage, created_at, client_id\)/);
  assert.match(app, /if \(same\) \{ same\.win\.text = `New client signed: \$\{c\.name\}`; return; \}/);
});

// 26 Oct 2026 (Alex): Client of the week is the most hours allocated, not
// the most people; Misc, BD and Your Agency's own buckets never count.
test('client of the week ranks by allocated hours', () => {
  assert.match(app, /clientHours\.set\(c\.name, \(clientHours\.get\(c\.name\) \|\| 0\) \+ \(a\.allocation_percent \/ 100\) \* WORK_HOURS_PER_WEEK\)/);
  assert.match(app, /NON_CLIENT_BUCKETS\.includes\(String\(c\.name\)\.trim\(\)\.toLowerCase\(\)\)/);
  assert.doesNotMatch(app, /people on it/);
});

// 27 Oct 2026 (Alex): "This week · 19 tasks done" updated daily and read as
// a daily report. Only finished weeks get a line.
test('Wins count tasks for finished weeks only', () => {
  assert.match(app, /if \(shiftIsoDays\(start, 6\) >= todayIso\) return; \/\/ still running/);
  assert.doesNotMatch(app, /'This week' : `Week of/);
});
