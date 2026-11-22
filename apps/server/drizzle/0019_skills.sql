CREATE TABLE `owned_skill` (
	`member_id` text NOT NULL,
	`game_id` text NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`day` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`member_id`, `name`),
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `owned_skill_game` ON `owned_skill` (`game_id`);--> statement-breakpoint
CREATE TABLE `period_karma` (
	`member_id` text NOT NULL,
	`day` integer NOT NULL,
	`period` text NOT NULL,
	`start` integer NOT NULL,
	PRIMARY KEY(`member_id`, `day`, `period`),
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `skill_activity` (
	`member_id` text NOT NULL,
	`activity` text NOT NULL,
	`day` integer NOT NULL,
	`period` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`member_id`, `activity`, `day`, `period`),
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `skill_flag` (
	`member_id` text NOT NULL,
	`flag` text NOT NULL,
	`count` integer NOT NULL,
	`day` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`member_id`, `flag`),
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `skill_reveal` (
	`member_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`day` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`member_id`, `kind`, `name`),
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
