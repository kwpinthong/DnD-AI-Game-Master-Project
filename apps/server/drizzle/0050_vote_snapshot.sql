CREATE TABLE `vote_snapshot` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`entry_id` integer NOT NULL,
	`scene` text NOT NULL,
	`npc_name` text,
	`text` text NOT NULL,
	`up` integer NOT NULL,
	`down` integer NOT NULL,
	`players` integer NOT NULL,
	`verdict` text NOT NULL,
	`created_at` integer NOT NULL
);
