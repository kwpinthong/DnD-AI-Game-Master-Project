// GEN-100 C5: fails the build when the production bundle holds mock code or the /dev/gallery route.
// `pnpm --filter @isekai/web build` runs it after vite build (node runs this .ts as is).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Strings only the mock layer, the gallery or the contract fixtures contain. */
export const MOCK_MARKERS = [
  'isekai-mock-layer',
  '.mock.invalid',
  '/dev/gallery',
  // a fixture text: the GEN-099 fixtures are dev data and never ship
  'ชายผมแดงตะโกนขายยาสมุนไพรเสียงดัง',
] as const;

export interface BuiltFile {
  name: string;
  content: string;
}

export function findMockLeaks(files: readonly BuiltFile[]): { file: string; marker: string }[] {
  return files.flatMap((f) => MOCK_MARKERS.filter((m) => f.content.includes(m)).map((marker) => ({ file: f.name, marker })));
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  const files = filesUnder(dist)
    .filter((f) => /\.(?:js|html|css|map)$/.test(f))
    .map((f) => ({ name: relative(dist, f), content: readFileSync(f, 'utf8') }));
  const leaks = findMockLeaks(files);
  if (files.length === 0) {
    console.error('check-bundle: dist/ is empty, run vite build first');
    process.exit(1);
  }
  if (leaks.length > 0) {
    for (const l of leaks) console.error(`check-bundle: ${l.file} contains "${l.marker}" (mock code in the production bundle)`);
    process.exit(1);
  }
  console.log(`check-bundle: ${files.length} files, no mock code and no /dev/gallery`);
}
