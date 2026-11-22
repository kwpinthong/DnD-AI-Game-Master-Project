import {
  ActionVisibility,
  actionTextProblem,
  normalizeActionText,
  type PlaceView,
  type RoomActionCode,
  type RoomEntry,
  type RoomLockCode,
  type RoomServerMessage,
  type RoomState,
} from '@isekai/protocol';
import {
  NIGHT_PERIOD,
  isDrowsy,
  phaseStep,
  secretQuotaUsed,
  type PhaseErrorCode,
  type PhaseState,
  type PlayerResult,
} from '@isekai/rules';
import { eq } from 'drizzle-orm';
import type { Clock } from '../auth/join.ts';
import type { Db, DbOrTx } from '../db/client.ts';
import { game } from '../db/schema.ts';
import { activeMembers, type MemberRow } from '../game/service.ts';
import { CryptoRng } from '../rng.ts';
import { getGameScenario } from '../scenario/store.ts';
import { forbiddenKeysIn } from '../visibility/guard.ts';
import { locationSnapshot, presenceOf } from '../visibility/store.ts';
import { witnessesOf } from '../visibility/views.ts';
import type { ClosedAction, PhaseResolution, PhaseResolver } from './resolver.ts';
import {
  ensurePhaseState,
  entriesFor,
  insertEntry,
  karmaOf,
  recordAction,
  savePhaseState,
  syncCharacterStats,
  type RoomEntryRow,
} from './store.ts';

/** What the room needs of a socket: send text, and nothing else. */
export interface RoomSocket {
  send(data: string): void;
}

const LOCK_MESSAGE: Record<RoomLockCode, string> = {
  not_a_player: 'GM ไม่มีตัวละคร จึงส่ง action ไม่ได้',
  exhausted: 'ตัวละครหมดแรง (Stamina 0) เทิร์นนี้ต้องนอนพัก ส่ง action ไม่ได้',
  unconscious: 'ตัวละครหมดสติ (HP 0) ส่ง action ไม่ได้จนกว่าจะฟื้น',
  resolving: 'เทิร์นนี้ปิดรับ action แล้ว กำลังสรุปผล รอเทิร์นถัดไป',
  game_ended: 'เกมจบแล้ว ส่ง action ไม่ได้',
};

const SECRET_QUOTA_MESSAGE = 'วันนี้ใช้ Secret ไปแล้ว (ได้วันละ 1 เทิร์น และฟรีอีก 1 เทิร์นในช่วง NOCTHERION) ส่งเป็น Public แทนได้';
const NIGHT_SECRET_QUOTA_MESSAGE = 'คืนนี้ใช้ Secret ฟรีของช่วง NOCTHERION ไปแล้ว (ได้คืนละ 1 เทิร์น) ส่งเป็น Public แทนได้';

export type SubmitReply = { type: 'action_accepted' } | { type: 'action_rejected'; code: RoomActionCode; message: string };

export interface RoomService {
  /** Registers an authenticated socket: replays entries after `afterSeq`, then sends the room and `ready`. */
  join(socket: RoomSocket, me: MemberRow, afterSeq: number): void;
  leave(socket: RoomSocket): void;
  submit(socket: RoomSocket, input: { text: string; visibility: string; rest?: boolean }): SubmitReply;
  /** Shutdown: forgets every socket (their close events no longer touch the database), then waits for running resolves. */
  stop(): Promise<void>;
}

/**
 * The play room (GEN-056). Presence lives in memory (who has a socket open); everything players must not
 * lose lives in the database: the engine state, the actions, and every feed / narration entry with its
 * recipients. All database work is synchronous (better-sqlite3), so a replay and the socket registration
 * happen in one tick and no live entry can slip between them.
 */
export function createRoomService(db: Db, now: Clock, resolver: PhaseResolver, log: (line: string) => void): RoomService {
  /** gameId → socket → member. */
  const rooms = new Map<string, Map<RoomSocket, MemberRow>>();
  const resolving = new Map<string, Promise<void>>();
  const rng = new CryptoRng();
  let stopped = false;

  function memberOf(socket: RoomSocket): MemberRow | undefined {
    for (const sockets of rooms.values()) {
      const me = sockets.get(socket);
      if (me) return me;
    }
    return undefined;
  }

  /** Every payload passes the GEN-050 guard; a payload with a GM-only key is dropped, never sent. */
  function send(socket: RoomSocket, message: RoomServerMessage): void {
    const leaks = forbiddenKeysIn(message);
    if (leaks.length > 0) {
      log(`[room] dropped a ${message.type} message with GM-only keys: ${leaks.join(', ')}`);
      return;
    }
    socket.send(JSON.stringify(message));
  }

  function placeView(db: DbOrTx, gameId: string, locationId: string | null): PlaceView | null {
    if (locationId === null) return null;
    const location = getGameScenario(db, gameId)?.locations.find((l) => l.id === locationId);
    return { id: locationId, name: location?.name ?? locationId };
  }

  function entryView(row: RoomEntryRow): RoomEntry {
    return {
      seq: row.id,
      kind: row.kind,
      day: row.day,
      phase: row.phase,
      turn: row.turn === 2 ? 2 : 1,
      place: placeView(db, row.gameId, row.locationId),
      text: row.text,
    };
  }

  function lockOf(me: MemberRow, state: PhaseState): RoomLockCode | null {
    if (me.role === 'gm' || !state.players[me.id]) return 'not_a_player';
    if (state.status === 'finale' || state.status === 'game_over') return 'game_ended';
    if (state.status === 'resolving') return 'resolving';
    const condition = state.players[me.id]!.condition;
    return condition === 'awake' ? null : condition;
  }

  function roomStateFor(me: MemberRow, state: PhaseState, members: MemberRow[], online: Set<string>, mode: 'online' | 'single'): RoomState {
    const lock = lockOf(me, state);
    const mine = state.submissions[me.id];
    const player = state.players[me.id];
    return {
      type: 'room',
      gameId: me.gameId,
      mode,
      day: state.day,
      phase: state.phase,
      turn: state.turn,
      status: state.status,
      members: members.map((m) => ({
        memberId: m.id,
        name: m.name,
        role: m.role,
        online: online.has(m.id),
        submitted: m.id in state.submissions,
      })),
      you: {
        memberId: me.id,
        role: me.role,
        place: me.role === 'gm' ? null : placeView(db, me.gameId, presenceOf(db, me.id)?.locationId ?? null),
        lock: lock ? { code: lock, message: LOCK_MESSAGE[lock] } : null,
        secretUsed: player ? secretQuotaUsed(player, state) : false,
        drowsy: player ? isDrowsy(player, state.day) : false,
        action: mine ? { text: mine.text, visibility: mine.visibility, rest: mine.rest === true } : null,
      },
    };
  }

  function broadcastRoom(gameId: string): void {
    const sockets = rooms.get(gameId);
    if (!sockets || sockets.size === 0) return;
    const state = ensurePhaseState(db, gameId, now());
    const members = activeMembers(db, gameId);
    const mode = db.select({ mode: game.mode }).from(game).where(eq(game.id, gameId)).get()?.mode ?? 'online';
    const online = new Set([...sockets.values()].map((m) => m.id));
    for (const [socket, me] of sockets) send(socket, roomStateFor(me, state, members, online, mode));
  }

  function deliver(gameId: string, rows: readonly { row: RoomEntryRow; recipients: ReadonlySet<string> }[]): void {
    const sockets = rooms.get(gameId);
    if (!sockets) return;
    for (const { row, recipients } of rows) {
      const message: RoomServerMessage = { type: 'entry', entry: entryView(row) };
      for (const [socket, me] of sockets) if (recipients.has(me.id)) send(socket, message);
    }
  }

  /** Who receives an entry: the GEN-050 witnesses (feed) or the one player (narration), plus the Human GM. */
  function recipientsOf(tx: DbOrTx, gameId: string, entry: NonNullable<PhaseResolution['entries']>[number]): Set<string> {
    const members = activeMembers(tx, gameId);
    const ids = new Set(members.map((m) => m.id));
    const recipients = new Set(members.filter((m) => m.role === 'gm').map((m) => m.id));
    if (entry.kind === 'narration') {
      if (ids.has(entry.memberId)) recipients.add(entry.memberId);
      return recipients;
    }
    const locations = locationSnapshot(tx, gameId);
    const actor = entry.actorMemberId !== null && ids.has(entry.actorMemberId) ? entry.actorMemberId : null;
    const witnesses =
      entry.locationId === null
        ? [...locations.keys(), ...(actor ? [actor] : [])]
        : witnessesOf({ locationId: entry.locationId, actorMemberId: actor, visibility: 'public' }, locations);
    for (const id of witnesses) if (ids.has(id)) recipients.add(id);
    return recipients;
  }

  /**
   * The resolver's results with every player's karma filled in from the character where the resolver did
   * not give one, so the engine's Q-087 Evil check reads the karma the cross-player rules wrote (GEN-060).
   */
  function withKarma(tx: DbOrTx, state: PhaseState, results: Readonly<Record<string, PlayerResult>>): Record<string, PlayerResult> {
    const karma = karmaOf(tx, state.order);
    const out: Record<string, PlayerResult> = { ...results };
    for (const id of state.order) {
      const k = karma.get(id);
      if (k !== undefined && out[id]?.karma === undefined) out[id] = { ...out[id], karma: k };
    }
    return out;
  }

  /** Hands the closed turn to the resolver once, publishes what comes back and opens the next turn. */
  function startResolving(gameId: string): void {
    if (resolving.has(gameId)) return;
    const run = (async () => {
      for (;;) {
        const state = ensurePhaseState(db, gameId, now());
        if (state.status !== 'resolving') return;
        const locations = locationSnapshot(db, gameId);
        const actions: ClosedAction[] = state.order.flatMap((id) => {
          const a = state.submissions[id];
          return a ? [{ memberId: id, text: a.text, visibility: a.visibility, rest: a.rest === true, locationId: locations.get(id) ?? null }] : [];
        });

        let resolution: PhaseResolution;
        try {
          resolution = await resolver.resolve({ gameId, at: { day: state.day, phase: state.phase, turn: state.turn }, actions, state });
        } catch (error) {
          // Stays `resolving`; the next player to enter the room starts it again.
          log(`[room] resolver failed (game ${gameId}): ${error instanceof Error ? error.name : 'unknown error'}`);
          return;
        }

        const published = db.transaction((tx) => {
          const t = now();
          const current = ensurePhaseState(tx, gameId, t);
          if (current.status !== 'resolving' || current.day !== state.day || current.phase !== state.phase || current.turn !== state.turn) {
            return null;
          }
          const at = { day: current.day, phase: current.phase, turn: current.turn };
          const rows = (resolution.entries ?? []).map((entry) => {
            const recipients = recipientsOf(tx, gameId, entry);
            const locationId = entry.kind === 'feed' ? entry.locationId : null;
            return { row: insertEntry(tx, gameId, { kind: entry.kind, at, locationId, text: entry.text }, [...recipients], t), recipients };
          });
          let step = phaseStep(current, { type: 'resolved', results: withKarma(tx, current, resolution.results ?? {}) }, rng);
          if (!step.ok) {
            log(`[room] resolver results refused (game ${gameId}): ${step.error.code}; the turn advances without them`);
            step = phaseStep(current, { type: 'resolved', results: withKarma(tx, current, {}) }, rng);
          }
          if (!step.ok) throw new Error(`phase engine refused an empty result: ${step.error.code}`);
          savePhaseState(tx, gameId, step.state, t);
          syncCharacterStats(tx, step.state, t);
          return rows;
        });
        if (published === null) return;
        deliver(gameId, published);
        broadcastRoom(gameId);
        // Loop: the next phase may close at once (nobody able to act).
      }
    })().finally(() => resolving.delete(gameId));
    resolving.set(gameId, run);
  }

  const rejectedBy: Record<PhaseErrorCode, RoomActionCode | null> = {
    not_collecting: 'resolving',
    game_ended: 'game_ended',
    unknown_player: 'not_a_player',
    cannot_act: null,
    secret_quota_used: 'secret_quota_used',
    invalid_action: 'invalid_action',
    not_resolving: 'invalid_action',
    invalid_result: 'invalid_action',
  };

  function reject(code: RoomActionCode, message?: string): SubmitReply {
    const text = message ?? (code in LOCK_MESSAGE ? LOCK_MESSAGE[code as RoomLockCode] : 'ส่ง action นี้ไม่ได้');
    return { type: 'action_rejected', code, message: text };
  }

  return {
    join(socket, me, afterSeq) {
      if (stopped) return;
      const state = ensurePhaseState(db, me.gameId, now());
      let sockets = rooms.get(me.gameId);
      if (!sockets) rooms.set(me.gameId, (sockets = new Map()));
      sockets.set(socket, me);
      for (const row of entriesFor(db, me.gameId, me.id, afterSeq)) send(socket, { type: 'entry', entry: entryView(row) });
      broadcastRoom(me.gameId);
      const lastSeq = entriesFor(db, me.gameId, me.id, 0).at(-1)?.id ?? 0;
      send(socket, { type: 'ready', lastSeq: Math.max(lastSeq, afterSeq) });
      // After a restart a phase can be left `resolving` with nobody working on it.
      if (state.status === 'resolving') startResolving(me.gameId);
    },

    leave(socket) {
      const me = memberOf(socket);
      if (!me) return;
      const sockets = rooms.get(me.gameId)!;
      sockets.delete(socket);
      if (sockets.size === 0) rooms.delete(me.gameId);
      else broadcastRoom(me.gameId);
    },

    submit(socket, input) {
      const me = memberOf(socket);
      if (!me) return reject('not_a_player');
      if (me.role === 'gm') return reject('not_a_player');
      const visibility = ActionVisibility.safeParse(input.visibility);
      if (!visibility.success) return reject('invalid_action', 'เลือก Public หรือ Secret');
      const problem = actionTextProblem(input.text);
      if (problem) return reject(problem.code, problem.message);
      const text = normalizeActionText(input.text);
      const rest = input.rest === true;

      const outcome = db.transaction((tx): SubmitReply | PhaseState => {
        const t = now();
        const state = ensurePhaseState(tx, me.gameId, t);
        const action = { text, visibility: visibility.data, rest };
        const step = phaseStep(state, { type: 'submit', playerId: me.id, action }, rng);
        if (!step.ok) {
          const mapped = rejectedBy[step.error.code];
          if (mapped === 'secret_quota_used') return reject(mapped, state.phase === NIGHT_PERIOD ? NIGHT_SECRET_QUOTA_MESSAGE : SECRET_QUOTA_MESSAGE);
          if (mapped) return reject(mapped);
          const lock = lockOf(me, state);
          return reject(lock ?? 'invalid_action');
        }
        recordAction(tx, me.gameId, { day: state.day, phase: state.phase, turn: state.turn }, me.id, action, t);
        savePhaseState(tx, me.gameId, step.state, t);
        return step.state;
      });
      if ('type' in outcome) return outcome;
      broadcastRoom(me.gameId);
      // Online: closes once every player who must act has sent; Single: that is the one player (C7).
      if (outcome.status === 'resolving') startResolving(me.gameId);
      return { type: 'action_accepted' };
    },

    async stop() {
      stopped = true;
      rooms.clear();
      while (resolving.size > 0) await Promise.allSettled([...resolving.values()]);
    },
  };
}
