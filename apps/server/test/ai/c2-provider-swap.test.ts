import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiConfig } from '../../src/ai/config.ts';
import type { AiProvider } from '../../src/ai/provider.ts';
import { createMockProvider, mockReply } from '../../src/ai/providers/mock.ts';
import { providerFor } from '../../src/ai/registry.ts';
import { startAnthropicStub, type AnthropicStub } from './anthropic-stub.ts';
import { aiConfig, makeService, trigger, usageRows, type ServiceHarness } from './fixtures.ts';

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = join(serverRoot, '..', '..');

const VERDICT = { verdict: 'blocked', note: '{{p:p_a}} ติด Constraint ประตูล็อก' };

/** The same game-side scenario, whatever provider sits behind the service. */
async function scenario(provider: AiProvider, config: AiConfig): Promise<ServiceHarness> {
  const harness = makeService(provider, config);
  expect(harness.service.ready().ok).toBe(true);
  const result = await harness.service.call(trigger('game-c2'));
  expect(result).toEqual({ ok: true, value: VERDICT, attempts: 1 });
  const rows = usageRows(harness.opened.sqlite);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ game_id: 'game-c2', ok: 1, provider: provider.id });
  expect(rows[0]!.cost_usd_micros).toBeGreaterThan(0);
  return harness;
}

function filesUnder(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : path.endsWith('.ts') ? [path] : [];
  });
}

// GEN-038 C2: Given the same scenario test / When switched to another provider that implements
// AiProvider / Then no file in core, rooms, rules changes and the test passes.
describe('C2 swapping the provider', () => {
  let stub: AnthropicStub | undefined;
  let harness: ServiceHarness | undefined;

  afterEach(async () => {
    harness?.cleanup();
    harness = undefined;
    await stub?.close();
    stub = undefined;
  });

  it('passes with the Mock provider', async () => {
    const config = aiConfig({ AI_PROVIDER: 'mock' });
    harness = await scenario(createMockProvider(config, { steps: [mockReply.ok(VERDICT)] }), config);
  });

  it('passes unchanged with the Anthropic provider chosen by config (local stub, no network)', async () => {
    stub = await startAnthropicStub({ kind: 'json', value: VERDICT });
    const config = aiConfig({
      AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'test-key-not-real',
      ANTHROPIC_BASE_URL: stub.baseUrl,
    });
    const provider = providerFor(config);
    expect(provider.id).toBe('anthropic');
    harness = await scenario(provider, config);
    expect(stub.requests).toHaveLength(1);
  });

  it('core, rooms and rules name no provider, so a new provider needs no change there', () => {
    const watched = [
      ...filesUnder(join(serverRoot, 'src', 'ai', 'core')),
      ...filesUnder(join(serverRoot, 'src', 'rooms')),
      ...filesUnder(join(repoRoot, 'packages', 'rules', 'src')),
    ];
    expect(watched.length).toBeGreaterThan(0);
    const offending = watched.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return /providers\/|registry|anthropic|['"]mock['"]/i.test(source);
    });
    expect(offending.map((file) => relative(repoRoot, file))).toEqual([]);
  });
});
