CREATE TABLE `game_ending` (
	`game_id` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`path` text NOT NULL,
	`outcomes` text NOT NULL,
	`narrated_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `game_event_state` ADD `ending_path` text;--> statement-breakpoint
ALTER TABLE `character_presence` ADD `spawn_location_id` text;