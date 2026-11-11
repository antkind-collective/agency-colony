// P1 (25 Sep 2026): identical loads started at the same moment share one
// request, but never across a write — a reload after a save must see the save.
// shareInFlight / isSupabaseWrite live in app.js (a classic browser script), so
// their source is lifted out and run in a vm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const start = app.indexOf('let supabaseWriteEpoch = 0;');
const end = app.indexOf('let authLossInFlight = false;');
assert.ok(start > 0 && end > start, 'shareInFlight block not found in app.js');
const ctx = vm.createContext({ Map, Promise, URL, String });
vm.runInContext(app.slice(start, end) + '\nthis.bump = () => { supabaseWriteEpoch += 1; };', ctx);
const { shareInFlight, isSupabaseWrite, bump } = ctx;

test('identical concurrent loads share one run', async () => {
  let runs = 0;
  const run = () => { runs += 1; return new Promise((r) => setTimeout(() => r(runs), 10)); };
  const [a, b] = await Promise.all([shareInFlight('k', run), shareInFlight('k', run)]);
  assert.equal(runs, 1);
  assert.equal(a, b);
});

test('different inputs, a finished load, or a write in between each run again', async () => {
  let runs = 0;
  const run = () => { runs += 1; return new Promise((r) => setTimeout(r, 10)); };
  await Promise.all([shareInFlight('x', run), shareInFlight('y', run)]);
  assert.equal(runs, 2, 'different keys shared');
  await shareInFlight('x', run);
  assert.equal(runs, 3, 'a finished load was reused');
  const first = shareInFlight('z', run);
  bump();
  const second = shareInFlight('z', run);
  await Promise.all([first, second]);
  assert.equal(runs, 5, 'a load started before a write was handed to a caller after it');
});

test('a failed load is not kept', async () => {
  await assert.rejects(shareInFlight('f', () => Promise.reject(new Error('boom'))));
  let ran = false;
  await shareInFlight('f', async () => { ran = true; });
  assert.ok(ran);
});

test('isSupabaseWrite: table writes, storage and write RPCs count; reads do not', () => {
  const u = 'https://your-project.supabase.co';
  assert.equal(isSupabaseWrite(`${u}/rest/v1/allocations?select=*`, { method: 'GET' }), false);
  assert.equal(isSupabaseWrite(`${u}/rest/v1/briefs`, { method: 'HEAD' }), false);
  assert.equal(isSupabaseWrite(`${u}/rest/v1/employees?id=eq.1`, { method: 'PATCH' }), true);
  assert.equal(isSupabaseWrite(`${u}/rest/v1/daily_tasks`, { method: 'POST' }), true);
  assert.equal(isSupabaseWrite(`${u}/rest/v1/rpc/save_my_allocations`, { method: 'POST' }), true);
  assert.equal(isSupabaseWrite(`${u}/rest/v1/rpc/get_my_leave_cycle_summary`, { method: 'POST' }), false);
  assert.equal(isSupabaseWrite(`${u}/rest/v1/rpc/employee_private_details`, { method: 'POST' }), false);
  assert.equal(isSupabaseWrite(`${u}/storage/v1/object/invoices/a.pdf`, { method: 'POST' }), true);
  assert.equal(isSupabaseWrite(`${u}/auth/v1/token?grant_type=refresh_token`, { method: 'POST' }), false);
});

test('the Supabase fetch wrapper bumps the write epoch before sending', () => {
  assert.match(app, /fetch: async \(input, init\) => \{\s*if \(isSupabaseWrite\(input, init\)\) supabaseWriteEpoch \+= 1;\s*const response = await fetch\(input, init\);/);
});
