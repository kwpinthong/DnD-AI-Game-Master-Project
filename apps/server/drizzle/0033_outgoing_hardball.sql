CREATE TABLE `response_vote` (
	`game_id` text NOT NULL,
	`member_id` text NOT NULL,
	`source_ref` text NOT NULL,
	`vote` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`game_id`, `member_id`, `source_ref`),
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
