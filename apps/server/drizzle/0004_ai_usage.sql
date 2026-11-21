CREATE TABLE `ai_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`day` integer,
	`phase` text,
	`purpose` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`cached_input_tokens` integer NOT NULL,
	`cache_write_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_usd_micros` integer NOT NULL,
	`ok` integer NOT NULL,
	`failure_reason` text,
	`attempt` integer NOT NULL,
	`latency_ms` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_usage_game_created` ON `ai_usage` (`game_id`,`created_at`);