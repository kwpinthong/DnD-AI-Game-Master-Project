CREATE TABLE `game_close` (
	`game_id` text PRIMARY KEY NOT NULL,
	`game_name` text NOT NULL,
	`reason` text,
	`has_summary` integer NOT NULL,
	`closed_at` integer NOT NULL
);
