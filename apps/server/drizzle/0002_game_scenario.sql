CREATE TABLE `game_scenario` (
	`game_id` text PRIMARY KEY NOT NULL,
	`schema_version` integer NOT NULL,
	`data` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade
);
