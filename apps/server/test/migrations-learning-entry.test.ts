import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationsFolder } from '../src/db/client.ts';

interface Journal {
  entries: { idx: number; tag: string }[];
}
const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as Journal;
/** Found by name because the dispatcher may renumber it at merge. */
const entry = journal.entries.find((e) => e.tag.endsWith('_learning_entry'));

describe('migration learning_entry (GEN-080)', () => {
  it('is additive: two new tables, no DROP, DELETE or ALTER … DROP', () => {
    expect(entry).toBeDefined();
    const code = readFileSync(join(migrationsFolder, `${entry!.tag}.sql`), 'utf8')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/\bdrop\b|\bdelete\b/i);
    expect(code).toMatch(/CREATE TABLE `learning_entry`/);
    expect(code).toMatch(/CREATE TABLE `learning_extract`/);
  });

  it('GEN-082 player_style is additive too: two new tables, no DROP, DELETE or ALTER … DROP', () => {
    const style = journal.entries.find((e) => e.tag.endsWith('_player_style'));
    expect(style).toBeDefined();
    // The member foreign key's "ON DELETE cascade" is a rule, not a DELETE statement.
    const code = readFileSync(join(migrationsFolder, `${style!.tag}.sql`), 'utf8').replace(/\r\n/g, '\n').replace(/ON DELETE cascade/g, '');
    expect(code).not.toMatch(/\bdrop\b|\bdelete\b|\balter\b/i);
    expect(code).toMatch(/CREATE TABLE `member_style`/);
    expect(code).toMatch(/CREATE TABLE `player_style_pref`/);
  });
});
