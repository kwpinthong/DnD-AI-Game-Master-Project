ALTER TABLE `game_event_state` ADD `outcome_side` text;--> statement-breakpoint
-- Q-243: until now the AI GM wrote the side as the first word of the outcome text ("Good: ...", "Evil: ...",
-- "Neutral: ...", or the sheet's joined label "Good/Neutral: ..."). The side moves to outcome_side (the first
-- side named) and the text keeps only what happened. Only outcomes the AI GM set (outcome_source 'ai') with
-- exactly such a prefix change; scenario defaults and every other column stay as they are.
UPDATE `game_event_state` SET
	`outcome_side` = CASE
		WHEN lower(ltrim(`outcome`)) LIKE 'good%' THEN 'good'
		WHEN lower(ltrim(`outcome`)) LIKE 'evil%' THEN 'evil'
		ELSE 'neutral'
	END,
	`outcome` = trim(substr(`outcome`, instr(`outcome`, ':') + 1))
WHERE `outcome_source` = 'ai'
	AND instr(`outcome`, ':') > 1
	AND replace(lower(trim(substr(`outcome`, 1, instr(`outcome`, ':') - 1))), ' ', '') IN (
		'good', 'evil', 'neutral',
		'good/neutral', 'good/evil', 'evil/good', 'evil/neutral', 'neutral/good', 'neutral/evil'
	)
	AND trim(substr(`outcome`, instr(`outcome`, ':') + 1)) <> '';
