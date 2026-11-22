CREATE TABLE `tag_source_use` (
	`game_id` text NOT NULL,
	`member_id` text NOT NULL,
	`source_id` text NOT NULL,
	`day` integer NOT NULL,
	`uses` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`member_id`, `source_id`, `day`),
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tag_source_use_game` ON `tag_source_use` (`game_id`);