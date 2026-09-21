-- Pipeline v2 (Rhea's the client feedback, 10 Aug): "Under revision" replaces the
-- ad-hoc delivered→in_creative reopen. Enum-add must be its own transaction.
alter type app.brief_status add value if not exists 'under_revision';
