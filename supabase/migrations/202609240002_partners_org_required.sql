-- S3 (24 Sep 2026): a partner's org is never assumed.
--
-- app.partners.org defaulted to 'Example Collective', and the Colony add bar
-- arrived pre-filled with it and fell back to it when cleared. Inviting a
-- second client without retyping the box made them a the client partner, reading all
-- of the client's briefs, comments, contacts and feedback. The add bar now requires
-- the org (resolvePartnerOrg, js/utils.js); this makes the database refuse an
-- insert that names none, whoever writes it.
--
-- briefs.org and org_contacts.org keep their defaults: force_partner_org()
-- overwrites them with the partner's own org on every partner insert, and the
-- staff-side inserts send org explicitly.

alter table app.partners alter column org drop default;

alter table app.partners drop constraint if exists partners_org_not_blank;
alter table app.partners add constraint partners_org_not_blank check (btrim(org) <> '');
