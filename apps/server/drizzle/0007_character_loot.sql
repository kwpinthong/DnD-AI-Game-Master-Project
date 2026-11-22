CREATE TABLE `character_loot` (
	`member_id` text PRIMARY KEY NOT NULL,
	`offer_json` text,
	`chosen_json` text,
	`rerolls_used` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `character`(`member_id`) ON UPDATE no action ON DELETE cascade
);
