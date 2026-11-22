import {
  ACTION_MAX_LENGTH,
  ActionVisibility,
  actionTextProblem,
  normalizeActionText,
  type PlaceView,
  type RoomActionCode,
  type RoomGmStatus,
  type RoomEntry,
  type RoomLockCode,
  type RoomServerMessage,
  type RoomState,
  type RoomWhisperCode,
} from '@isekai/protocol';
import {
  NIGHT_PERIOD,
  isDrowsy,
  phaseStep,
  revealsPlayerName,
  secretQuotaUsed,
  type PhaseErrorCode,
  type PhaseState,
  type PlayerResult,
} from '@isekai/rules';
import { eq } from 'drizzle-orm';
import type { Clock } from '../auth/join.ts';
import type { Db, DbOrTx } from '../db/client.ts';
import { character, game } from '../db/schema.ts';
import { activeMembers, type MemberRow } from '../game/service.ts';
import { CryptoRng } from '../rng.ts';
import { getGameScenario } from '../scenario/store.ts';
import { forbiddenKeysIn } from '../visibility/guard.ts';
import {
  leaveHiddenEvidence,
  locationSnapshot,
  namesVisibleTo,
  playerBondBetween,
  presenceOf,
  presencesInGame,
} from '../visibility/store.ts';
import { witnessesOf } from '../visibility/views.ts';
import { advanceTimeline } from '../timeline/store.ts';
import type { ClosedAction, PhaseResolution, PhaseResolver, ResolverStuck } from './resolver.ts';
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

const WHISPER_MESSAGE: Record<RoomWhisperCode, string> = {
  empty: 'พิมพ์ข้อความก่อนส่ง Whisper',
  too_long: `Whisper ยาวได้ไม่เกิน ${ACTION_MAX_LENGTH} ตัวอักษร`,
  not_a_player: 'GM ไม่มีตัวละคร จึงส่ง Whisper ไม่ได้',
  not_allowed: 'ส่ง Whisper ถึงคนนี้ไม่ได้ ต้องเป็นพันธมิตรที่สนิทกันพอก่อน',
  game_ended: 'เกมจบแล้ว ส่ง Whisper ไม่ได้',
};

/** When the resolver threw: the room shows this and offers `retry`. */
const GM_STUCK_MESSAGE = 'AI GM ติดขัด สรุปผลเทิร์นนี้ไม่ได้ action ทุกอันยังอยู่ กด "ลองใหม่" ได้';

const SECRET_QUOTA_MESSAGE = 'วันนี้ใช้ Secret ไปแล้ว (ได้วันละ 1 เทิร์น และฟรีอีก 1 เทิร์นในช่วง NOCTHERION) ส่งเป็น Public แทนได้';
const NIGHT_SECRET_QUOTA_MESSAGE = 'คืนนี้ใช้ Secret ฟรีของช่วง NOCTHERION ไปแล้ว (ได้คืนละ 1 เทิร์น) ส่งเป็น Public แทนได้';

export type SubmitReply = { type: 'action_accepted' } | { type: 'action_rejected'; code: RoomActionCode; message: string };
export type WhisperReply = { type: 'whisper_accepted' } | { type: 'whisper_rejected'; code: RoomWhisperCode; message: string };

export interface RoomService {
  /** Registers an authenticated socket: replays entries after `afterSeq`, then sends the room and `ready`. */
  join(socket: RoomSocket, me: MemberRow, afterSeq: number): void;
  leave(socket: RoomSocket): void;
  submit(socket: RoomSocket, input: { text: string; visibility: string; rest?: boolean }): SubmitReply;
  /** A Whisper to one ally (GEN-067): stored as a `whisper` entry for sender, target and the Human GM. */
  whisper(socket: RoomSocket, input: { to: string; text: string }): WhisperReply;
  /** Tries a stuck turn again (GEN-057 C2); does nothing when the AI GM is not stuck. */
  retry(socket: RoomSocket): void;
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
  /** Games whose closed turn the resolver could not finish (GEN-057); cleared by `retry` or a restart. */
  const stuck = new Map<string, ResolverStuck>();
  const shutdown = new AbortController();
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

  function characterName(memberId: string | null): string {
    if (memberId === null) return '';
    return db.select({ name: character.name }).from(character).where(eq(character.memberId, memberId)).get()?.name ?? '';
  }

  function entryView(row: RoomEntryRow, viewer: MemberRow): RoomEntry {
    return {
      seq: row.id,
      kind: row.kind,
      day: row.day,
      phase: row.phase,
      turn: row.turn === 2 ? 2 : 1,
      place: placeView(db, row.gameId, row.locationId),
      text: row.text,
      ...(row.kind === 'whisper'
        ? { whisper: { from: characterName(row.fromMemberId), to: characterName(row.toMemberId), mine: row.fromMemberId === viewer.id } }
        : {}),
    };
  }

  /** Allies `me` may Whisper to and whose real name they see (GEN-067), by their presence ref. */
  function alliesOf(me: MemberRow): { ref: string; name: string }[] {
    if (me.role === 'gm') return [];
    const visible = namesVisibleTo(db, me.id);
    if (visible.size === 0) return [];
    const active = new Set(activeMembers(db, me.gameId).map((m) => m.id));
    const presences = new Map(presencesInGame(db, me.gameId).map((p) => [p.memberId, p.ref]));
    return [...visible].flatMap((id) => {
      const ref = presences.get(id);
      return ref !== undefined && active.has(id) ? [{ ref, name: characterName(id) }] : [];
    });
  }

  function lockOf(me: MemberRow, state: PhaseState): RoomLockCode | null {
    if (me.role === 'gm' || !state.players[me.id]) return 'not_a_player';
    if (state.status === 'finale' || state.status === 'game_over') return 'game_ended';
    if (state.status === 'resolving') return 'resolving';
    const condition = state.players[me.id]!.condition;
    return condition === 'awake' ? null : condition;
  }

  function gmStatusFor(me: MemberRow, state: PhaseState, ownerMemberId: string | null): RoomGmStatus | null {
    const s = stuck.get(me.gameId);
    if (!s || state.status !== 'resolving') return null;
    const toOwner = me.role === 'gm' || me.id === ownerMemberId;
    return { code: s.code, message: toOwner ? s.ownerMessage : s.message, canRetry: s.code === 'stuck' };
  }

  function roomStateFor(
    me: MemberRow,
    state: PhaseState,
    members: MemberRow[],
    online: Set<string>,
    gameRow: { mode: 'online' | 'single'; ownerMemberId: string | null },
  ): RoomState {
    const { mode } = gameRow;
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
        allies: alliesOf(me),
      },
      gmStatus: gmStatusFor(me, state, gameRow.ownerMemberId),
    };
  }

  function broadcastRoom(gameId: string): void {
    const sockets = rooms.get(gameId);
    if (!sockets || sockets.size === 0) return;
    const state = ensurePhaseState(db, gameId, now());
    const members = activeMembers(db, gameId);
    const gameRow = db.select({ mode: game.mode, ownerMemberId: game.ownerMemberId }).from(game).where(eq(game.id, gameId)).get() ?? {
      mode: 'online' as const,
      ownerMemberId: null,
    };
    const online = new Set([...sockets.values()].map((m) => m.id));
    for (const [socket, me] of sockets) send(socket, roomStateFor(me, state, members, online, gameRow));
  }

  function deliver(gameId: string, rows: readonly { row: RoomEntryRow; recipients: ReadonlySet<string> }[]): void {
    const sockets = rooms.get(gameId);
    if (!sockets) return;
    for (const { row, recipients } of rows) {
      for (const [socket, me] of sockets) if (recipients.has(me.id)) send(socket, { type: 'entry', entry: entryView(row, me) });
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
          const at = { day: state.day, phase: state.phase, turn: state.turn };
          resolution = await resolver.resolve({ gameId, at, actions, state, signal: shutdown.signal });
        } catch (error) {
          // Stays `resolving`; after a restart the next player to enter starts it again, otherwise `retry` does.
          log(`[room] resolver failed (game ${gameId}): ${error instanceof Error ? error.name : 'unknown error'}`);
          if (!stopped) {
            stuck.set(gameId, { code: 'stuck', message: GM_STUCK_MESSAGE, ownerMessage: GM_STUCK_MESSAGE });
            broadcastRoom(gameId);
          }
          return;
        }
        if (stopped) return;
        if (resolution.stuck) {
          stuck.set(gameId, resolution.stuck);
          broadcastRoom(gameId);
          return;
        }

        const publish = () => db.transaction((tx) => {
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
          // GEN-067: every Secret action that stood leaves a Hidden Evidence Tag at its place for this game day.
          for (const a of actions) {
            if (a.visibility === 'secret' && a.locationId !== null) {
              leaveHiddenEvidence(tx, { gameId, locationId: a.locationId, day: at.day, actorMemberId: a.memberId }, t);
            }
          }
          resolution.apply?.(tx);
          let step = phaseStep(current, { type: 'resolved', results: withKarma(tx, current, resolution.results ?? {}) }, rng);
          if (!step.ok) {
            log(`[room] resolver results refused (game ${gameId}): ${step.error.code}; the turn advances without them`);
            step = phaseStep(current, { type: 'resolved', results: withKarma(tx, current, {}) }, rng);
          }
          if (!step.ok) throw new Error(`phase engine refused an empty result: ${step.error.code}`);
          savePhaseState(tx, gameId, step.state, t);
          syncCharacterStats(tx, step.state, t);
          // The timeline follows the period (GEN-053): events of the new period become active for the next turn.
          const next = step.state;
          if (next.status === 'finale' || next.status === 'game_over') advanceTimeline(tx, gameId, 'end', t);
          else if (next.day !== current.day || next.phase !== current.phase) advanceTimeline(tx, gameId, { day: next.day, phase: next.phase }, t);
          return rows;
        });
        let published: ReturnType<typeof publish>;
        try {
          published = publish();
        } catch (error) {
          // Rolled back as a whole: nothing of the turn is written; the room offers retry.
          log(`[room] publish failed (game ${gameId}): ${error instanceof Error ? error.name : 'unknown error'}`);
          stuck.set(gameId, { code: 'stuck', message: GM_STUCK_MESSAGE, ownerMessage: GM_STUCK_MESSAGE });
          broadcastRoom(gameId);
          return;
        }
        if (published === null) return;
        stuck.delete(gameId);
        deliver(gameId, published);
        broadcastRoom(gameId);
        if (resolution.after) {
          try {
            await resolution.after();
          } catch (error) {
            log(`[room] after-turn work failed (game ${gameId}): ${error instanceof Error ? error.name : 'unknown error'}`);
          }
        }
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

  function rejectWhisper(code: RoomWhisperCode): WhisperReply {
    return { type: 'whisper_rejected', code, message: WHISPER_MESSAGE[code] };
  }

  return {
    join(socket, me, afterSeq) {
      if (stopped) return;
      const state = ensurePhaseState(db, me.gameId, now());
      let sockets = rooms.get(me.gameId);
      if (!sockets) rooms.set(me.gameId, (sockets = new Map()));
      sockets.set(socket, me);
      for (const row of entriesFor(db, me.gameId, me.id, afterSeq)) send(socket, { type: 'entry', entry: entryView(row, me) });
      broadcastRoom(me.gameId);
      const lastSeq = entriesFor(db, me.gameId, me.id, 0).at(-1)?.id ?? 0;
      send(socket, { type: 'ready', lastSeq: Math.max(lastSeq, afterSeq) });
      // After a restart a phase can be left `resolving` with nobody working on it. A stuck turn waits for `retry`.
      if (state.status === 'resolving' && !stuck.has(me.gameId)) startResolving(me.gameId);
    },

    retry(socket) {
      const me = memberOf(socket);
      if (!me || !stuck.has(me.gameId)) return;
      stuck.delete(me.gameId);
      broadcastRoom(me.gameId);
      startResolving(me.gameId);
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

    whisper(socket, input) {
      const me = memberOf(socket);
      if (!me || me.role === 'gm') return rejectWhisper('not_a_player');
      const text = normalizeActionText(input.text);
      if (text.length === 0) return rejectWhisper('empty');
      if ([...text].length > ACTION_MAX_LENGTH) return rejectWhisper('too_long');

      const published = db.transaction((tx) => {
        const t = now();
        const state = ensurePhaseState(tx, me.gameId, t);
        if (state.status === 'finale' || state.status === 'game_over') return 'game_ended' as const;
        const target = presencesInGame(tx, me.gameId).find((p) => p.ref === input.to);
        const members = activeMembers(tx, me.gameId);
        if (!target || target.memberId === me.id || !members.some((m) => m.id === target.memberId)) return 'not_allowed' as const;
        if (!revealsPlayerName(playerBondBetween(tx, me.id, target.memberId))) return 'not_allowed' as const;

        const recipients = new Set([me.id, target.memberId, ...members.filter((m) => m.role === 'gm').map((m) => m.id)]);
        const entry = { kind: 'whisper' as const, at: { day: state.day, phase: state.phase, turn: state.turn }, locationId: null, text, fromMemberId: me.id, toMemberId: target.memberId };
        return { row: insertEntry(tx, me.gameId, entry, [...recipients], t), recipients };
      });
      if (typeof published === 'string') return rejectWhisper(published);
      deliver(me.gameId, [published]);
      return { type: 'whisper_accepted' };
    },

    async stop() {
      stopped = true;
      rooms.clear();
      shutdown.abort();
      while (resolving.size > 0) await Promise.allSettled([...resolving.values()]);
    },
  };
}
