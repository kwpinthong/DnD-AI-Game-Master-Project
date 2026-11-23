CREATE TABLE `npc_linger` (
	`game_id` text NOT NULL,
	`npc_id` text NOT NULL,
	`location_id` text NOT NULL,
	`used` integer NOT NULL,
	`talked` integer NOT NULL,
	PRIMARY KEY(`game_id`, `npc_id`),
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade
);
