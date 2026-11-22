CREATE TABLE `game_status` (
	`game_id` text NOT NULL,
	`holder_kind` text NOT NULL,
	`holder_id` text NOT NULL,
	`source` text NOT NULL,
	`label` text NOT NULL,
	`value` integer NOT NULL,
	`from_turn` integer NOT NULL,
	`until_turn` integer NOT NULL,
	`cast_by` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`game_id`, `holder_kind`, `holder_id`, `source`),
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `game_status_game` ON `game_status` (`game_id`);