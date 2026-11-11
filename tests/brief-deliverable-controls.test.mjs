import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Brief pieces (21 Oct 2026, Rhea's workflow). The rows offer only what
// the database accepts (S19, 20 Oct): leads and AMs assign, owners mark their
// own part done, a refused save says so and emails nobody.
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

test('only leads and account managers get the pickers; design lists Art, copy lists Copy', () => {
  assert.match(app, /const canAssign = reviewer \|\| lead;/);
  assert.match(app, /if \(canAssign && p\.status !== 'delivered'\)/);
  assert.match(app, /pieceTeam\(kind === 'copy' \? 'Copy' : 'Art'\)/);
});

test('an owner marks only their own part done, from the actions column', () => {
  assert.match(app, /p\.needs_copy && p\.copy_assignee_id === state\.currentEmployeeId && !p\.copy_done_at/);
  assert.match(app, /p\.needs_design && p\.design_assignee_id === state\.currentEmployeeId && !p\.design_done_at/);
  // Never inside the copy/design cell, where it pushed the row out of line.
  const slot = app.slice(app.indexOf('function pieceSlotHtml'), app.indexOf('function pieceRowHtml'));
  assert.doesNotMatch(slot, /data-piece-done/);
});

test('a refused piece save shows an error and sends no email', () => {
  const fn = app.slice(app.indexOf('async function pieceUpdate'), app.indexOf('async function bdAddPiece'));
  assert.match(fn, /\.update\(patch\)\.eq\('id', id\)\.select\('id'\)/);
  assert.match(fn, /if \(error \|\| !data\?\.length\)/);
  assert.doesNotMatch(fn, /notifyBriefEvent/);
});

// 21 Oct 2026: a double click added Rhea's link twice. Add link is off
// while saving (Colony and Circle), and reviewers can remove a link.
test('Add link cannot fire twice, and reviewers can remove a link', () => {
  for (const fn of ['async function bdAddLink', 'async function addPartnerBriefLink']) {
    const body = app.slice(app.indexOf(fn), app.indexOf(fn) + 900);
    assert.match(body, /if \(btn\?\.disabled\) return;\s*if \(btn\) btn\.disabled = true;/, fn);
  }
  assert.match(app, /renderBriefFilesHtml\(files, reviewer\)/);
  assert.match(app, /data-brief-link-remove/);
});

test('piece buttons are off while they save', () => {
  assert.match(app, /async function withBusyButton\(btn, fn\) \{\s*if \(btn\?\.disabled\) return;/);
});

// 21 Oct 2026 (Alex): a lead can mark copy or design "Not needed" from the
// picker, never both (the database refuses a piece that needs neither).
test('the pickers offer Not needed, and never for both parts', () => {
  assert.match(app, /<option value="none"\$\{needs \? '' : ' selected'\}\$\{otherNeeded \? '' : ' disabled'\}>Not needed<\/option>/);
  assert.match(app, /pick\.value === 'none' \? \{ \[need\]: false \} : \{ \[need\]: true, \[col\]: pick\.value \|\| null \}/);
});

// 21 Oct 2026 (Alex): Your Agency raises a brief in Colony, skipping the
// client's approval; the bell is pink while something waits.
test('a brief raised in Colony goes straight to Your Agency, by reviewers only', () => {
  assert.match(app, /const staffRaising = !state\.partnerProfile && Boolean\(staffBriefOrg\) && isBriefReviewer\(\);/);
  assert.match(app, /status: brief\.request_type === 'brief' \? 'ready_for_review' : 'submitted',\s*org: staffBriefOrg,\s*submitted_by_employee_id: state\.currentEmployeeId/);
  assert.match(app, /getElementById\('staffNewBriefBtn'\)\?\.classList\.toggle\('hidden', !isBriefReviewer\(\)\)/);
});

test('the bell turns pink while something is waiting', () => {
  assert.match(app, /getElementById\('notifyBellBtn'\)\?\.classList\.toggle\('has-items', unseen > 0\)/);
});
