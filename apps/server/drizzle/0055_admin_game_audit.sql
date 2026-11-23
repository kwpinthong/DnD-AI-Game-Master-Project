CREATE TABLE `admin_game_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`action` text NOT NULL,
	`game_id` text NOT NULL,
	`member_id` text,
	`at` integer NOT NULL
);
