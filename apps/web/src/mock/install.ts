import { mockHttp } from './http.ts';
import { MockRoomServer, type MockPeer } from './room.ts';
import { scenarioById } from './scenarios.ts';

/**
 * The mock transport (GEN-100). Pages keep calling `fetch` and `new WebSocket` as they do against the real
 * server; with the mock installed, a URL on a mock base URL is answered here and anything else (Vite's own
 * files, its HMR socket) goes to the browser's real one. The base URL names the scenario and a cell, so each
 * gallery frame has its own server state: https://<cell>.<scenario>.mock.invalid (`.invalid` never resolves).
 */

const HOST_SUFFIX = '.mock.invalid';
export const MOCK_TOKEN = 'mock-token';

export const mockBaseUrl = (scenario: string, cell = 'app') => `https://${cell}.${scenario}${HOST_SUFFIX}`;

function mockTarget(url: string): { host: string; scenario: string } | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!host.endsWith(HOST_SUFFIX)) return null;
  const labels = host.slice(0, -HOST_SUFFIX.length).split('.');
  return { host, scenario: labels.at(-1) ?? 'normal' };
}

interface Options {
  /** Multiplies every scripted delay (tests use a small one). */
  timeScale: number;
  /** How long each HTTP answer and socket message takes, so loading states show for a moment. */
  latencyMs: number;
}
let options: Options = { timeScale: 1, latencyMs: 120 };
const servers = new Map<string, MockRoomServer>();

function serverFor(target: { host: string; scenario: string }): MockRoomServer {
  let server = servers.get(target.host);
  if (!server) {
    server = new MockRoomServer(scenarioById(target.scenario), { timeScale: options.timeScale });
    servers.set(target.host, server);
  }
  return server;
}

/** The room server behind a mock base URL (the gallery's simulate buttons). */
export function mockRoom(baseUrl: string): MockRoomServer {
  const target = mockTarget(baseUrl);
  if (!target) throw new Error(`not a mock base URL: ${baseUrl}`);
  return serverFor(target);
}

const later = (fn: () => void, ms = options.latencyMs) => setTimeout(fn, ms);

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function mockFetch(realFetch: typeof fetch): typeof fetch {
  return (input, init) => {
    const url = requestUrl(input);
    const target = mockTarget(url);
    if (!target) return realFetch(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const reply = mockHttp(scenarioById(target.scenario), { method, path: new URL(url).pathname, body });
    // `pending` = loading on purpose: it never settles, not even on abort, so the page stays in its loading state.
    if ('pending' in reply) return new Promise<Response>(() => {});
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const timer = later(() => {
        if ('fail' in reply) reject(new TypeError('Failed to fetch (mock: server unreachable)'));
        else resolve(new Response(reply.status === 204 ? null : JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } }));
      });
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  };
}

let RealWebSocket: typeof WebSocket | undefined;

type Handler<E> = ((event: E) => void) | null;

/** Stands in for the browser WebSocket on mock URLs; hands every other URL to the real one. */
class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  // `!`: the constructor returns a real WebSocket instead for a URL that is not a mock one.
  readonly url!: string;
  readyState = 0;
  onopen: Handler<Event> = null;
  onmessage: Handler<{ data: string }> = null;
  onclose: Handler<{ code: number; reason: string; wasClean: boolean }> = null;
  onerror: Handler<Event> = null;
  private readonly server!: MockRoomServer;
  private readonly peer!: MockPeer;
  private helloDone = false;

  constructor(url: string | URL, protocols?: string | string[]) {
    const href = String(url);
    const target = mockTarget(href);
    if (!target) {
      if (!RealWebSocket) throw new Error('WebSocket is not available');
      return new RealWebSocket(href, protocols) as unknown as MockWebSocket;
    }
    this.url = href;
    this.server = serverFor(target);
    this.peer = {
      deliver: (message) => {
        // serialised now: the server keeps changing its state after sending it
        const data = JSON.stringify(message);
        later(() => {
          if (this.readyState === MockWebSocket.OPEN) this.onmessage?.({ data });
        });
      },
      drop: () => this.closed(1006),
    };
    later(() => {
      if (this.readyState !== MockWebSocket.CONNECTING) return;
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.(new Event('open'));
    });
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error('mock socket is not open');
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      message = data;
    }
    later(() => {
      if (this.readyState !== MockWebSocket.OPEN) return;
      if (this.helloDone) this.server.receive(this.peer, message);
      else {
        this.helloDone = true;
        this.server.hello(this.peer, message);
      }
    });
  }

  close(): void {
    this.server.leave(this.peer);
    this.closed(1000);
  }

  addEventListener(): void {}
  removeEventListener(): void {}

  private closed(code: number): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    later(() => this.onclose?.({ code, reason: '', wasClean: code === 1000 }));
  }
}

/**
 * Puts the mock in front of `fetch` and `WebSocket`; returns the undo (tests). Only boot.tsx (dev, VITE_MOCK=1)
 * and the tests call it.
 */
export function installMock(opts: Partial<Options> = {}): () => void {
  options = { timeScale: 1, latencyMs: 120, ...opts };
  const realFetch = globalThis.fetch;
  RealWebSocket = globalThis.WebSocket;
  const realWs = RealWebSocket;
  globalThis.fetch = mockFetch(realFetch);
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  return () => {
    for (const server of servers.values()) server.stop();
    servers.clear();
    globalThis.fetch = realFetch;
    globalThis.WebSocket = realWs;
  };
}
