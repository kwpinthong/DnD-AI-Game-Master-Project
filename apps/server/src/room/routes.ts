import { ROOM_HELLO_TIMEOUT_MS, ROOM_PATH, RoomClientMessage, type RoomErrorCode, type RoomServerMessage } from '@isekai/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { memberRowForToken, type Clock } from '../auth/join.ts';
import type { Db } from '../db/client.ts';
import { character, game } from '../db/schema.ts';
import type { MemberRow } from '../game/service.ts';
import type { GameAssets } from '../assets/load.ts';
import type { PhaseResolver } from './resolver.ts';
import { createRoomService, type RoomService } from './service.ts';

export interface RoomOptions {
  resolver: PhaseResolver;
  /** The game data (GEN-062): places and travel rules (GEN-066). */
  assets: GameAssets;
  /** WEB_ORIGIN: a browser socket from any other origin is refused before the upgrade. */
  webOrigins: readonly string[];
  log?: (line: string) => void;
}

/** Close codes (4000-4999 are the application's own). */
const CLOSE: Record<RoomErrorCode, number> = { bad_message: 4000, unauthorized: 4001, no_character: 4003, game_not_started: 4009 };

const ERROR_MESSAGE: Record<RoomErrorCode, string> = {
  bad_message: 'ข้อความไม่ถูกต้อง เชื่อมต่อใหม่อีกครั้ง',
  unauthorized: 'ยังไม่ได้เข้าเกม หรือ session หมดอายุ',
  no_character: 'ต้องสร้างตัวละครก่อนเข้าห้องเล่น',
  game_not_started: 'เกมยังไม่เริ่ม รอเจ้าของเกมกดเริ่มในห้องรอ',
};

/** Why `me` cannot enter the room yet; null = they can. The Human GM enters without a character. */
function entryRefusal(db: Db, me: MemberRow): RoomErrorCode | null {
  const row = db.select({ startedAt: game.startedAt }).from(game).where(eq(game.id, me.gameId)).get();
  if (!row || row.startedAt === null) return 'game_not_started';
  if (me.role === 'gm') return null;
  const own = db.select({ memberId: character.memberId }).from(character).where(eq(character.memberId, me.id)).get();
  return own ? null : 'no_character';
}

/**
 * GET /api/game/room (WebSocket, GEN-056). The first message must be `hello` with the bearer token (never in
 * the URL: URLs are logged); then the socket gets the missed entries, the room and `ready`, and may send
 * `action`s. The token, action text and names are never logged.
 */
export function registerRoomRoutes(app: FastifyInstance, db: Db, now: Clock, options: RoomOptions): RoomService {
  const room = createRoomService(db, now, options.resolver, options.assets, options.log ?? ((line) => console.log(line)));
  // Before the WebSocket plugin closes the sockets, so their close events find no room to update.
  app.addHook('preClose', async () => room.stop());

  app.get(
    ROOM_PATH,
    {
      websocket: true,
      preValidation: async (request, reply) => {
        // Browsers always send Origin; other clients still need a valid token in `hello`.
        const origin = request.headers.origin;
        if (origin !== undefined && !options.webOrigins.includes(origin)) return reply.code(403).send();
      },
    },
    (socket) => {
      let me: MemberRow | undefined;
      const reply = (message: RoomServerMessage) => socket.send(JSON.stringify(message));
      const refuse = (code: RoomErrorCode) => {
        reply({ type: 'error', code, message: ERROR_MESSAGE[code] });
        socket.close(CLOSE[code]);
      };
      const helloTimer = setTimeout(() => refuse('unauthorized'), ROOM_HELLO_TIMEOUT_MS);

      socket.on('message', (data) => {
        let parsed: ReturnType<typeof RoomClientMessage.safeParse>;
        try {
          parsed = RoomClientMessage.safeParse(JSON.parse(String(data)));
        } catch {
          return refuse('bad_message');
        }
        if (!parsed.success) return refuse('bad_message');
        const message = parsed.data;

        if (message.type === 'hello') {
          if (me) return refuse('bad_message');
          clearTimeout(helloTimer);
          const found = memberRowForToken(db, message.token, now);
          if (!found) return refuse('unauthorized');
          const refusal = entryRefusal(db, found);
          if (refusal) return refuse(refusal);
          me = found;
          room.join(socket, me, message.afterSeq);
          return;
        }

        if (!me) return refuse('unauthorized');
        if (message.type === 'whisper') return reply(room.whisper(socket, message));
        if (message.type === 'move') return reply(room.move(socket, message));
        reply(room.submit(socket, message));
      });

      socket.on('close', () => {
        clearTimeout(helloTimer);
        if (me) room.leave(socket);
      });
    },
  );
  return room;
}
