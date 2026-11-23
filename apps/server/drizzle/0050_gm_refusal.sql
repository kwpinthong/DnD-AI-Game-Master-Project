CREATE TABLE `gm_refusal` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`purpose` text NOT NULL,
	`stage` text NOT NULL,
	`errors` text NOT NULL,
	`proposal` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `gm_refusal_game` ON `gm_refusal` (`game_id`,`id`);