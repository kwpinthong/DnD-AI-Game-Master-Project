-- GEN-171 (Q-325): the end page's ruling votes move to response_vote as 👍/👎. Every old 👍 (a ruling_vote
-- row) is copied as vote = 'up' with source_ref = 'ruling-' || the old ref. ruling_vote itself stays as it
-- was (additive only; the code stops reading it). A row already in response_vote is kept as it is, so
-- running this again changes nothing.
INSERT OR IGNORE INTO `response_vote` (`game_id`, `member_id`, `source_ref`, `vote`, `updated_at`)
SELECT `game_id`, `member_id`, 'ruling-' || `source_ref`, 'up', `created_at` FROM `ruling_vote`;
