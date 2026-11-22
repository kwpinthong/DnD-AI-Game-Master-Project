CREATE TABLE `hidden_evidence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`location_id` text NOT NULL,
	`day` integer NOT NULL,
	`actor_member_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `hidden_evidence_place_day` ON `hidden_evidence` (`game_id`,`location_id`,`day`);--> statement-breakpoint
CREATE TABLE `player_bond` (
	`game_id` text NOT NULL,
	`member_low` text NOT NULL,
	`member_high` text NOT NULL,
	`alliance` integer DEFAULT false NOT NULL,
	`relationship` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`member_low`, `member_high`),
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_low`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_high`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `player_bond_game` ON `player_bond` (`game_id`);--> statement-breakpoint
ALTER TABLE `room_entry` ADD `from_member_id` text;--> statement-breakpoint
ALTER TABLE `room_entry` ADD `to_member_id` text;