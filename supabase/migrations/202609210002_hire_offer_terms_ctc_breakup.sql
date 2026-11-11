-- CTC breakup for full-time hires, entered by Finance in Colony and printed
-- into Annexure B of the employment agreement (21 Sep 2026: "finance
-- needs to add the breakup of that CTC in the colony step").
--
-- Shape: [{ "component": "Basic", "annual": 600000 }, ...]. The components
-- must sum to ctc_annual; the app and the Papersign draft both check.
--
-- Access: unchanged. The column sits on app.hire_offer_terms, whose RLS
-- policy hire_offer_terms_crew limits every row to app.is_hiring_crew()
-- (leadership + Blake + Leo). Grants there are table-level, so the new
-- column needs no grant of its own and gets none.

alter table app.hire_offer_terms
  add column if not exists ctc_breakup jsonb;

alter table app.hire_offer_terms
  drop constraint if exists hire_offer_terms_ctc_breakup_is_array;
alter table app.hire_offer_terms
  add constraint hire_offer_terms_ctc_breakup_is_array
  check (ctc_breakup is null or jsonb_typeof(ctc_breakup) = 'array');
