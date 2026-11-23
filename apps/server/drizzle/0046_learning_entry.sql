CREATE TABLE `learning_entry` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`source_game_id` text NOT NULL,
	`source_game_name` text NOT NULL,
	`source_score` real,
	`source_ref` text NOT NULL,
	`content` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `learning_entry_key` ON `learning_entry` (`source_game_id`,`type`,`source_ref`);--> statement-breakpoint
CREATE INDEX `learning_entry_type_status` ON `learning_entry` (`type`,`status`);--> statement-breakpoint
CREATE TABLE `learning_extract` (
	`game_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`updated_at` integer NOT NULL
);
