-- Circle's feedback board becomes the client team's own wall (10 Sep
-- 2026): "they should have their own wall there".
--
-- A partner could only ever see posts they had written themselves, so the
-- "wall" showed one person talking to nobody. Same reasoning as the briefs
-- change earlier today — Circle exists to give a client team shared sight of
-- shared work — so org membership is the boundary here too.
--
-- Reads only. Who may POST and who may REPLY are untouched: a partner still
-- writes only as themselves, and still replies only on their own thread. That
-- is deliberately conservative — widening replies is a separate call, and this
-- morning widening one function silently widened three write paths.
--
-- The org is read through the author's partner row rather than stored on the
-- request, so a partner moving org cannot strand their old posts in a wall
-- nobody can see.

create or replace function app.partner_shares_org_with_request(p_request_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'app', 'public'
as $$
  select exists (
    select 1
    from app.feature_requests fr
    join app.partners author on author.id = fr.author_partner_id
    join app.partners me on me.id = app.current_partner_id()
    where fr.id = p_request_id
      and author.org = me.org
  );
$$;

-- A client sees their org's posts. Your Agency's own internal requests have no
-- author_partner_id, so the join drops them: staff posts stay invisible on
-- Circle, which is the point of the two boards being separate.
drop policy if exists feature_requests_select_partner on app.feature_requests;
create policy feature_requests_select_partner on app.feature_requests
  for select
  using (
    exists (
      select 1
      from app.partners author
      join app.partners me on me.id = app.current_partner_id()
      where author.id = feature_requests.author_partner_id
        and author.org = me.org
    )
  );

-- Replies follow the post they belong to.
drop policy if exists feature_request_replies_select_partner on app.feature_request_replies;
create policy feature_request_replies_select_partner on app.feature_request_replies
  for select
  using (app.partner_shares_org_with_request(feature_request_id));
