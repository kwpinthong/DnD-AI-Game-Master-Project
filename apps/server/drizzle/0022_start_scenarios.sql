CREATE TABLE `character_origin` (
	`member_id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`tier_id` text NOT NULL,
	`kind` text NOT NULL,
	`spawn_point_id` text NOT NULL,
	`location_id` text NOT NULL,
	`start_scenario` text,
	`illness_left` integer,
	`knows_day12_secret` integer DEFAULT false NOT NULL,
	`curse_resist_rank` text,
	`narration` text,
	`narrated_at` integer,
	`rolled_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `character`(`member_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `character_origin_game` ON `character_origin` (`game_id`);--> statement-breakpoint
ALTER TABLE `character` ADD `coins` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `character` ADD `initial_title` text;