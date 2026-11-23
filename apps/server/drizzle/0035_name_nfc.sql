-- GEN-106 (Q-228): player and game names were stored NFKC, which split sara am (U+0E33) into nikhahit + sara aa
-- (U+0E4D U+0E32). Names are NFC now, so the split pair is joined here, in name and name_key alike (both came
-- from the same normalisation, so they change together and the duplicate check keeps working for old and new
-- names). A member is skipped, unchanged, when another member of the same game already holds the new name_key
-- (the unique index member_game_name_key would refuse it): no row is lost and the boot does not fail. Running
-- this again changes nothing. Only name / name_key of members and name of games change.
UPDATE `member` SET
	`name` = replace(`name`, char(3661, 3634), char(3635)),
	`name_key` = replace(`name_key`, char(3661, 3634), char(3635))
WHERE instr(`name` || `name_key`, char(3661, 3634)) > 0
	AND NOT EXISTS (
		SELECT 1 FROM `member` AS other
		WHERE other.`game_id` = `member`.`game_id`
			AND other.`id` <> `member`.`id`
			AND other.`name_key` = replace(`member`.`name_key`, char(3661, 3634), char(3635))
	);--> statement-breakpoint
UPDATE `game` SET `name` = replace(`name`, char(3661, 3634), char(3635))
WHERE instr(`name`, char(3661, 3634)) > 0;
