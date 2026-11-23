import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationsFolder } from '../src/db/client.ts';

interface Journal {
  entries: { idx: number; tag: string }[];
}
const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as Journal;
/** Found by name because the dispatcher may renumber it at merge. */
const index = journal.entries.findIndex((e) => e.tag.endsWith('_style_review'));

describe('migration style_review (GEN-178)', () => {
  it('is additive: no DROP, DELETE or ALTER … DROP', () => {
    expect(index).toBeGreaterThan(0);
    const code = readFileSync(join(migrationsFolder, `${journal.entries[index]!.tag}.sql`), 'utf8')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/\bdrop\b|\bdelete\b/i);
    expect(code).toMatch(/CREATE TABLE `style_review_round`/);
    expect(code).toMatch(/CREATE TABLE `style_rule_proposal`/);
  });
});
