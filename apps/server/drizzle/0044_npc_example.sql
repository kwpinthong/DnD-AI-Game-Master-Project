CREATE TABLE `npc_example` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`npc_id` text NOT NULL,
	`npc_name` text NOT NULL,
	`scene` text NOT NULL,
	`text` text NOT NULL,
	`source` text NOT NULL,
	`game_id` text NOT NULL,
	`entry_id` integer NOT NULL,
	`correction_id` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `npc_example_npc` ON `npc_example` (`npc_id`);