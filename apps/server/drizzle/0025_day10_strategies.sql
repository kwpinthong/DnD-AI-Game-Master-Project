CREATE TABLE `strategy_outcome` (
	`game_id` text NOT NULL,
	`strategy_id` text NOT NULL,
	`outcome` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`game_id`, `strategy_id`),
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `strategy_participant` (
	`game_id` text NOT NULL,
	`member_id` text NOT NULL,
	`strategy_id` text NOT NULL,
	`role` text NOT NULL,
	`success` integer NOT NULL,
	`day` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`game_id`, `member_id`, `strategy_id`),
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
