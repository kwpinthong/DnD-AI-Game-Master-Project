import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_TABS, type TabName } from '../src/assets/model.ts';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sheet');

/** The CSV of every fixture tab (test/fixtures/sheet/<Tab>.csv), as the sheet export gives it. */
export function fixtureCsv(): Partial<Record<TabName, string>> {
  const out: Partial<Record<TabName, string>> = {};
  for (const tab of ALL_TABS) {
    const file = join(fixtureDir, `${tab}.csv`);
    if (existsSync(file)) out[tab] = readFileSync(file, 'utf8');
  }
  return out;
}

/** Replaces one cell (sheet row number, header text) in a CSV made of simple unquoted or quoted cells. */
export function setCell(csv: string, row: number, header: string, value: string): string {
  const rows = parseSimple(csv);
  const col = rows[0]!.indexOf(header);
  if (col < 0) throw new Error(`no column ${header}`);
  rows[row - 1]![col] = value;
  return rows.map((r) => r.map(quote).join(',')).join('\n') + '\n';
}

/** Appends a copy of sheet row `row` (so the copy is the new last row). */
export function duplicateRow(csv: string, row: number): string {
  const rows = parseSimple(csv);
  rows.push([...rows[row - 1]!]);
  return rows.map((r) => r.map(quote).join(',')).join('\n') + '\n';
}

/** Drops `header` and every column after it. */
export function keepColumnsBefore(csv: string, header: string): string {
  const rows = parseSimple(csv);
  const col = rows[0]!.indexOf(header);
  if (col < 0) throw new Error(`no column ${header}`);
  return rows.map((r) => r.slice(0, col).map(quote).join(',')).join('\n') + '\n';
}

function quote(cell: string): string {
  return /[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

function parseSimple(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
