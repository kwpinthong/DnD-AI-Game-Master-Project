import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASES, WEATHERS as PROTOCOL_WEATHERS } from '@isekai/protocol';
import { PERIODS, WEATHERS } from '@isekai/rules';
import { describe, expect, it } from 'vitest';

// GEN-191: the four periods and the live weathers are written out once, in @isekai/rules; everyone else imports them.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SOURCES = ['packages/rules/src/phase/types.ts', 'packages/rules/src/weather.ts'];

/** Built from parts so this file does not match itself. Separators `,` (array) or `|` (type union). */
const PERIOD_LIST = new RegExp(['EOSORIA', 'SOLARION', 'HESPERION', 'NOCTHERION'].map((p) => `['"]${p}['"]`).join('\\s*[,|]\\s*'));
const WEATHER_LIST = new RegExp(['Clear', 'Rain', 'Fog', 'Dark Night', 'Clear Night', 'Storm'].map((w) => `['"]${w}['"]`).join('\\s*[,|]\\s*'));

const sourceFiles = () =>
  execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'apps/*/src/*', 'packages/*/src/*'],{ cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(ts|tsx)$/.test(f));

it('the scan sees the src files (guards an empty file list)', () => {
  expect(sourceFiles()).toContain('apps/web/src/AdminDashboard.tsx');
});

describe('PERIODS / WEATHERS have one source (GEN-191)', () => {
  it('C1: no src file outside @isekai/rules writes the period list or the weather list out', () => {
    const copies = sourceFiles()
      .filter((f) => !SOURCES.includes(f))
      .filter((f) => {
        const text = readFileSync(join(repoRoot, f), 'utf8');
        return PERIOD_LIST.test(text) || WEATHER_LIST.test(text);
      });
    expect(copies).toEqual([]);
  });

  it('C1: @isekai/protocol re-exports the very same arrays', () => {
    expect(PHASES).toBe(PERIODS);
    expect(PROTOCOL_WEATHERS).toBe(WEATHERS);
  });
});
