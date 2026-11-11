import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 21 Oct 2026 (Alex): the bell must not need a page refresh, and a tab in
// the background should say it wants attention.
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

test('the bell re-reads on return to the tab and every 2 minutes', () => {
  assert.match(app, /const NOTIFY_LIVE_MS = 2 \* 60 \* 1000;/);
  assert.match(app, /setInterval\(\(\) => refreshNotifyLive\(\{ force: true \}\), NOTIFY_LIVE_MS\)/);
  assert.match(app, /window\.addEventListener\('focus', \(\) => refreshNotifyLive\(\)\)/);
  assert.match(app, /loadNotifySignals\(\), loadLeaveRequestsFromSupabase\(\)/);
});

test('unseen items show in the tab title and icon', () => {
  assert.match(app, /badge\.classList\.toggle\('hidden', unseen === 0\);\s*showNotifyAttention\(unseen\);/);
  assert.match(app, /document\.title = unseen \? `\(\$\{unseen\}\) \$\{base\}` : base;/);
});

test('a live reload keeps the Past decisions page you were on', () => {
  assert.match(app, /let page = state\.leaveDecidedPage \|\| 0;/);
});
