-- Newsletter analytics (3 Nov 2026): Antenna's Beehiiv subscriber
-- export, uploaded weekly by the Chrome task. One 'newsletter' row per client
-- in app.client_analytics: weekly and monthly sign-ups, unsubscribes, list
-- size and sources. Counts only: the upload strips emails and names before
-- anything is stored. Beehiiv's free plan has no API or webhooks.

alter table app.client_analytics drop constraint client_analytics_report_type_check;
alter table app.client_analytics add constraint client_analytics_report_type_check
  check (report_type = any (array['content', 'followers', 'visitors', 'instagram', 'instagram_audience',
                                  'facebook', 'community_pulse', 'website', 'newsletter']));
