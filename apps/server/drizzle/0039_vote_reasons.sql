CREATE TABLE `response_correction` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`entry_id` integer NOT NULL,
	`original` text NOT NULL,
	`edited` text NOT NULL,
	`npc_name` text,
	`scene` text NOT NULL,
	`reasons` text DEFAULT '[]' NOT NULL,
	`player_names` text DEFAULT '[]' NOT NULL,
	`library_candidate` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `response_correction_entry` ON `response_correction` (`game_id`,`entry_id`);--> statement-breakpoint
ALTER TABLE `response_vote` ADD `reasons` text DEFAULT '[]' NOT NULL;