// The 10:00 cron's task rollover (Q2, 24 Sep 2026). It moved every past task
// that wasn't 'done' — archived ones included — in one UPDATE, so each run
// re-dated the task archive, and one duplicate title aborted everyone's
// rollover (failing daily from 8 Sep).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { planTaskRollover } = require('../netlify/functions/lib/task-rollover.js');
const T = '2026-09-24';
const row = (id, emp, title, date, status = 'in_progress') => ({ id, employee_id: emp, task_title: title, task_date: date, status });

test('only unfinished daily tasks move; done, archived and weekly rows are never touched', () => {
  const plan = planTaskRollover([
    row('a', 'e1', 'Deck', '2026-09-23'),
    row('b', 'e1', 'Old done', '2026-09-20', 'done'),
    row('c', 'e1', 'Archived', '2026-09-01', 'archived'),
    row('d', 'e1', 'Weekly', null),
    row('e', 'e1', 'Pending one', '2026-09-22', 'pending'),
  ], [], T);
  assert.deepEqual(plan.move.sort(), ['a', 'e']);
  assert.deepEqual(plan.archive, []);
});

test('a task already on today is not moved again: the past copy is archived', () => {
  const plan = planTaskRollover([row('a', 'e1', 'Deck', '2026-09-23')], [{ employee_id: 'e1', task_title: 'deck' }], T);
  assert.deepEqual(plan, { move: [], archive: ['a'] });
});

test('several past copies of one task: the newest moves, the rest are archived', () => {
  const plan = planTaskRollover([
    row('old', 'e1', 'Deck', '2026-09-10'),
    row('new', 'e1', 'DECK', '2026-09-22'),
    row('mid', 'e1', 'deck', '2026-09-15'),
  ], [], T);
  assert.deepEqual(plan.move, ['new']);
  assert.deepEqual(plan.archive.sort(), ['mid', 'old']);
});

test('titles are compared like the index (lower, no trim), and per person', () => {
  const plan = planTaskRollover([
    row('a', 'e1', 'Deck', '2026-09-23'),
    row('b', 'e2', 'Deck', '2026-09-23'),
    row('c', 'e1', 'Deck ', '2026-09-23'),
  ], [], T);
  assert.deepEqual(plan.move.sort(), ['a', 'b', 'c']);
  assert.deepEqual(plan.archive, []);
});

test('the cron uses the plan and never bulk-moves every non-done row', () => {
  const src = readFileSync(fileURLToPath(new URL('../netlify/functions/daily-reminders.js', import.meta.url)), 'utf8');
  assert.match(src, /planTaskRollover\(/);
  assert.doesNotMatch(src, /\.update\(\{\s*task_date: todayIso[^}]*\}\)\s*\.lt\('task_date'/, 'the old bulk UPDATE is back');
  assert.match(src, /\.in\('status', \['pending', 'in_progress'\]\)/, 'the rollover must select unfinished tasks only');
});
