import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../../src/ai/config.ts';
import { AiServiceError } from '../../src/ai/core/service.ts';
import { startServer, type RunningServer } from '../../src/server.ts';
import { makeTempDir } from '../helpers.ts';
import { startAnthropicStub, type AnthropicStub } from './anthropic-stub.ts';
import { aiConfig, trigger, usageRows } from './fixtures.ts';

// GEN-038 C4: Given no API key and a provider that is not mock / When start / Then the server
// starts, but a game cannot be created or started, with a message saying why.
describe('C4 no API key for a real provider', () => {
  const temp = makeTempDir();
  afterAll(() => temp.cleanup());
  let server: RunningServer | undefined;
  let stub: AnthropicStub | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    await stub?.close();
    stub = undefined;
  });

  it('defaults to the Anthropic provider and claude-sonnet-5-5 (Q-018)', () => {
    const config = loadAiConfig({});
    expect(config.provider).toBe('anthropic');
    expect(config.model).toBe('claude-sonnet-5-5');
    expect(config.gameMonthlyUsd).toBe(20);
  });

  it('starts, serves /health, and reports why AI games cannot be created or started', async () => {
    stub = await startAnthropicStub();
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: join(temp.dir, 'c4.sqlite') },
      { ai: aiConfig({ AI_PROVIDER: 'anthropic', ANTHROPIC_BASE_URL: stub.baseUrl }), aiLog: () => {} },
    );
    const health = await fetch(`${server.url}/health`);
    expect(health.status).toBe(200);

    const readiness = server.ai.ready();
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      expect(readiness.code).toBe('ai_not_ready');
      expect(readiness.message).toMatch(/ANTHROPIC_API_KEY/);
      expect(readiness.message).toMatch(/สร้างหรือเริ่มเกม/);
    }

    const result = await server.ai.call(trigger('game-c4'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AiServiceError);
      expect(result.error.code).toBe('ai_not_ready');
      expect(result.error.audience).toBe('owner_gm');
      expect(result.error.message).toBe(readiness.ok ? '' : readiness.message);
    }
    expect(stub.requests).toHaveLength(0);
    expect(usageRows(server.db)).toHaveLength(0);
  });

  it('a whitespace-only key counts as missing', () => {
    const config = aiConfig({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '   ' });
    expect(config.anthropic.apiKey).toBeUndefined();
  });

  it('an unknown AI_PROVIDER is a config error naming the variable (fail fast, not a silent mock)', () => {
    expect(() => loadAiConfig({ AI_PROVIDER: 'anthropik' })).toThrow(/AI_PROVIDER/);
  });

  it('refuses retry, timeout and ceiling values that are not numbers and names the variable', () => {
    expect(() => loadAiConfig({ AI_MAX_RETRIES: 'two' })).toThrow(/AI_MAX_RETRIES/);
    expect(() => loadAiConfig({ AI_TIMEOUT_MS: '0' })).toThrow(/AI_TIMEOUT_MS/);
    expect(() => loadAiConfig({ AI_GAME_MONTHLY_USD: '-1' })).toThrow(/AI_GAME_MONTHLY_USD/);
  });
});
