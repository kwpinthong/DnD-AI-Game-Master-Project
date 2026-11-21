import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Scaffold migration only. The game tables arrive with the tasks that use them.

/** Key/value facts about this database (e.g. when it was created). */
export const appMeta = sqliteTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
