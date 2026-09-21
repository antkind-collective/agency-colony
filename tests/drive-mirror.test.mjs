// The pure half of the Drive mirror: names, the Doc body, the upload body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const m = require('../netlify/functions/lib/drive-mirror.js');

test('policyDocName is the title, whitespace collapsed, no version in the name', () => {
  assert.equal(m.policyDocName({ title: '  Your Agency  Remote Work Policy ', version: '2.1' }), 'Your Agency Remote Work Policy');
  assert.equal(m.policyDocName({}), 'Policy');
});

test('policyHtml carries title, version stamp and the page HTML, escaped where it must be', () => {
  const html = m.policyHtml({ title: 'A & B', version: '2.0', updated_at: '2026-03-29T09:37:31Z', content_html: '<p>body</p>' });
  assert.ok(html.includes('<title>A &amp; B</title>'));
  assert.ok(html.includes('Version 2.0 · updated 2026-03-29 · Source: Colony'));
  assert.ok(html.includes('<p>body</p>'));
});

test('agreementFileName is readable and safe for a folder listing', () => {
  assert.equal(m.agreementFileName({ full_name: 'Asha Rao' }, '2026-09-08T11:27:30Z'), 'Agreement — Asha Rao — 2026-09-08.pdf');
  assert.equal(m.agreementFileName({ full_name: 'A/B\\C: "D"' }, '2026-01-01'), 'Agreement — A B C D — 2026-01-01.pdf');
});

test('multipartBody puts JSON metadata first, then the bytes, with one boundary', () => {
  const { body, contentType } = m.multipartBody({ name: 'x', parents: ['f'] }, 'application/pdf', Buffer.from('%PDF'));
  const boundary = contentType.match(/boundary=(.+)$/)[1];
  const text = body.toString('latin1');
  assert.ok(text.startsWith(`--${boundary}\r\nContent-Type: application/json`));
  assert.ok(text.includes('{"name":"x","parents":["f"]}'));
  assert.ok(text.includes('Content-Type: application/pdf\r\n\r\n%PDF'));
  assert.ok(text.endsWith(`\r\n--${boundary}--`));
});

test('policyHtml drops the page\'s own leading H1 and "Last updated" line', () => {
  const html = m.policyHtml({ title: 'T', content_html: '<h1>Your Agency Remote Working Policy</h1><p><em>Last updated: March 29, 2026</em></p><h2>Our Vision</h2>' });
  assert.equal((html.match(/<h1>/g) || []).length, 1);
  assert.ok(!/Last updated: March/.test(html));
  assert.ok(html.includes('<h2>Our Vision</h2>'));
});
