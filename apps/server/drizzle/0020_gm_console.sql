CREATE TABLE `gm_override` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`gm_member_id` text NOT NULL,
	`kind` text NOT NULL,
	`day` integer NOT NULL,
	`phase` text NOT NULL,
	`turn` integer NOT NULL,
	`target` text NOT NULL,
	`before` text NOT NULL,
	`after` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`gm_member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gm_override_game_turn` ON `gm_override` (`game_id`,`day`,`phase`,`turn`);