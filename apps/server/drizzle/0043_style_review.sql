CREATE TABLE `style_review_round` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`signals` integer NOT NULL,
	`counts` text NOT NULL,
	`to_at` integer NOT NULL,
	`flag_snapshot` text NOT NULL,
	`patterns` text DEFAULT '[]' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `style_rule_proposal` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`round_id` integer NOT NULL,
	`kind` text NOT NULL,
	`npc_id` text,
	`content` text NOT NULL,
	`reason` text NOT NULL,
	`evidence` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`voice_version` integer,
	`decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `style_rule_proposal_round` ON `style_rule_proposal` (`round_id`);