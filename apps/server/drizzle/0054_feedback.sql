CREATE TABLE `feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`member_id` text NOT NULL,
	`type` text NOT NULL,
	`text` text NOT NULL,
	`day` integer,
	`period` text,
	`turn` integer,
	`page` text NOT NULL,
	`user_agent` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `feedback_member_created` ON `feedback` (`member_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `feedback_created` ON `feedback` (`created_at`);--> statement-breakpoint
CREATE TABLE `feedback_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`feedback_id` integer NOT NULL,
	`action` text NOT NULL,
	`from` text NOT NULL,
	`to` text NOT NULL,
	`at` integer NOT NULL
);
