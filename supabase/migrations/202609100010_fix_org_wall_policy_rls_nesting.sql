-- The org wall policy could not see the very rows it needed (10 Sep 2026).
--
-- feature_requests_select_partner was written as an inline EXISTS over
-- app.partners, joining the POST'S AUTHOR to the current partner to compare
-- orgs. A policy expression runs as the querying user, so that nested read is
-- itself subject to app.partners' RLS — and partners_select_own shows a partner
-- only their own row. The author's row came back empty, the EXISTS was false,
-- and Mira still saw exactly one post.
--
-- The replies policy worked because it called a SECURITY DEFINER function,
-- which is not subject to that RLS. Same fix here.
--
-- Note the earlier briefs_select policy is NOT affected: its inline EXISTS
-- reads only the CURRENT partner's own row, which partners_select_own allows.
-- Reading someone else's row is what breaks.

create or replace function app.partner_shares_org_with_partner(p_other_partner_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'app', 'public'
as $$
  select exists (
    select 1
    from app.partners author
    join app.partners me on me.id = app.current_partner_id()
    where author.id = p_other_partner_id
      and author.org = me.org
  );
$$;

drop policy if exists feature_requests_select_partner on app.feature_requests;
create policy feature_requests_select_partner on app.feature_requests
  for select
  using (app.partner_shares_org_with_partner(author_partner_id));
