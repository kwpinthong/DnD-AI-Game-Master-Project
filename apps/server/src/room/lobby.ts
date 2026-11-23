import type { LobbyReadyEvent, LobbyStartBlockedEvent } from '@isekai/protocol';
import type { RoomSocket } from './service.ts';

/**
 * ISK-017: the lobby's open sockets per game (`hello` with `lobby: true` before the start). They only hear
 * `lobby_ready` / `lobby_start_blocked`; the start itself is seen on GET /api/game as before.
 */
export interface Lobby {
  join(gameId: string, socket: RoomSocket): void;
  leave(socket: RoomSocket): void;
  send(gameId: string, message: LobbyReadyEvent | LobbyStartBlockedEvent): void;
}

export function createLobby(): Lobby {
  const games = new Map<string, Set<RoomSocket>>();
  const gameOf = new Map<RoomSocket, string>();
  return {
    join(gameId, socket) {
      let sockets = games.get(gameId);
      if (!sockets) games.set(gameId, (sockets = new Set()));
      sockets.add(socket);
      gameOf.set(socket, gameId);
    },
    leave(socket) {
      const gameId = gameOf.get(socket);
      if (gameId === undefined) return;
      gameOf.delete(socket);
      const sockets = games.get(gameId)!;
      sockets.delete(socket);
      if (sockets.size === 0) games.delete(gameId);
    },
    send(gameId, message) {
      const text = JSON.stringify(message);
      for (const socket of games.get(gameId) ?? []) socket.send(text);
    },
  };
}
