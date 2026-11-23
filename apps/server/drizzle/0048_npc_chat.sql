CREATE TABLE `npc_chat` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`member_id` text NOT NULL,
	`npc_id` text NOT NULL,
	`day` integer NOT NULL,
	`phase` text NOT NULL,
	`whisper` integer DEFAULT false NOT NULL,
	`text` text NOT NULL,
	`reply` text NOT NULL,
	`affinity` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `game`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `npc_chat_member_period` ON `npc_chat` (`member_id`,`day`,`phase`);