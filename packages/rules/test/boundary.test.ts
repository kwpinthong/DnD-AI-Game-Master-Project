import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// ADR GEN-019 S-4: rules code must not depend on Node APIs.
// Compiles a probe file with the package's own tsconfig settings, from inside the package,
// so module resolution sees the same node_modules as src/ does.
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const probeDir = join(pkgDir, '.boundary-check');
// typescript@7 does not export ./bin/tsc, so locate it from its package.json.
const tscBin = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc');

function compileProbe(name: string, source: string) {
  const dir = join(probeDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'probe.ts'), source);
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ extends: '../../tsconfig.json', include: ['probe.ts'] }),
  );
  return spawnSync(process.execPath, [tscBin, '-p', join(dir, 'tsconfig.json')], {
    encoding: 'utf8',
  });
}

afterAll(() => rmSync(probeDir, { recursive: true, force: true }));

describe('@dnd/rules has no Node dependency', { timeout: 60_000 }, () => {
  it('compiles plain rules code', () => {
    const result = compileProbe('plain', "import { rollDie } from '../../src/index.ts';\nexport const n: number = rollDie.length;\n");
    expect(result.stdout + result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it("fails to compile when rules code imports 'node:fs'", () => {
    const result = compileProbe('node-import', "import { readFileSync } from 'node:fs';\nexport const f = readFileSync;\n");
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/node:fs/);
  });
});
