import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * GEN-147: the game data (NPC, places, items, skills, start scenarios, rules, server lines, ...) lives here. The
 * asset files only seed a data set that has no row yet; a row is never overwritten by the files. `json` is the
 * data set's JSON array as saved (the loader's schema checked it).
 */
export const gameDataSet = sqliteTable('game_data_set', {
  /** A DATA_SETS name ("NPC", "NPC_Schedule", "Server_Lines", ...). */
  name: text('name').primaryKey(),
  json: text('json').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * One row per save or undo by the server owner: which set, its whole value before and after, the backup file
 * written before the change and when. `undone_at` marks an edit an undo has taken back.
 */
export const gameDataAudit = sqliteTable(
  'game_data_audit',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    action: text('action', { enum: ['edit', 'undo'] }).notNull(),
    oldJson: text('old_json').notNull(),
    newJson: text('new_json').notNull(),
    /** File name in the game-data backup folder holding `old_json`. */
    backupFile: text('backup_file').notNull(),
    undoneAt: integer('undone_at'),
    at: integer('at').notNull(),
  },
  (t) => [index('game_data_audit_name').on(t.name, t.id)],
);
