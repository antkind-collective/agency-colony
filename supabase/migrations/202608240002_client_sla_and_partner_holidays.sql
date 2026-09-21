-- Rhea's signed SLA (effective 17 Jul 2026) becomes the source of truth for
-- what the client is promised, and partners get to see the holiday calendar.
--
-- Why a NEW table rather than editing app.deliverable_sla: those rows are the
-- INTERNAL production SLAs, per discipline (Design takes 2 days on a carousel),
-- and they are what stamps sla_days when a deliverable is assigned. The doc
-- quotes END-TO-END client turnaround for the same carousel (3 working days,
-- copy + design together). Overwriting one with the other would have silently
-- rewritten every internal production estimate. They are different numbers
-- answering different questions, so they get different homes.
--
-- Ranges are stored as the doc states them (min/max) rather than flattened, so
-- the UI can show "3-4 working days" honestly and suggest the later date.
-- NULL days = the SLA deliberately refuses a number (scoped per project).

create table app.client_sla (
  deliverable_type text primary key,
  label            text not null,
  min_days         integer,
  max_days         integer,
  in_scope         boolean not null default true,
  note             text,
  updated_at       timestamptz not null default now()
);

comment on table app.client_sla is
  'Client-facing turnaround per the Your Agency x Example Collective SLA (17 Jul 2026). Working days, end-to-end. Internal per-discipline estimates live in app.deliverable_sla.';

insert into app.client_sla (deliverable_type, label, min_days, max_days, in_scope, note) values
  ('static',             'Social Media Static',            2,  2,  true,  null),
  ('carousel',           'Carousel',                       3,  3,  true,  null),
  ('story_set',          'Story Set (2)',                  2,  2,  true,  null),
  ('announcement_board', 'Announcement Board (set of 4)',  3,  3,  true,  null),
  ('short_form',         'Short Form (30 sec)',            3,  4,  true,  null),
  ('reel',               'Reel (45-60 sec)',               4,  5,  true,  null),
  ('event_highlight',    'Event Highlight Video',          3,  3,  true,  'May extend depending on the volume of raw footage to be reviewed, confirmed at briefing.'),
  ('motion_graphics',    'Motion Graphics',                8,  8,  true,  null),
  ('content_calendar',   'Content Calendar',               7,  7,  true,  null),
  ('campaign_concept',   'Campaign Concept',               7,  7,  true,  null),
  ('toolkit',            'Campaign Toolkit',              10, 12,  true,  null),
  ('adaptations',        'Campaign Adaptations',           5,  6,  true,  null),
  ('newsletter',         'Newsletter',                    15, 15,  true,  'Runs on its own monthly production calendar with editorial dependencies on the client team; milestones are agreed per edition. 15 working days is indicative, from finalised content inputs.'),
  ('slides_10',          'Presentation Slides (up to 10)', 7,  7,  false, null),
  ('slides_20',          'Presentation Slides (up to 20)',12, 12,  false, null),
  ('event_collateral',   'Print / Event Collateral Suite', 8,  8,  false, null),
  ('complex_animation',  'Complex / Character Animation', null, null, false, 'Scoped per project.');

alter table app.client_sla enable row level security;

-- Partners must read this: it is the promise being made TO them.
create policy client_sla_select on app.client_sla for select
  using (app.is_employee() or app.is_partner());
create policy client_sla_write on app.client_sla for all
  using (app.is_leadership_or_admin()) with check (app.is_leadership_or_admin());

-- Holidays: turnaround is quoted in WORKING days, so the client cannot sanity-check a
-- date without knowing which days Your Agency is closed (24 Aug 2026).
-- Public dates, nothing sensitive.
drop policy if exists public_holidays_select_all on app.public_holidays;
create policy public_holidays_select_all on app.public_holidays for select
  using (app.is_employee() or app.is_partner());
