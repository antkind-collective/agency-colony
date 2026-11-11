-- 7 days' notice, for fractional hires (30 Oct 2026). The app offers
-- it only for fractionals and papersign.js refuses it for anyone else; the
-- table just stops refusing the value.
alter table app.hire_offer_terms drop constraint hire_offer_terms_notice_period_days_check;
alter table app.hire_offer_terms add constraint hire_offer_terms_notice_period_days_check
  check (notice_period_days in (7, 30, 60));
