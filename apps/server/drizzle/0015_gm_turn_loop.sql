CREATE TABLE `gm_constraint` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`member_id` text NOT NULL,
	`text` text NOT NULL,
	`reason` text NOT NULL,
	`day` integer NOT NULL,
	`released_day` integer,
	`release_reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gm_constraint_game` ON `gm_constraint` (`game_id`,`released_day`);--> statement-breakpoint
CREATE TABLE `gm_memory` (
	`game_id` text NOT NULL,
	`kind` text NOT NULL,
	`day` integer NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`game_id`, `kind`, `day`),
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `gm_turn` (
	`game_id` text NOT NULL,
	`day` integer NOT NULL,
	`phase` text NOT NULL,
	`turn` integer NOT NULL,
	`status` text NOT NULL,
	`proposal` text NOT NULL,
	`rolls` text NOT NULL,
	`narrations` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`game_id`, `day`, `phase`, `turn`),
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade
);
