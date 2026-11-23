import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationsFolder } from '../src/db/client.ts';

interface Journal {
  entries: { idx: number; tag: string }[];
}
const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as Journal;
/** Found by name because the dispatcher may renumber it at merge. */
const entry = journal.entries.find((e) => e.tag.endsWith('_npc_chat'));

describe('migration npc_chat (GEN-149)', () => {
  it('is additive: no DROP, DELETE or ALTER … DROP', () => {
    expect(entry).toBeDefined();
    const code = readFileSync(join(migrationsFolder, `${entry!.tag}.sql`), 'utf8')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(code).toMatch(/CREATE TABLE `npc_chat`/);
    // A statement that drops or deletes (the FOREIGN KEY's "ON DELETE cascade" is not one).
    expect(code).not.toMatch(/^\s*(drop|delete)\b|\balter\s+table[^;]*\bdrop\b/im);
  });
});
