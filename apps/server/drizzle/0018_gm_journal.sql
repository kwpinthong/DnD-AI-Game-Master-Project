CREATE TABLE `gm_journal` (
	`game_id` text NOT NULL,
	`member_id` text NOT NULL,
	`kind` text NOT NULL,
	`day` integer NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`member_id`, `kind`, `day`),
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gm_journal_game` ON `gm_journal` (`game_id`);