CREATE TABLE `member_style` (
	`member_id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`player_key` text,
	`opt_out` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `member_style_key` ON `member_style` (`player_key`);--> statement-breakpoint
CREATE TABLE `player_style_pref` (
	`player_key` text PRIMARY KEY NOT NULL,
	`opt_out` integer NOT NULL,
	`updated_at` integer NOT NULL
);
