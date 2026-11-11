// Finance's Invoices page opens on the month being paid (3 Nov 2026):
// in the first week, that is the month just gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const src = /function financeOpeningMonth\([\s\S]*?\n\}/.exec(app)[0];
const financeOpeningMonth = new Function(`${src}; return financeOpeningMonth;`)();

test('first week opens on last month, later on this month', () => {
  assert.equal(financeOpeningMonth(new Date(2026, 10, 2)), '2026-10');
  assert.equal(financeOpeningMonth(new Date(2026, 10, 7)), '2026-10');
  assert.equal(financeOpeningMonth(new Date(2026, 10, 8)), '2026-11');
  assert.equal(financeOpeningMonth(new Date(2027, 0, 3)), '2026-12');
});

test('the Invoices page uses it', () => {
  assert.match(app, /state\.invoiceMonth = financeOpeningMonth\(\)/);
});

// Late invoices file under the month being paid (4 Nov 2026).
const filingSrc = /function invoiceFilingMonth\([\s\S]*?\n\}/.exec(app)[0];
const invoiceFilingMonth = new Function(`function currentInvoiceMonth() { return 'CURRENT'; } ${filingSrc}; return invoiceFilingMonth;`)();

test('invoices in the first 7 days (IST) file under last month; reimbursements do not', () => {
  assert.equal(invoiceFilingMonth('invoice', new Date('2026-11-03T10:00:00Z')), '2026-10');
  assert.equal(invoiceFilingMonth('invoice', new Date('2026-11-07T18:00:00Z')), '2026-10', '11.30 PM IST on the 7th');
  assert.equal(invoiceFilingMonth('invoice', new Date('2026-11-07T19:00:00Z')), 'CURRENT', 'already the 8th in IST');
  assert.equal(invoiceFilingMonth('invoice', new Date('2027-01-02T10:00:00Z')), '2026-12');
  assert.equal(invoiceFilingMonth('reimbursement', new Date('2026-11-03T10:00:00Z')), 'CURRENT');
  assert.equal(invoiceFilingMonth('invoice', new Date('2026-11-20T10:00:00Z')), 'CURRENT');
});

test('uploads use it, and the database allows exactly that', async () => {
  assert.match(app, /const month = invoiceFilingMonth\(invoiceType\)/);
  const sql = readFileSync(new URL('../supabase/migrations/202611040003_invoices_late_previous_month.sql', import.meta.url), 'utf8');
  assert.match(sql, /invoice_type = 'invoice'[\s\S]*?<= 7[\s\S]*?interval '1 month'/);
});
