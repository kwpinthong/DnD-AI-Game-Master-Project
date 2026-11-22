-- GEN-063: 3 phases (MORNING / AFTERNOON / NIGHT) -> 4 periods x 2 turns. Existing games keep their
-- place: MORNING -> EOSORIA, AFTERNOON -> SOLARION, NIGHT -> HESPERION, at turn 1 (LEGACY_PHASES).
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_phase_action` (
	`game_id` text NOT NULL,
	`day` integer NOT NULL,
	`phase` text NOT NULL,
	`turn` integer DEFAULT 1 NOT NULL,
	`member_id` text NOT NULL,
	`text` text NOT NULL,
	`visibility` text NOT NULL,
	`rest` integer DEFAULT false NOT NULL,
	`submitted_at` integer NOT NULL,
	PRIMARY KEY(`game_id`, `day`, `phase`, `turn`, `member_id`),
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_phase_action`("game_id", "day", "phase", "turn", "member_id", "text", "visibility", "rest", "submitted_at")
SELECT "game_id", "day",
	CASE "phase" WHEN 'MORNING' THEN 'EOSORIA' WHEN 'AFTERNOON' THEN 'SOLARION' WHEN 'NIGHT' THEN 'HESPERION' ELSE "phase" END,
	1, "member_id", "text", "visibility", 0, "submitted_at"
FROM `phase_action`;--> statement-breakpoint
DROP TABLE `phase_action`;--> statement-breakpoint
ALTER TABLE `__new_phase_action` RENAME TO `phase_action`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `turn` integer;--> statement-breakpoint
ALTER TABLE `room_entry` ADD `turn` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE `room_entry` SET `phase` = CASE `phase` WHEN 'MORNING' THEN 'EOSORIA' WHEN 'AFTERNOON' THEN 'SOLARION' ELSE 'HESPERION' END
WHERE `phase` IN ('MORNING', 'AFTERNOON', 'NIGHT');--> statement-breakpoint
UPDATE `game_timeline` SET `phase` = CASE `phase` WHEN 'MORNING' THEN 'EOSORIA' WHEN 'AFTERNOON' THEN 'SOLARION' ELSE 'HESPERION' END
WHERE `phase` IN ('MORNING', 'AFTERNOON', 'NIGHT');--> statement-breakpoint
UPDATE `ai_usage` SET `phase` = CASE `phase` WHEN 'MORNING' THEN 'EOSORIA' WHEN 'AFTERNOON' THEN 'SOLARION' ELSE 'HESPERION' END
WHERE `phase` IN ('MORNING', 'AFTERNOON', 'NIGHT');--> statement-breakpoint
-- Engine state JSON (written by JSON.stringify, so no spaces): every point {day, phase} gains turn 1.
-- A quote inside player text is escaped (\"), so these patterns only match keys and values.
UPDATE `game_phase` SET `state` = replace(replace(replace(`state`,
	'"phase":"MORNING"', '"phase":"EOSORIA","turn":1'),
	'"phase":"AFTERNOON"', '"phase":"SOLARION","turn":1'),
	'"phase":"NIGHT"', '"phase":"HESPERION","turn":1');--> statement-breakpoint
-- Scenario copies: events are per period, no turn.
UPDATE `game_scenario` SET `data` = replace(replace(replace(`data`,
	'"phase":"MORNING"', '"phase":"EOSORIA"'),
	'"phase":"AFTERNOON"', '"phase":"SOLARION"'),
	'"phase":"NIGHT"', '"phase":"HESPERION"');
