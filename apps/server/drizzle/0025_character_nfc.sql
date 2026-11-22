-- GEN-094 (Q-108): character text was stored NFKC, which split sara am (U+0E33) into nikhahit + sara aa
-- (U+0E4D U+0E32). NFC does not join them again, so they are joined here. NFKC made no other change to
-- Thai text, and every U+0E4D U+0E32 in these columns came from that split. Only the three text columns
-- change; updated_at and every other column stay as they are.
UPDATE `character` SET
	`name` = replace(`name`, char(3661, 3634), char(3635)),
	`appearance` = replace(`appearance`, char(3661, 3634), char(3635)),
	`personality` = replace(`personality`, char(3661, 3634), char(3635))
WHERE instr(`name` || `appearance` || `personality`, char(3661, 3634)) > 0;
