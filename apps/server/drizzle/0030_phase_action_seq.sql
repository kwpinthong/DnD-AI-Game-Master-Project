ALTER TABLE `phase_action` ADD `seq` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Q-263 (written by hand): actions stored before the column are numbered 1..n per game by creation order.
UPDATE `phase_action` SET `seq` = (
	SELECT count(*) FROM `phase_action` AS `earlier`
	WHERE `earlier`.`game_id` = `phase_action`.`game_id`
		AND (`earlier`.`submitted_at` < `phase_action`.`submitted_at`
			OR (`earlier`.`submitted_at` = `phase_action`.`submitted_at` AND `earlier`.`rowid` <= `phase_action`.`rowid`))
);
