CREATE TABLE `style_eval_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer NOT NULL,
	`provider` text NOT NULL,
	`models` text NOT NULL,
	`voice_version` integer NOT NULL,
	`cost_usd_micros` integer NOT NULL,
	`scenes` text NOT NULL,
	`marks` text DEFAULT '{}' NOT NULL
);
