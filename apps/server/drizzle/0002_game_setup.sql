CREATE TABLE `character` (
	`member_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `game` ADD `name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `game` ADD `mode` text DEFAULT 'online' NOT NULL;--> statement-breakpoint
ALTER TABLE `game` ADD `human_gm` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `game` ADD `owner_member_id` text;--> statement-breakpoint
ALTER TABLE `game` ADD `started_at` integer;--> statement-breakpoint
ALTER TABLE `member` ADD `role` text DEFAULT 'player' NOT NULL;--> statement-breakpoint
ALTER TABLE `member` ADD `kicked_at` integer;