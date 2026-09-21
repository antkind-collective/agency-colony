// Tests for js/tasks.js — the pure decision logic of the task system (the most
// bug-prone area: carry-forward zombies, done-cascade). Loaded into a vm
// context with utils.js (taskTitleKey dependency).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ Intl, Date, Number, String, Math, Object, Set, Array, JSON });
for (const file of ['js/utils.js', 'js/tasks.js']) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), ctx, { filename: file });
}
const call = (fn, ...args) => vm.runInContext(fn, ctx)(...args);

const T = (over = {}) => ({
  id: over.id || Math.random().toString(36).slice(2),
  employee_id: 'me',
  task_date: '2026-06-09',
  task_title: 'Edit hero banner',
  status: 'in_progress',
  notes: null, description: null, deadline: null, sort_order: 0,
  updated_at: '2026-06-09T10:00:00Z', created_at: '2026-06-09T09:00:00Z',
  ...over
});
const OPTS = { todayIso: '2026-06-10', weekStartIso: '2026-06-08', dayOfWeek: 3, employeeId: 'me' };

// ── planDailyCleanup ──
test('archives only PAST done dailies — today\'s done stays visible', () => {
  const tasks = [
    T({ id: 'a', status: 'done', task_date: '2026-06-09' }),
    T({ id: 'b', status: 'done', task_date: '2026-06-10', task_title: 'Other' }),
    T({ id: 'c', status: 'done', task_date: null, task_title: 'Weekly thing', updated_at: '2026-06-09T10:00:00Z' })
  ];
  const plan = call('planDailyCleanup', tasks, OPTS);
  assert.deepEqual(plan.pastDoneDaily.map(t => t.id), ['a']);
});

test('carries forward unfinished past tasks, preserving fields', () => {
  const tasks = [T({ id: 'a', status: 'in_progress', notes: 'Sony', description: 'desc', deadline: '2026-06-12', sort_order: 3 })];
  const plan = call('planDailyCleanup', tasks, OPTS);
  assert.deepEqual(plan.carryTasks.map(t => t.id), ['a']);
  // JSON round-trip: vm-realm objects fail deepEqual on prototype identity
  assert.deepEqual(JSON.parse(JSON.stringify(plan.copies)), [{
    employee_id: 'me', task_date: '2026-06-10', task_title: 'Edit hero banner',
    notes: 'Sony', description: 'desc', deadline: '2026-06-12', status: 'in_progress', sort_order: 3, recurring_task_id: null
  }]);
});

test('carry-forward skips: weekly tasks, done/archived, and titles already on today (case-insensitive)', () => {
  const tasks = [
    T({ id: 'w', task_date: null }),                                    // weekly — never carried
    T({ id: 'd', status: 'done' }),                                     // done — archived instead
    T({ id: 'x', status: 'archived' }),                                 // archived
    T({ id: 'dup', task_title: 'EDIT HERO BANNER  ' }),                 // exists today (case/space-insensitive)
    T({ id: 'today-version', task_date: '2026-06-10', task_title: 'edit hero banner', status: 'todo' }),
    T({ id: 'ok', task_title: 'Unique task' })                          // the only legit carry
  ];
  const plan = call('planDailyCleanup', tasks, OPTS);
  assert.deepEqual(plan.carryTasks.map(t => t.id), ['ok']);
});

test('carry-forward dedupes multiple past copies of the same title (zombie prevention)', () => {
  const tasks = [
    T({ id: 'old1', task_date: '2026-06-08' }),
    T({ id: 'old2', task_date: '2026-06-09' })
  ];
  const plan = call('planDailyCleanup', tasks, OPTS);
  assert.equal(plan.carryTasks.length, 1);
  assert.equal(plan.copies.length, 1);
});

test('weekly done: Monday archives all; other days only pre-week completions', () => {
  const tasks = [
    T({ id: 'wk-new', task_date: null, status: 'done', task_title: 'W1', updated_at: '2026-06-09T10:00:00Z' }),
    T({ id: 'wk-old', task_date: null, status: 'done', task_title: 'W2', updated_at: '2026-06-05T10:00:00Z' })
  ];
  const wed = call('planDailyCleanup', tasks, OPTS); // dayOfWeek 3
  assert.deepEqual(wed.weeklyDone.map(t => t.id), ['wk-old']);
  const mon = call('planDailyCleanup', tasks, { ...OPTS, dayOfWeek: 1 });
  assert.deepEqual(mon.weeklyDone.map(t => t.id).sort(), ['wk-new', 'wk-old']);
});

// ── linkedTasksFor ──
test('cascade-done from a daily: weekly original + other daily copies, skipping done/archived/self/other-employee', () => {
  const done = T({ id: 'self', status: 'done' });
  const all = [
    done,
    T({ id: 'weekly', task_date: null }),
    T({ id: 'copy', task_date: '2026-06-08' }),
    T({ id: 'already-done', task_date: '2026-06-07', status: 'done' }),
    T({ id: 'archived', task_date: '2026-06-07', status: 'archived' }),
    T({ id: 'someone-else', employee_id: 'other' }),
    T({ id: 'different-title', task_title: 'Unrelated' })
  ];
  const ids = call('linkedTasksFor', done, all, 'cascade-done').map(t => t.id).sort();
  assert.deepEqual(ids, ['copy', 'weekly']);
});

test('cascade-done from a weekly: daily copies only', () => {
  const weekly = T({ id: 'w', task_date: null, status: 'done' });
  const all = [
    weekly,
    T({ id: 'copy1', task_date: '2026-06-08' }),
    T({ id: 'copy2', task_date: '2026-06-10' }),
    T({ id: 'other-weekly', task_date: null, id: 'other-weekly' })
  ];
  const ids = call('linkedTasksFor', weekly, all, 'cascade-done').map(t => t.id).sort();
  assert.deepEqual(ids, ['copy1', 'copy2']);
});

test('sync-status from a daily targets ONLY the weekly original — and unlike cascade can reopen done tasks', () => {
  const daily = T({ id: 'd' });
  const all = [
    daily,
    T({ id: 'weekly-done', task_date: null, status: 'done' }), // done is fair game for sync
    T({ id: 'other-copy', task_date: '2026-06-08' })           // dailies NOT touched by sync
  ];
  const ids = call('linkedTasksFor', daily, all, 'sync-status').map(t => t.id);
  assert.deepEqual(ids, ['weekly-done']);
});

test('title matching uses taskTitleKey semantics (case + trim)', () => {
  const a = T({ id: 'a', task_title: '  Fix The Deck ' });
  const b = T({ id: 'b', task_title: 'fix the deck', task_date: null });
  assert.deepEqual(call('linkedTasksFor', a, [a, b], 'cascade-done').map(t => t.id), ['b']);
});

test('hasDailyCopyToday: title-key match, today only, ignores archived/self/others', () => {
  const f = call.bind(null, 'hasDailyCopyToday');
  const weekly = T({ id: 'w', task_date: null, task_title: 'Example Materials Content Calendar' });
  const mk = (over) => T({ task_title: 'example materials content calendar', task_date: '2026-06-10', ...over });
  assert.equal(f(weekly, [weekly, mk({ id: 'a' })], '2026-06-10'), true);          // copy today
  assert.equal(f(weekly, [weekly, mk({ id: 'b', task_date: '2026-06-09' })], '2026-06-10'), false); // yesterday
  assert.equal(f(weekly, [weekly, mk({ id: 'c', status: 'archived' })], '2026-06-10'), false);      // archived
  assert.equal(f(weekly, [weekly, mk({ id: 'd', employee_id: 'other' })], '2026-06-10'), false);    // someone else
  assert.equal(f(weekly, [weekly], '2026-06-10'), false);                           // no copies
});

test('recurringRuleDueOn: exact day + short-month clamp', () => {
  const f = call.bind(null, 'recurringRuleDueOn');
  const monthly = (d) => ({ frequency: 'monthly', day_of_month: d, day_of_week: null });
  assert.equal(f(monthly(28), '2026-06-28'), true);
  assert.equal(f(monthly(28), '2026-06-27'), false);
  assert.equal(f(monthly(31), '2026-06-30'), true);   // June has 30 days → clamp
  assert.equal(f(monthly(31), '2026-02-28'), true);   // Feb 2026 → clamp to 28
  assert.equal(f(monthly(31), '2026-07-31'), true);
  assert.equal(f(monthly(31), '2026-07-30'), false);
});

// Weekly repeats (Ruby, board request 28 Aug 2026).
test('recurringRuleDueOn: weekly matches the weekday, 0=Sunday', () => {
  const f = call.bind(null, 'recurringRuleDueOn');
  const weekly = (d) => ({ frequency: 'weekly', day_of_week: d, day_of_month: null });
  // 2026-06-08 is a Monday, so the week runs Mon 8 → Sun 14.
  assert.equal(f(weekly(1), '2026-06-08'), true);    // Monday
  assert.equal(f(weekly(1), '2026-06-09'), false);
  assert.equal(f(weekly(2), '2026-06-09'), true);    // Tuesday
  assert.equal(f(weekly(5), '2026-06-12'), true);    // Friday
  assert.equal(f(weekly(6), '2026-06-13'), true);    // Saturday — deliberate pick, still fires
  assert.equal(f(weekly(0), '2026-06-14'), true);    // Sunday is 0, not 7
  // Sunday-as-zero must not be read as "no day set".
  assert.equal(f(weekly(0), '2026-06-08'), false);
  // A cadence never falls through to the other one's day.
  assert.equal(f({ frequency: 'weekly', day_of_week: null, day_of_month: 8 }, '2026-06-08'), false);
  assert.equal(f({ frequency: 'monthly', day_of_month: null, day_of_week: 1 }, '2026-06-08'), false);
  assert.equal(f(null, '2026-06-08'), false);
});

test('recurringRuleLabel reads for both cadences', () => {
  const f = call.bind(null, 'recurringRuleLabel');
  assert.equal(f({ frequency: 'weekly', day_of_week: 0 }), 'weekly on Sunday');
  assert.equal(f({ frequency: 'weekly', day_of_week: 3 }), 'weekly on Wednesday');
  assert.equal(f({ frequency: 'monthly', day_of_month: 12 }), 'monthly on the 12');
});

// ── Task description limit: one number, shared (20 Sep 2026) ──────
// Editing a task and pasting a link silently refused to save: the create path
// allowed 200 characters, the edit path 50, and a URL is longer than 50. These
// assert the two paths can never carry different numbers again.
test('the description limit is one constant, and it fits a real pasted link', () => {
  const cfg = readFileSync(new URL('../js/config.js', import.meta.url), 'utf8');
  const max = Number(cfg.match(/const TASK_DESCRIPTION_MAX = (\d+);/)[1]);
  assert.ok(max >= 120, `limit ${max} is too small for a pasted URL`);

  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  // Both validations and both inputs must read the constant, never a literal.
  const checks = app.match(/[Dd]escription\.length > [^\s)]+/g) || [];
  assert.ok(checks.length >= 2, 'expected a length check on create and on edit');
  for (const c of checks) assert.match(c, /TASK_DESCRIPTION_MAX/, `hardcoded limit: ${c}`);
  assert.doesNotMatch(app, /class="edit-task-desc"[^>]*maxlength="\d+"/, 'edit input hardcodes maxlength');

  // A typical Drive link plus a few words must pass the shared limit.
  const pasted = 'Ref https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456/view?usp=sharing';
  assert.ok(pasted.length > 50, 'fixture should exceed the old 50-char limit');
  assert.ok(pasted.length <= max);
});

// A URL in the description is what makes the task title clickable, so the
// edit path must preserve it intact.
test('taskLinkParts pulls the URL out of an edited description', () => {
  const { url, displayDesc } = call('taskLinkParts', 'Ref https://drive.google.com/file/d/1AbC/view?usp=sharing');
  assert.equal(url, 'https://drive.google.com/file/d/1AbC/view?usp=sharing');
  assert.equal(displayDesc, 'Ref');
});

// A pasted link must never sit raw in the description cell: it is lifted out
// and the title carries it (20 Sep 2026).
test('taskLinkParts lifts a link out however it was pasted', () => {
  const full = call('taskLinkParts', 'Ref https://drive.google.com/file/d/1AbC/view?usp=sharing');
  assert.equal(full.url, 'https://drive.google.com/file/d/1AbC/view?usp=sharing');
  assert.equal(full.displayDesc, 'Ref');

  // No scheme — how people actually paste. Was left raw in the cell.
  const bare = call('taskLinkParts', 'drive.google.com/file/d/1AbC/view?usp=sharing');
  assert.equal(bare.url, 'https://drive.google.com/file/d/1AbC/view?usp=sharing');
  assert.equal(bare.displayDesc, '');

  const www = call('taskLinkParts', 'see www.youragency.com/press');
  assert.equal(www.url, 'https://www.youragency.com/press');
  assert.equal(www.displayDesc, 'see');
});

test('taskLinkParts leaves ordinary text alone', () => {
  for (const text of ['scored 3.5/10', 'v2.0 final', 'call at 5.30', 'draft 2/3 done']) {
    const { url, displayDesc } = call('taskLinkParts', text);
    assert.equal(url, null, `wrongly linked: ${text}`);
    assert.equal(displayDesc, text);
  }
});

// Links in any human-written text — brief fields, comments, feedback — on both
// Colony and Circle (Alex's rule, 20 Sep 2026: fix one surface, check the
// other; Circle's brief form has a field FOR links that rendered them flat).
test('linkifyText turns URLs into links and escapes everything else', () => {
  const link = call('linkifyProse', 'Register at https://gaglobal.org/signup thanks');
  assert.match(link, /<a href="https:\/\/gaglobal\.org\/signup" target="_blank" rel="noopener noreferrer">https:\/\/gaglobal\.org\/signup<\/a>/);
  assert.match(link, /^Register at /);
  assert.match(link, /thanks$/);

  // Scheme-less, as people actually paste.
  assert.match(call('linkifyProse', 'drive.google.com/file/d/1AbC/view'), /href="https:\/\/drive\.google\.com\/file\/d\/1AbC\/view"/);

  // A URL ending a sentence keeps the full stop out of the link.
  const dotted = call('linkifyProse', 'see https://youragency.com/press.');
  assert.match(dotted, /href="https:\/\/youragency\.com\/press"/);
  assert.match(dotted, /<\/a>\.$/);

  // Ordinary text is untouched, and markup is always escaped.
  assert.equal(call('linkifyProse', 'scored 3.5/10'), 'scored 3.5/10');
  assert.equal(call('linkifyProse', '<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(call('linkifyProse', null), '');
});

test('linkifyText escapes a URL that carries markup', () => {
  const out = call('linkifyProse', 'https://x.com/"><script>alert(1)</script>');
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&quot;|&gt;|&lt;/);
});
