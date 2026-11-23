CREATE TABLE `npc_memory` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`npc_id` text NOT NULL,
	`member_id` text NOT NULL,
	`day` integer NOT NULL,
	`phase` text NOT NULL,
	`text` text NOT NULL,
	`weight` text NOT NULL,
	`witnesses` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `npc_memory_pair` ON `npc_memory` (`game_id`,`member_id`,`npc_id`);