CREATE TABLE `npc_ref` (
	`game_id` text NOT NULL,
	`npc_id` text NOT NULL,
	`ref` text NOT NULL,
	PRIMARY KEY(`game_id`, `npc_id`),
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `npc_ref_ref_unique` ON `npc_ref` (`ref`);--> statement-breakpoint
ALTER TABLE `npc_bond` ADD `companion_seq` integer;--> statement-breakpoint
ALTER TABLE `npc_bond` ADD `grade` text;--> statement-breakpoint
ALTER TABLE `npc_bond` ADD `form` text;--> statement-breakpoint
ALTER TABLE `npc_bond` ADD `crisis_aided` integer DEFAULT false NOT NULL;