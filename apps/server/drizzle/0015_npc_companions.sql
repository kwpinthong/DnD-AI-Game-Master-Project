CREATE TABLE `karma_day` (
	`member_id` text NOT NULL,
	`day` integer NOT NULL,
	`min` integer NOT NULL,
	`max` integer NOT NULL,
	PRIMARY KEY(`member_id`, `day`),
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `npc_activity` (
	`member_id` text NOT NULL,
	`npc_id` text NOT NULL,
	`day` integer NOT NULL,
	`period` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`member_id`, `npc_id`, `day`, `period`),
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `npc_flag` (
	`member_id` text NOT NULL,
	`npc_id` text NOT NULL,
	`flag` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`day` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`member_id`, `npc_id`, `flag`),
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `npc_ref` (
	`game_id` text NOT NULL,
	`npc_id` text NOT NULL,
	`ref` text NOT NULL,
	PRIMARY KEY(`game_id`, `npc_id`),
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `npc_ref_ref_unique` ON `npc_ref` (`ref`);--> statement-breakpoint
CREATE TABLE `npc_reward` (
	`member_id` text NOT NULL,
	`npc_id` text NOT NULL,
	`reward` text NOT NULL,
	`kind` text NOT NULL,
	`granted_at` integer NOT NULL,
	PRIMARY KEY(`member_id`, `npc_id`, `reward`),
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `npc_bond` ADD `companion_seq` integer;--> statement-breakpoint
ALTER TABLE `npc_bond` ADD `evolved_grade` text;--> statement-breakpoint
ALTER TABLE `npc_bond` ADD `evolved_alignment` text;