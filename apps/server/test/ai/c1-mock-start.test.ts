import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer, type RunningServer } from '../../src/server.ts';
import { freePort, makeTempDir } from '../helpers.ts';
import { aiConfig, trigger, usageRows, Verdict } from './fixtures.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

// GEN-038 C1: Given AI_PROVIDER=mock / When start server / Then the Mock is used and a game
// takes a trigger without network.
describe('C1 AI_PROVIDER=mock', () => {
  let temp = makeTempDir();
  let server: RunningServer | undefined;

  beforeEach(() => {
    temp = makeTempDir();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await server?.close();
    server = undefined;
    temp.cleanup();
  });

  it('starts with the Mock provider, ready, and answers a trigger with no network at all', async () => {
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: join(temp.dir, 'isekai.sqlite') },
      { ai: aiConfig({ AI_PROVIDER: 'mock' }), aiLog: () => {} },
    );
    expect(server.ai.ready()).toEqual({ ok: true, provider: 'mock', model: 'claude-sonnet-5-5' });

    const network = vi.fn(() => {
      throw new Error('network used');
    });
    vi.stubGlobal('fetch', network);

    const result = await server.ai.call(trigger('game-c1'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(Verdict.safeParse(result.value).success).toBe(true);
    expect(network).not.toHaveBeenCalled();

    const rows = usageRows(server.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ game_id: 'game-c1', purpose: 'gm_adjudicate', provider: 'mock', ok: 1, day: 1, phase: 'MORNING' });
  });

  it('the real start command (node src/index.ts) reports the Mock provider as ready', async () => {
    const port = await freePort();
    const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
    const child = spawn(process.execPath, ['apps/server/src/index.ts'], {
      cwd: repoRoot,
      env: { ...env, AI_PROVIDER: 'mock', PORT: String(port), DB_PATH: join(temp.dir, 'isekai.sqlite') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = await new Promise<string>((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error(`no start:\n${text}`)), 20_000);
      const onData = (chunk: Buffer) => {
        text += chunk.toString();
        if (text.includes('listening on')) {
          clearTimeout(timer);
          resolve(text);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('exit', (code) => reject(new Error(`exited ${code}:\n${text}`)));
    });
    child.removeAllListeners('exit');
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill();
    });
    expect(out).toMatch(/AI GM: provider mock, model claude-sonnet-5-5 \(ready\)/);
  });
});
