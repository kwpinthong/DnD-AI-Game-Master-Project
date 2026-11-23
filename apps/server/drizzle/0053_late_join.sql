CREATE TABLE `late_join` (
	`member_id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`joined_turn` integer NOT NULL,
	`spawned_turn` integer,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `late_join_game` ON `late_join` (`game_id`);