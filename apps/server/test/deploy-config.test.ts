import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The deploy config files are read as text: .railway/railway.ts is type-checked separately against
// the Railway SDK (`pnpm run typecheck:infra`), and Node has no TOML parser. These checks pin what
// the Cases rely on.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

/** The string literal assigned to `key:` (single-quoted), or the template literal for DB_PATH. */
function literal(source: string, key: string): string | undefined {
  return source.match(new RegExp(`\\b${key}:\\s*'([^']*)'`))?.[1];
}

describe('Railway service config (.railway/railway.ts)', () => {
  const source = read('.railway/railway.ts');
  const mount = source.match(/const VOLUME_MOUNT = '([^']+)'/)?.[1];

  it('C7: deploys only after GET /health answers (and /health is a real route)', () => {
    expect(literal(source, 'healthcheckPath')).toBe('/health');
    expect(read('apps/server/src/server.ts')).toContain("app.get('/health'");
  });

  it('C6: restarts the server by itself when it crashes, with one replica', () => {
    expect(literal(source, 'restartPolicyType')).toBe('ON_FAILURE');
    expect(source).toMatch(/numReplicas:\s*1\b/);
  });

  it('C6: DB_PATH points into the mounted volume and NODE_ENV is production', () => {
    expect(mount).toBe('/data');
    expect(source).toMatch(/volumeMounts:\s*\{\s*\[VOLUME_MOUNT\]:\s*data\s*\}/);
    expect(source).toContain('DB_PATH: `${VOLUME_MOUNT}/isekai.sqlite`');
    expect(posix.dirname(`${mount}/isekai.sqlite`)).toBe(mount);
    expect(literal(source, 'NODE_ENV')).toBe('production');
  });

  it('C5: migrations run at start (volume mounted), not in a pre-deploy container without the volume', () => {
    expect(source).not.toMatch(/preDeploy\w*:/);
    const start = literal(source, 'startCommand');
    expect(start).toBe('node apps/server/src/index.ts');
    expect(existsSync(join(repoRoot, start!.split(' ')[1]!))).toBe(true);
    expect(read('apps/server/src/server.ts')).toMatch(/openDatabase\(config\.dbPath\)/);
  });

  it('C4: WEB_ORIGIN and the invite code are kept from Railway, not written in the repo', () => {
    expect(source).toMatch(/WEB_ORIGIN:\s*preserve\(\)/);
    expect(source).toMatch(/BOOTSTRAP_INVITE_CODE:\s*preserve\(\)/);
  });

  it('pins Node 26 for Railpack, matching engines.node', () => {
    expect(literal(source, 'RAILPACK_NODE_VERSION')).toBe('26');
    expect((JSON.parse(read('package.json')) as { engines: { node: string } }).engines.node).toBe('>=26');
  });
});

describe('deploy guide (docs/deploy.md) matches the config files', () => {
  const guide = read('docs/deploy.md');
  const source = read('.railway/railway.ts');

  it.each(['startCommand', 'healthcheckPath'])('uses the same %s as .railway/railway.ts', (key) => {
    expect(guide).toContain(`\`${literal(source, key)}\``);
  });

  it('names the same volume mount, DB_PATH, build command and Node version', () => {
    expect(guide).toContain('Mount Path** = `/data`');
    expect(guide).toContain('`DB_PATH=/data/isekai.sqlite`');
    expect(guide).toContain(`\`${literal(source, 'buildCommand')?.replaceAll('\\"', '"')}\``);
    expect(guide).toContain('`RAILPACK_NODE_VERSION=26`');
  });

  it('has a post-deploy check for every Case C1-C7', () => {
    for (const id of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']) expect(guide).toMatch(new RegExp(`^\\| ${id}\\b`, 'm'));
  });
});

describe('Netlify site config (netlify.toml)', () => {
  const toml = read('netlify.toml');
  const value = (key: string) => toml.match(new RegExp(`^\\s*${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm'))?.[1];

  it('builds @isekai/web (and the workspace packages it uses) and publishes its dist', () => {
    expect(value('command')).toBe('pnpm --filter \\"@isekai/web...\\" run build');
    expect(value('publish')).toBe('apps/web/dist');
    expect(value('NODE_VERSION')).toBe('26');
  });

  it('serves index.html for every path (SPA fallback, status 200)', () => {
    expect(toml).toMatch(/\[\[redirects\]\]\s*from = "\/\*"\s*to = "\/index\.html"\s*status = 200/);
  });

  it('C4: VITE_API_URL comes from the Netlify environment, not the file', () => {
    expect(toml).not.toMatch(/^\s*VITE_API_URL\s*=/m);
  });
});
