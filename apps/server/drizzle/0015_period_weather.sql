CREATE TABLE `period_weather` (
	`game_id` text NOT NULL,
	`day` integer NOT NULL,
	`phase` text NOT NULL,
	`weather` text NOT NULL,
	`disaster` integer NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`game_id`, `day`, `phase`),
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade
);
