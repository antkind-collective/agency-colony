-- Partners can post bugs/features (5 Aug 2026). They get their OWN
-- feedback view — a partner sees only their posts and the replies on them,
-- never the internal board. Authorship becomes employee XOR partner, with
-- author_name denormalized so partners never need to read app.employees.

alter table app.feature_requests alter column employee_id drop not null;
alter table app.feature_requests add column author_partner_id uuid references app.partners(id);
alter table app.feature_requests add column author_name text;
alter table app.feature_requests add constraint fr_single_author_ck check (
  (employee_id is not null)::int + (author_partner_id is not null)::int = 1
);

alter table app.feature_request_replies alter column employee_id drop not null;
alter table app.feature_request_replies add column author_partner_id uuid references app.partners(id);
alter table app.feature_request_replies add column author_name text;
alter table app.feature_request_replies add constraint frr_single_author_ck check (
  (employee_id is not null)::int + (author_partner_id is not null)::int = 1
);

-- RLS: partner reads/writes ONLY their own posts + replies on them.
create policy feature_requests_select_partner on app.feature_requests for select
  using (author_partner_id = app.current_partner_id());
create policy feature_requests_insert_partner on app.feature_requests for insert
  with check (
    employee_id is null
    and author_partner_id = app.current_partner_id()
    and app.current_partner_id() is not null
  );

create policy feature_request_replies_select_partner on app.feature_request_replies for select
  using (exists (
    select 1 from app.feature_requests fr
    where fr.id = feature_request_id
      and fr.author_partner_id = app.current_partner_id()
  ));
create policy feature_request_replies_insert_partner on app.feature_request_replies for insert
  with check (
    employee_id is null
    and author_partner_id = app.current_partner_id()
    and exists (
      select 1 from app.feature_requests fr
      where fr.id = feature_request_id
        and fr.author_partner_id = app.current_partner_id()
    )
  );
