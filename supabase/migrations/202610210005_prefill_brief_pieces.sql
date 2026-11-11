-- 21 Oct 2026 (Alex: "yes prefill pieces"). When a brief reaches Your Agency
-- (ready_for_review: the client approved it, a the client coordinator raised it, or Your Agency
-- raised it in Colony), it gets one piece per deliverable the client ticked,
-- titled as on the form, due on the brief's date, with copy/design guessed by
-- type: Caption and Content calendar are copy only, everything else needs
-- both. Rhea or Mara then adjusts (rename, untick, remove). Briefs that
-- already have pieces are left alone, and nothing is backfilled: briefs
-- already in progress get an "Add the client's pieces" button instead
-- (app.prefill_brief_pieces).

create or replace function app_private.brief_piece_label(p_type text)
 returns text
 language sql
 immutable
 set search_path to 'app', 'public', 'extensions'
as $function$
  select case p_type
    when 'static' then 'Social media static'
    when 'caption' then 'Caption'
    when 'emailer' then 'Emailer'
    when 'carousel' then 'Carousel'
    when 'story_set' then 'Story set (2)'
    when 'short_form' then 'Short video (~30s)'
    when 'reel' then 'Reel (45–60s)'
    when 'event_highlight' then 'Event highlight video'
    when 'motion_graphics' then 'Motion graphics'
    when 'complex_animation' then 'Complex animation'
    when 'newsletter' then 'Newsletter'
    when 'slides_10' then 'Presentation slides (10)'
    when 'slides_20' then 'Presentation slides (20)'
    when 'announcement_board' then 'Announcement board'
    when 'content_calendar' then 'Content calendar'
    when 'campaign_concept' then 'Campaign concept'
    when 'toolkit' then 'Campaign toolkit'
    when 'adaptations' then 'Campaign adaptations'
    when 'event_collateral' then 'Event collateral suite'
    when 'other' then 'Other'
    else initcap(replace(p_type, '_', ' '))
  end;
$function$;
revoke all on function app_private.brief_piece_label(text) from public, anon, authenticated;

-- Inserts the pieces; returns how many. No caller check: only definer code
-- reaches app_private.
create or replace function app_private.prefill_brief_pieces_for(p_brief_id uuid)
 returns integer
 language plpgsql
 security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
declare
  v_brief app.briefs%rowtype;
  v_due timestamptz;
  v_count integer := 0;
  v_type text;
begin
  select * into v_brief from app.briefs where id = p_brief_id;
  if not found or v_brief.request_type <> 'brief' or v_brief.archived_at is not null then return 0; end if;
  if exists (select 1 from app.brief_deliverables d where d.brief_id = p_brief_id) then return 0; end if;
  v_due := case when coalesce(v_brief.revised_deadline, v_brief.deadline) is null then null
                else (coalesce(v_brief.revised_deadline, v_brief.deadline)::text || ' 18:00:00+05:30')::timestamptz end;
  foreach v_type in array coalesce(v_brief.requested_deliverables, '{}'::text[]) loop
    insert into app.brief_deliverables(brief_id, title, deliverable_type, needs_copy, needs_design, due_at)
    values (p_brief_id, app_private.brief_piece_label(v_type), v_type,
            true, v_type not in ('caption', 'content_calendar'), v_due);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;
revoke all on function app_private.prefill_brief_pieces_for(uuid) from public, anon, authenticated;

-- The button in the brief drawer, for briefs already in progress.
create or replace function app.prefill_brief_pieces(p_brief_id uuid)
 returns integer
 language plpgsql
 security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
begin
  if not app.is_brief_reviewer() then
    raise exception 'Only the account managers add pieces.';
  end if;
  return app_private.prefill_brief_pieces_for(p_brief_id);
end;
$function$;
revoke all on function app.prefill_brief_pieces(uuid) from public, anon, authenticated;
insert into app_private.callable_definer_functions(signature, reason)
values (app_private.fn_signature('app.prefill_brief_pieces(uuid)'::regprocedure),
        'Brief drawer "Add the client''s pieces": brief reviewers only (checked inside), one piece per requested deliverable when the brief has none')
on conflict do nothing;
grant execute on function app.prefill_brief_pieces(uuid) to authenticated;

create or replace function app_private.prefill_pieces_on_arrival()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'app', 'public', 'extensions'
as $function$
begin
  if new.request_type = 'brief' and new.status = 'ready_for_review'
     and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    perform app_private.prefill_brief_pieces_for(new.id);
  end if;
  return null;
end;
$function$;

drop trigger if exists trg_prefill_pieces_on_arrival on app.briefs;
create trigger trg_prefill_pieces_on_arrival
  after insert or update of status on app.briefs
  for each row execute function app_private.prefill_pieces_on_arrival();
