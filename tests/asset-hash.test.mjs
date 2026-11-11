// Assets are versioned by content (C2, 24 Sep 2026): an unchanged file keeps
// its URL across deploys, so a visitor re-downloads only what changed. The
// deploy-version stamp it replaced changed every URL on every deploy (~715kB
// re-fetched, 288kB of it a SheetJS that never changes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { versionPage, contentVersion, circleServed, colonyServed } from '../_build/hash-assets.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('each asset gets a hash of its own content, and only its own', () => {
  const files = { 'a.js': 'one', 'b.css': 'two', 'vendor/c.js': 'three' };
  const page = '<script src="a.js?v=old"></script><link href="b.css?v=old"><script src="vendor/c.js?v=x"></script>'
    + '<script src="https://cdn.example/lib.js?v=9"></script>';
  const { html } = versionPage(page, colonyServed, (p) => Buffer.from(files[p]));
  assert.ok(html.includes(`a.js?v=${contentVersion(Buffer.from('one'))}`));
  assert.ok(html.includes(`b.css?v=${contentVersion(Buffer.from('two'))}`));
  assert.ok(html.includes('https://cdn.example/lib.js?v=9'), 'external URLs are left alone');
  // Change one file: only its URL moves.
  const again = versionPage(page, colonyServed, (p) => Buffer.from(p === 'a.js' ? 'ONE' : files[p])).html;
  assert.notEqual(again.match(/a\.js\?v=\w+/)[0], html.match(/a\.js\?v=\w+/)[0]);
  assert.equal(again.match(/b\.css\?v=\w+/)[0], html.match(/b\.css\?v=\w+/)[0]);
});

test('a referenced file that does not exist fails the build', () => {
  assert.throws(() => versionPage('<script src="gone.js?v=1"></script>', colonyServed, () => { throw new Error('ENOENT'); }), /gone\.js/);
});

test('Circle is hashed against what clients.youragency.com serves', () => {
  assert.equal(circleServed('app.js'), 'circle/app.js');
  assert.equal(circleServed('js/utils.js'), 'circle/js/utils.js');
  assert.equal(circleServed('styles.css'), 'circle/styles.css');
  assert.equal(circleServed('vendor/supabase.js'), 'vendor/supabase.js');
  assert.equal(circleServed('version.js'), 'version.js');
});


// SheetJS is fetched on the first analytics upload, not with every page
// (24 Sep 2026: 288kB compressed, the largest file on every Colony visit).
test('Colony does not load SheetJS with the page, but keeps a versioned URL for it', () => {
  const page = readFileSync(`${ROOT}index.html`, 'utf8');
  const outside = page.replace(/<template[\s\S]*?<\/template>/g, '');
  assert.doesNotMatch(outside, /vendor\/xlsx\.js/, 'SheetJS is loaded with the page again');
  assert.match(page, /<template id="lazySheetJS"><script src="vendor\/xlsx\.js\?v=[^"]+"><\/script><\/template>/);
  const { html } = versionPage(page.match(/<template id="lazySheetJS">[\s\S]*?<\/template>/)[0], colonyServed);
  assert.match(html, /vendor\/xlsx\.js\?v=[0-9a-f]{12}"/, 'the build no longer versions the lazy SheetJS URL');
  const analytics = readFileSync(`${ROOT}js/analytics.js`, 'utf8');
  assert.match(analytics, /getElementById\('lazySheetJS'\)/);
  const app = readFileSync(`${ROOT}app.js`, 'utf8');
  const i = app.indexOf('async function processAnalyticsSpreadsheet(');
  assert.ok(app.slice(i, app.indexOf('detectReportType(file)', i)).includes('await loadSheetJS()'), 'uploads no longer load SheetJS before parsing');
});
