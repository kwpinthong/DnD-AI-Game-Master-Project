// GEN-100 C5: the production build carries no mock code and no /dev/gallery route. `pnpm build` runs
// scripts/check-bundle.ts on dist/ after vite build; these tests keep that check honest.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MOCK_MARKERS, findMockLeaks } from '../scripts/check-bundle.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
}

describe('C5 bundle check', () => {
  it('each marker really is in the mock / gallery code, so a leak would show', () => {
    const devCode = [...filesUnder(join(root, 'src', 'mock')), ...filesUnder(join(root, 'src', 'dev'))].map((f) => readFileSync(f, 'utf8')).join('\n');
    const fixtures = read('../../packages/protocol/src/contract/fixtures.ts');
    for (const marker of MOCK_MARKERS) expect(devCode.includes(marker) || fixtures.includes(marker)).toBe(true);
  });

  it('finds a marker in a built file and passes a clean one', () => {
    expect(findMockLeaks([{ name: 'assets/index.js', content: 'const a=1;' }])).toEqual([]);
    const leaks = findMockLeaks([
      { name: 'assets/index.js', content: 'fetch("https://app.normal.mock.invalid/health")' },
      { name: 'assets/gallery.js', content: 'if(p==="/dev/gallery")' },
    ]);
    expect(leaks.map((l) => l.file)).toEqual(['assets/index.js', 'assets/gallery.js']);
  });

  it('the build script runs the check after vite build', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toMatch(/vite build && node scripts\/check-bundle\.ts$/);
  });
});
