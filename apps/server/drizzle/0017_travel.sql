CREATE TABLE `travel_pending` (
	`member_id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`location_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `travel_pending_game` ON `travel_pending` (`game_id`);