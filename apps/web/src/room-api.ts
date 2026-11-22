import { ROOM_PATH, RoomServerMessage, type ActionVisibility, type RoomEntry, type RoomErrorCode, type RoomState } from '@isekai/protocol';

/** ws(s)://<server>/api/game/room. An empty base URL means this page's own origin (the Vite proxy). */
export function roomSocketUrl(baseUrl: string, pageUrl: string = window.location.href): string {
  const url = new URL(baseUrl || pageUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = (baseUrl ? url.pathname.replace(/\/+$/, '') : '') + ROOM_PATH;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export type RoomConnectionStatus = 'connecting' | 'online' | 'reconnecting' | 'closed';

export interface RoomListener {
  status(status: RoomConnectionStatus): void;
  room(state: RoomState): void;
  /** Each entry once: an entry the tab already has (same or lower seq) is never passed on again. */
  entry(entry: RoomEntry): void;
  /** The server answered the last action. */
  actionReply(reply: { ok: true } | { ok: false; message: string }): void;
  /** The server answered the last Whisper (GEN-067). */
  whisperReply(reply: { ok: true } | { ok: false; message: string }): void;
  /** The server refused the socket for good (no reconnect). */
  fatal(code: RoomErrorCode, message: string): void;
}

export interface RoomConnection {
  sendAction(text: string, visibility: ActionVisibility, rest?: boolean): boolean;
  /** `to`: the ally's ref from `you.allies`. */
  sendWhisper(to: string, text: string): boolean;
  /** Asks the AI GM to try a stuck turn again (GEN-057). */
  sendRetry(): boolean;
  close(): void;
}

/** Waits before reconnecting: 1 s, 2 s, 4 s, then every 8 s. */
const backoff = (attempt: number) => Math.min(8_000, 1_000 * 2 ** attempt);

/**
 * One play-room socket that reconnects by itself after a drop. The token goes in the first message, not
 * the URL. On every (re)connect it asks for the entries after the last one it has (C6).
 */
export function connectRoom(baseUrl: string, token: string, listener: RoomListener): RoomConnection {
  let socket: WebSocket | undefined;
  let lastSeq = 0;
  let attempt = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function open() {
    listener.status(attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = new WebSocket(roomSocketUrl(baseUrl));
    socket = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token, afterSeq: lastSeq }));
    ws.onmessage = (event) => {
      let message: RoomServerMessage;
      try {
        message = RoomServerMessage.parse(JSON.parse(String(event.data)));
      } catch {
        return;
      }
      switch (message.type) {
        case 'room':
          return listener.room(message);
        case 'entry':
          if (message.entry.seq <= lastSeq) return;
          lastSeq = message.entry.seq;
          return listener.entry(message.entry);
        case 'ready':
          attempt = 0;
          return listener.status('online');
        case 'action_accepted':
          return listener.actionReply({ ok: true });
        case 'action_rejected':
          return listener.actionReply({ ok: false, message: message.message });
        case 'whisper_accepted':
          return listener.whisperReply({ ok: true });
        case 'whisper_rejected':
          return listener.whisperReply({ ok: false, message: message.message });
        case 'error':
          stopped = true;
          listener.status('closed');
          return listener.fatal(message.code, message.message);
      }
    };
    ws.onclose = () => {
      if (socket !== ws || stopped) return;
      attempt++;
      listener.status('reconnecting');
      timer = setTimeout(open, backoff(attempt - 1));
    };
  }

  open();
  return {
    sendAction(text, visibility, rest = false) {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify({ type: 'action', text, visibility, rest }));
      return true;
    },
    sendWhisper(to, text) {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify({ type: 'whisper', to, text }));
      return true;
    },
    sendRetry() {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify({ type: 'retry' }));
      return true;
    },
    close() {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    },
  };
}
