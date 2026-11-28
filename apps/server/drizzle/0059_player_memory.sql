CREATE TABLE `player_memory` (
	`game_id` text NOT NULL,
	`member_id` text NOT NULL,
	`topic_id` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`first_day` integer NOT NULL,
	`last_day` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`member_id`, `topic_id`),
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `player_memory_game` ON `player_memory` (`game_id`);--> statement-breakpoint
ALTER TABLE `member` ADD `memory_pending_from_day` integer;--> statement-breakpoint
-- ISK-098: a game from before keeps what each player's journal saga held as their first topic "เรื่องที่ผ่านมา"
-- (days 1 through the last day summarised). The text is copied whole; the server fits it to maxChars with
-- clampReply when it starts (gm/player-memory.ts fitStoredTopics). The saga rows stay as they are.
INSERT INTO `player_memory` (`game_id`, `member_id`, `topic_id`, `title`, `summary`, `first_day`, `last_day`, `updated_at`)
SELECT s.`game_id`, s.`member_id`, lower(hex(randomblob(4))), 'เรื่องที่ผ่านมา', s.`text`, 1,
	(SELECT max(j.`day`) FROM `gm_journal` AS j WHERE j.`member_id` = s.`member_id`), s.`created_at`
FROM `gm_journal` AS s
WHERE s.`kind` = 'saga' AND trim(s.`text`) <> ''
	AND s.`day` = (SELECT max(o.`day`) FROM `gm_journal` AS o WHERE o.`member_id` = s.`member_id` AND o.`kind` = 'saga');