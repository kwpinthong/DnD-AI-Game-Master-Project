CREATE TABLE `character_presence` (
	`member_id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`ref` text NOT NULL,
	`location_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `character_presence_ref_unique` ON `character_presence` (`ref`);--> statement-breakpoint
CREATE INDEX `character_presence_game_location` ON `character_presence` (`game_id`,`location_id`);--> statement-breakpoint
CREATE TABLE `known_name` (
	`viewer_member_id` text NOT NULL,
	`subject_member_id` text NOT NULL,
	`how` text NOT NULL,
	`learned_at` integer NOT NULL,
	PRIMARY KEY(`viewer_member_id`, `subject_member_id`),
	FOREIGN KEY (`viewer_member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subject_member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `npc_bond` (
	`member_id` text NOT NULL,
	`npc_id` text NOT NULL,
	`affinity` integer DEFAULT 0 NOT NULL,
	`name_revealed` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`member_id`, `npc_id`),
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
