CREATE TABLE `game_data_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`action` text NOT NULL,
	`old_json` text NOT NULL,
	`new_json` text NOT NULL,
	`backup_file` text NOT NULL,
	`undone_at` integer,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `game_data_audit_name` ON `game_data_audit` (`name`,`id`);--> statement-breakpoint
CREATE TABLE `game_data_set` (
	`name` text PRIMARY KEY NOT NULL,
	`json` text NOT NULL,
	`updated_at` integer NOT NULL
);
