-- Website traffic from Google Analytics, pulled by Colony itself (26 Oct 2026).
--
-- One 'website' row per client in app.client_analytics, refreshed every Monday
-- by website-analytics-sync (the previous Monday-Sunday, in step with the
-- weekly LinkedIn / Meta uploads). Nobody uploads it, so uploaded_by is null.
--
-- Which client reads which GA4 property lives in app_config.website_analytics:
--   { "<client uuid>": { "property_id": "<GA4 property number>" } }
-- Access is granted in Google Analytics, not here: the property must list
-- colony-provisioning@your-project.iam.gserviceaccount.com as a Viewer, and
-- the Google Analytics Data API is on in the youragency-colony Cloud project.

alter table app.client_analytics drop constraint client_analytics_report_type_check;
alter table app.client_analytics add constraint client_analytics_report_type_check
  check (report_type = any (array['content', 'followers', 'visitors', 'instagram', 'instagram_audience',
                                  'facebook', 'community_pulse', 'website']));

-- youragency.com = GA4 property 514000078 ("Your Agency Website"); client "Your Agency".
insert into app.app_config (key, value)
values ('website_analytics', '{"0087c1a8-0b55-453c-9b12-7fa62a720b4b": {"property_id": "514000078"}}'::jsonb)
on conflict (key) do nothing;
