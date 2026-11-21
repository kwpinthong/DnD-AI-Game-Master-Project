import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local stand-in for the Anthropic Messages API (POST /v1/messages), so the real SDK inside
 * providers/anthropic.ts runs end to end without network. Tests never call the real API.
 */
export type StubStep =
  | { kind: 'json'; value: unknown; usage?: Partial<StubUsage> }
  | { kind: 'text'; text: string }
  | { kind: 'refusal' }
  | { kind: 'max_tokens' }
  | { kind: 'delay'; ms: number; then: StubStep }
  | { kind: 'status'; status: number; body: unknown };

interface StubUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface StubRequest {
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export interface AnthropicStub {
  baseUrl: string;
  requests: StubRequest[];
  /** Steps answered in order; when empty every request gets `fallback`. */
  queue(...steps: StubStep[]): void;
  close(): Promise<void>;
}

export async function startAnthropicStub(fallback: StubStep = { kind: 'json', value: {} }): Promise<AnthropicStub> {
  const requests: StubRequest[] = [];
  const steps: StubStep[] = [];
  const timers = new Set<NodeJS.Timeout>();

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ headers: req.headers, body });
      const answer = (step: StubStep): void => {
        if (step.kind === 'delay') {
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (!res.destroyed) answer(step.then);
          }, step.ms);
          timers.add(timer);
          return;
        }
        if (step.kind === 'status') {
          res.writeHead(step.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(step.body));
          return;
        }
        const usage: StubUsage = {
          input_tokens: 1200,
          output_tokens: 300,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          ...(step.kind === 'json' ? step.usage : {}),
        };
        const text =
          step.kind === 'json' ? JSON.stringify(step.value) : step.kind === 'text' ? step.text : '';
        const stopReason = step.kind === 'refusal' ? 'refusal' : step.kind === 'max_tokens' ? 'max_tokens' : 'end_turn';
        res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_stub' });
        res.end(
          JSON.stringify({
            id: 'msg_stub',
            type: 'message',
            role: 'assistant',
            model: body.model ?? 'unknown',
            content: text ? [{ type: 'text', text }] : [],
            stop_reason: stopReason,
            stop_sequence: null,
            stop_details: step.kind === 'refusal' ? { type: 'refusal', category: null, explanation: null } : null,
            usage,
          }),
        );
      };
      answer(steps.shift() ?? fallback);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    queue: (...more) => steps.push(...more),
    close: () =>
      new Promise((resolve) => {
        for (const timer of timers) clearTimeout(timer);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
