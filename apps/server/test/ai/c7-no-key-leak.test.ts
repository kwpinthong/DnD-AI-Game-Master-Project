import { CreateGameResponse } from '@isekai/protocol';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { providerFor } from '../../src/ai/registry.ts';
import { hashPin } from '../../src/auth/pin.ts';
import { startServer, type RunningServer } from '../../src/server.ts';
import { makeTempDir } from '../helpers.ts';
import { startAnthropicStub, type AnthropicStub } from './anthropic-stub.ts';
import { aiConfig, makeService, NAME_CANARY, trigger, usageRows, type ServiceHarness } from './fixtures.ts';

/** Looks like a real key (built from parts so the repo secret scan does not flag this file). */
const CREATE_CODE = 'c7-create-code';
const FAKE_KEY = 'sk-' + 'ant-' + 'api03-' + 'Zq9'.repeat(16);

// GEN-038 C7: Given logs and what the client receives / Then no API key.
describe('C7 the API key never leaves the server process', () => {
  let stub: AnthropicStub | undefined;
  let harness: ServiceHarness | undefined;
  let server: RunningServer | undefined;
  const temp = makeTempDir();
  afterAll(() => temp.cleanup());

  afterEach(async () => {
    harness?.cleanup();
    harness = undefined;
    await server?.close();
    server = undefined;
    await stub?.close();
    stub = undefined;
  });

  it('a provider error that echoes the key is redacted in logs, AiUsage and the error the room gets', async () => {
    // Worst case: the upstream error message contains the key itself.
    stub = await startAnthropicStub();
    stub.queue(
      { kind: 'status', status: 500, body: { type: 'error', error: { type: 'api_error', message: `boom for key ${FAKE_KEY}` } } },
      { kind: 'status', status: 401, body: { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${FAKE_KEY}` } } },
    );
    const config = aiConfig({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_BASE_URL: stub.baseUrl, AI_MAX_RETRIES: '1' });
    harness = makeService(providerFor(config), config);

    const result = await harness.service.call(trigger('game-c7'));

    expect(JSON.stringify(stub.requests[0]!.headers)).toContain(FAKE_KEY); // the key does reach the provider
    const everything = [
      ...harness.logs,
      JSON.stringify(usageRows(harness.opened.sqlite)),
      JSON.stringify(result),
      result.ok ? '' : `${result.error.message} ${result.error.detail ?? ''}`,
      JSON.stringify(harness.service.ready()),
    ].join('\n');
    expect(harness.logs.length).toBeGreaterThan(0);
    expect(everything).not.toContain(FAKE_KEY);
    expect(everything).not.toContain('Zq9Zq9Zq9');
    // Q-045: logs carry metadata only, never prompt text (where real names could slip in).
    expect(everything).not.toContain(NAME_CANARY);
  });

  it('the start log, /health, create game and join responses carry no key', async () => {
    const lines: string[] = [];
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: join(temp.dir, 'c7.sqlite'), createCodeHash: await hashPin(CREATE_CODE) },
      { ai: aiConfig({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: FAKE_KEY }), aiLog: (line) => lines.push(line) },
    );
    const post = (path: string, body: unknown) =>
      fetch(`${server!.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const health = await (await fetch(`${server.url}/health`)).text();
    const createRes = await post('/api/games', {
      createCode: CREATE_CODE,
      gameName: 'เกม C7',
      mode: 'online',
      humanGm: false,
      name: 'เจ้าของ',
      pin: '1234',
    });
    expect(createRes.status).toBe(200);
    const create = await createRes.text();
    const { game } = CreateGameResponse.parse(JSON.parse(create));
    const joinRes = await post('/api/join', { inviteCode: game.inviteCode, name: 'ทดสอบ', pin: '1234' });
    expect(joinRes.status).toBe(200);
    const join_ = await joinRes.text();
    const ready = JSON.stringify(server.ai.ready());
    expect(ready).toContain('"ok":true');
    for (const text of [health, create, join_, ready, ...lines]) expect(text).not.toContain(FAKE_KEY);
  });
});
