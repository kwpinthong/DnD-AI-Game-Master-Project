CREATE TABLE `game_event_state` (
	`game_id` text NOT NULL,
	`event_id` text NOT NULL,
	`status` text NOT NULL,
	`outcome` text,
	`outcome_source` text,
	`activated_at` integer,
	`resolved_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`game_id`, `event_id`),
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `game_timeline` (
	`game_id` text PRIMARY KEY NOT NULL,
	`day` integer NOT NULL,
	`phase` text NOT NULL,
	`ended` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade
);
