CREATE TABLE `game_phase` (
	`game_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `phase_action` (
	`game_id` text NOT NULL,
	`day` integer NOT NULL,
	`phase` text NOT NULL,
	`member_id` text NOT NULL,
	`text` text NOT NULL,
	`visibility` text NOT NULL,
	`submitted_at` integer NOT NULL,
	PRIMARY KEY(`game_id`, `day`, `phase`, `member_id`),
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `room_entry` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`kind` text NOT NULL,
	`day` integer NOT NULL,
	`phase` text NOT NULL,
	`location_id` text,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `room_entry_game` ON `room_entry` (`game_id`,`id`);--> statement-breakpoint
CREATE TABLE `room_entry_recipient` (
	`entry_id` integer NOT NULL,
	`member_id` text NOT NULL,
	PRIMARY KEY(`entry_id`, `member_id`),
	FOREIGN KEY (`entry_id`) REFERENCES `room_entry`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `room_entry_recipient_member` ON `room_entry_recipient` (`member_id`,`entry_id`);