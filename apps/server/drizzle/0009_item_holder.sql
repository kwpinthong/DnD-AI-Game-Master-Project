CREATE TABLE `item_holder` (
	`item_id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`holder_member_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`holder_member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `item_holder_game` ON `item_holder` (`game_id`);