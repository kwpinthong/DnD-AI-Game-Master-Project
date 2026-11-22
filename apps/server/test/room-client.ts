import { ROOM_PATH, RoomServerMessage, type RoomEntry, type RoomState } from '@isekai/protocol';
import type { RunningServer } from '../src/server.ts';

/**
 * A player's tab in the play room over a real WebSocket (GEN-056). Keeps every raw frame it got, so a
 * test can check what a socket never received, not only what it did.
 */
export interface RoomClient {
  /** Every frame as received, oldest first. */
  readonly raw: string[];
  readonly messages: RoomServerMessage[];
  entries(): RoomEntry[];
  lastRoom(): RoomState | undefined;
  send(message: unknown): void;
  action(text: string, visibility: 'public' | 'secret'): void;
  whisper(to: string, text: string): void;
  /** Resolves with the first message (counting from `from`) that matches; rejects after 5 s. */
  waitFor<T extends RoomServerMessage>(match: (m: RoomServerMessage) => m is T, from?: number): Promise<T>;
  waitFor(match: (m: RoomServerMessage) => boolean, from?: number): Promise<RoomServerMessage>;
  closed: Promise<{ code: number }>;
  close(): Promise<void>;
}

export function roomUrl(server: RunningServer): string {
  return `${server.url.replace(/^http/, 'ws')}${ROOM_PATH}`;
}

export async function openRoom(
  server: RunningServer,
  options: { token?: string; afterSeq?: number; headers?: Record<string, string> } = {},
): Promise<RoomClient> {
  // Node's WebSocket (undici) takes extra headers as its second argument.
  const init = options.headers ? ({ headers: options.headers } as unknown as string[]) : undefined;
  const ws = new WebSocket(roomUrl(server), init);
  const raw: string[] = [];
  const messages: RoomServerMessage[] = [];
  const waiters: (() => void)[] = [];
  let resolveClosed: (v: { code: number }) => void = () => {};
  const closed = new Promise<{ code: number }>((r) => (resolveClosed = r));

  ws.addEventListener('message', (event) => {
    const text = String(event.data);
    raw.push(text);
    messages.push(RoomServerMessage.parse(JSON.parse(text)));
    for (const w of [...waiters]) w();
  });
  ws.addEventListener('close', (event) => {
    resolveClosed({ code: event.code });
    for (const w of [...waiters]) w();
  });

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket failed to open')), { once: true });
  });

  const send = (message: unknown) => ws.send(JSON.stringify(message));
  if (options.token !== undefined) send({ type: 'hello', token: options.token, afterSeq: options.afterSeq ?? 0 });

  function waitFor(match: (m: RoomServerMessage) => boolean, from = 0): Promise<RoomServerMessage> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = messages.slice(from).find(match);
        if (found) {
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(check), 1);
          resolve(found);
        }
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(check), 1);
        reject(new Error(`no matching message; got ${raw.join('\n')}`));
      }, 5_000);
      waiters.push(check);
      check();
    });
  }

  return {
    raw,
    messages,
    entries: () => messages.flatMap((m) => (m.type === 'entry' ? [m.entry] : [])),
    lastRoom: () => messages.filter((m): m is RoomState => m.type === 'room').at(-1),
    send,
    action: (text, visibility) => send({ type: 'action', text, visibility }),
    whisper: (to, text) => send({ type: 'whisper', to, text }),
    waitFor: waitFor as RoomClient['waitFor'],
    closed,
    async close() {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.close();
        await closed;
      }
    },
  };
}

export const isRoom = (m: RoomServerMessage): m is RoomState => m.type === 'room';
export const isReady = (m: RoomServerMessage): m is Extract<RoomServerMessage, { type: 'ready' }> => m.type === 'ready';
export const isEntry = (m: RoomServerMessage): m is Extract<RoomServerMessage, { type: 'entry' }> => m.type === 'entry';
export const isRejected = (m: RoomServerMessage): m is Extract<RoomServerMessage, { type: 'action_rejected' }> =>
  m.type === 'action_rejected';
export const isAccepted = (m: RoomServerMessage): m is Extract<RoomServerMessage, { type: 'action_accepted' }> =>
  m.type === 'action_accepted';
export const isError = (m: RoomServerMessage): m is Extract<RoomServerMessage, { type: 'error' }> => m.type === 'error';
