ALTER TABLE `character` ADD `name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `character` ADD `appearance` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `character` ADD `personality` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `character` ADD `hp` integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE `character` ADD `hp_max` integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE `character` ADD `stamina` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `character` ADD `stamina_max` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `character` ADD `reputation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `character` ADD `karma` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `character` ADD `updated_at` integer;