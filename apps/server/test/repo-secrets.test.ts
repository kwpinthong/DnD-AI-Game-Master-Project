import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// GEN-041a C4: Given the repo / Then no API key, create code or Railway / Netlify token is in it.
// Secrets live in Railway > Variables and Netlify > Environment variables only.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const thisFile = relative(repoRoot, fileURLToPath(import.meta.url)).replaceAll('\\', '/');

/** Values that look like real credentials. Built from parts so this file does not match itself. */
const SECRET_PATTERNS: Array<[name: string, pattern: RegExp]> = [
  ['Anthropic API key', new RegExp('sk-' + 'ant-[A-Za-z0-9_-]{20,}')],
  ['OpenAI-style API key', new RegExp('\\bsk-' + '(?:proj-)?[A-Za-z0-9_-]{32,}')],
  ['Netlify token', new RegExp('\\bnf[pcoub]' + '_[A-Za-z0-9]{30,}')],
  ['GitHub token', new RegExp('\\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_' + 'pat_[A-Za-z0-9_]{30,})')],
  ['private key', new RegExp('-----BEGIN [A-Z ]*PRIVATE ' + 'KEY-----')],
  [
    'Railway / Netlify token variable with a value',
    new RegExp('\\b(?:RAILWAY_(?:API_)?TOKEN|NETLIFY_AUTH_' + 'TOKEN)\\s*[=:]\\s*["\']?[A-Za-z0-9_-]{8,}'),
  ],
  [
    'secret env variable with a value',
    new RegExp(
      '^[ \\t]*(?:export[ \\t]+)?(?:[A-Z0-9_]*API_KEY|APP_SECRET|CREATE_' +
        'CODE(?:_HASH)?)[ \\t]*=[ \\t]*["\']?[^\\s"\'#]+',
      'm',
    ),
  ],
];

/** File names that only ever hold secrets or data: env files (but not *.example) and databases. */
const FORBIDDEN_FILE = /^(?:\.env(?:\..+)?|.+\.env|.+\.sqlite(?:-.+)?|.+\.db)$/;

export function findSecrets(text: string): string[] {
  return SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

const trackedFiles = () =>
  execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' }).split('\0').filter(Boolean);

describe('secret scan of tracked files (git ls-files)', () => {
  it('finds no secret-looking value in any tracked file', () => {
    const hits: string[] = [];
    for (const file of trackedFiles()) {
      if (file === thisFile || file === 'pnpm-lock.yaml') continue;
      const text = readFileSync(join(repoRoot, file), 'utf8');
      for (const name of findSecrets(text)) hits.push(`${file}: ${name}`);
    }
    expect(hits).toEqual([]);
  });

  it('tracks no env file (only *.example) and no database file', () => {
    const offending = trackedFiles().filter((file) => {
      const name = basename(file);
      return FORBIDDEN_FILE.test(name) && !name.endsWith('.example');
    });
    expect(offending).toEqual([]);
  });

  it('the scanner itself flags each kind of secret (so a clean result means something)', () => {
    const samples = [
      'ANTHROPIC_API_KEY=' + 'sk-' + 'ant-api03-' + 'a'.repeat(40),
      'const key = "' + 'sk-' + 'proj-' + 'b'.repeat(40) + '"',
      'token: ' + 'nfp' + '_' + 'c'.repeat(40),
      'ghp' + '_' + 'd'.repeat(36),
      '-----BEGIN OPENSSH PRIVATE ' + 'KEY-----',
      'RAILWAY_' + 'TOKEN=0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b',
      'NETLIFY_AUTH_' + 'TOKEN: abcdef123456',
      'CREATE_' + 'CODE=hunter22',
      'CREATE_CODE_' + 'HASH=scrypt$16384$8$1$c2FsdA==$aGFzaA==',
    ];
    for (const sample of samples) expect(findSecrets(sample), sample).not.toEqual([]);
    // Names without values (env examples, docs) are fine.
    expect(findSecrets('CREATE_CODE=\nCREATE_CODE_HASH=\n# RAILWAY_TOKEN is never committed')).toEqual([]);
  });
});

describe('.gitignore', () => {
  const ignored = (path: string) => spawnSync('git', ['check-ignore', '-q', path], { cwd: repoRoot }).status === 0;

  it.each([
    '.env',
    '.env.local',
    'apps/web/.env.production',
    'apps/server/server.env',
    'config/railway.env',
    'data/isekai.sqlite',
    'apps/server/isekai.sqlite-wal',
    'backups/isekai-20261122.sqlite',
    '.netlify/state.json',
  ])('ignores %s', (path) => {
    expect(ignored(path)).toBe(true);
  });

  it.each(['apps/web/.env.example', 'apps/server/server.env.example'])('keeps %s', (path) => {
    expect(ignored(path)).toBe(false);
  });
});
