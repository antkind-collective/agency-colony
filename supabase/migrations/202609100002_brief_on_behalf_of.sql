-- Raise a brief on behalf of someone else (Mira Holt, 10 Sep 2026).
--
-- Adam posted a full design brief in Slack — West Asia convening poster,
-- Arabic version, references — because Slack is where he already was. Mira
-- asked whether Rhea could "consolidate for us to follow up and support
-- Adam". Today the only way is for someone to retype it, and the brief then
-- looks like it came from them: the person who actually asked disappears, and
-- with them the answer to "who do I go back to with a question?"
--
-- This is attribution, not permission. Anyone who can raise a brief can say it
-- is on someone else's behalf; it changes nothing about who may approve it or
-- see it, and it sends no email to the named person — they are told through the
-- channel they already used. It is deliberately NOT a foreign key: the whole
-- point is naming someone who has no account yet.

alter table app.briefs
  add column if not exists on_behalf_of_name text,
  add column if not exists on_behalf_of_email citext;

comment on column app.briefs.on_behalf_of_name is
  'Who actually asked for this, when someone else logged it for them. Free text on purpose — the named person usually has no account.';
comment on column app.briefs.on_behalf_of_email is
  'Optional contact for the person named in on_behalf_of_name. Colony never mails them from here; it is so the team can reach them.';

-- An email with no name is a value nobody can read on a card. Both or neither.
alter table app.briefs drop constraint if exists briefs_on_behalf_needs_name;
alter table app.briefs add constraint briefs_on_behalf_needs_name
  check (on_behalf_of_email is null or nullif(btrim(on_behalf_of_name), '') is not null);
