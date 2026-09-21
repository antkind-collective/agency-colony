-- Facebook page analytics (10 Sep 2026).
--
-- Facebook rides the same row shape as Instagram: one row per client per
-- report type, daily figures in metrics_data. The only thing stopping it was
-- this CHECK, which would have refused the very first upload.
--
-- Kept as an allow-list rather than dropped: report_type decides which tab a
-- row renders in, and a typo silently creating an eighth, invisible report
-- type is exactly what this guards against.

alter table app.client_analytics drop constraint if exists client_analytics_report_type_check;
alter table app.client_analytics add constraint client_analytics_report_type_check
  check (report_type = any (array[
    'content', 'followers', 'visitors',
    'instagram', 'instagram_audience',
    'facebook',
    'community_pulse'
  ]));
