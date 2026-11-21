import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isSecretHash, verifySecret } from '../src/auth/pin.ts';
import { loadConfig } from '../src/config.ts';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `pnpm --filter @isekai/server run create-code:hash` runs this with the code on stdin. */
function hashCli(stdin: string) {
  return spawnSync(process.execPath, ['src/auth/create-code-hash-cli.ts'], {
    cwd: serverDir,
    input: stdin,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

// Q-021: the server keeps only a scrypt hash of the create code (CREATE_CODE_HASH).
describe('create-code:hash (makes CREATE_CODE_HASH)', () => {
  it('prints a hash of the code read from stdin that the server accepts and verifies, never the code', async () => {
    const result = hashCli('ลับเฉพาะ 2026\n');

    expect(result.status).toBe(0);
    const hash = result.stdout.trim();
    expect(isSecretHash(hash)).toBe(true);
    expect(result.stdout + result.stderr).not.toContain('ลับเฉพาะ');
    expect(await verifySecret('ลับเฉพาะ 2026', hash)).toBe(true);
    expect(await verifySecret('ลับเฉพาะ 2027', hash)).toBe(false);
    expect(loadConfig({ CREATE_CODE_HASH: hash }).createCodeHash).toBe(hash);
  });

  it('refuses an empty code', () => {
    const result = hashCli('\n');

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });
});
