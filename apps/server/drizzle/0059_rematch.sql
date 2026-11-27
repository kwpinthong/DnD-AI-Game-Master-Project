ALTER TABLE `game` ADD `previous_game_id` text;--> statement-breakpoint
ALTER TABLE `game` ADD `round_no` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `game_previous_game_id` ON `game` (`previous_game_id`);--> statement-breakpoint
ALTER TABLE `member` ADD `rematch_ready_at` integer;