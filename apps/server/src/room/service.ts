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
  type RoomMoveCode,
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
  type PeriodWeather,
  type PhaseErrorCode,
  type PhaseState,
  type PlayerResult,
  type TurnPoint,
} from '@isekai/rules';
import { eq } from 'drizzle-orm';
import type { Clock } from '../auth/join.ts';
import type { Db, DbOrTx } from '../db/client.ts';
import { game } from '../db/schema.ts';
import { activeMembers, type MemberRow } from '../game/service.ts';
import { CryptoRng } from '../rng.ts';
import { characterNameOf, entryViewOf, placeViewOf } from './entry-view.ts';
import { forbiddenKeysIn } from '../visibility/guard.ts';
import {
  closeAlliesOf,
  leaveHiddenEvidence,
  locationSnapshot,
  playerBondBetween,
  presenceOf,
  presencesInGame,
} from '../visibility/store.ts';
import { witnessesOf } from '../visibility/views.ts';
import { advanceTimeline } from '../timeline/store.ts';
import type { GameAssets } from '../assets/load.ts';
import { completeTravel, travel, travellingTo, withHazard } from '../travel/service.ts';
import { weatherAt, type WeatherService } from '../weather/service.ts';
import { settleTurnProgress, withPeriodEndEffects } from '../skills/progress.ts';
import type { ClosedAction, FinaleResolution, PhaseResolution, PhaseResolver, ResolverStuck } from './resolver.ts';
import { getEnding, markNarrated, settleEnding } from '../finale/store.ts';
import { templateFinaleEntries } from '../gm/finale.ts';
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
  unconscious: LOCK_MESSAGE.unconscious,
};

/** When the resolver threw: the room shows this and offers `retry`. */
const GM_STUCK_MESSAGE = 'AI GM ติดขัด สรุปผลเทิร์นนี้ไม่ได้ action ทุกอันยังอยู่ กด "ลองใหม่" ได้';

const SECRET_QUOTA_MESSAGE = 'วันนี้ใช้ Secret ไปแล้ว (ได้วันละ 1 เทิร์น และฟรีอีก 1 เทิร์นในช่วง NOCTHERION) ส่งเป็น Public แทนได้';
const NIGHT_SECRET_QUOTA_MESSAGE = 'คืนนี้ใช้ Secret ฟรีของช่วง NOCTHERION ไปแล้ว (ได้คืนละ 1 เทิร์น) ส่งเป็น Public แทนได้';

export type SubmitReply = { type: 'action_accepted' } | { type: 'action_rejected'; code: RoomActionCode; message: string };
export type WhisperReply = { type: 'whisper_accepted' } | { type: 'whisper_rejected'; code: RoomWhisperCode; message: string };
export type MoveReply =
  | { type: 'move_accepted'; kind: 'same_zone' | 'cross_zone' | 'rift'; place: PlaceView; arrives: 'now' | 'next_turn' }
  | { type: 'move_rejected'; code: RoomMoveCode; message: string };

const TRAVELING_ACTION_MESSAGE = 'เทิร์นนี้ใช้ไปกับการเดินทางข้ามโซนแล้ว ส่ง action ได้อีกเมื่อถึงที่หมายเทิร์นถัดไป';

export interface RoomService {
  /** Registers an authenticated socket: replays entries after `afterSeq`, then sends the room and `ready`. */
  join(socket: RoomSocket, me: MemberRow, afterSeq: number): void;
  leave(socket: RoomSocket): void;
  submit(socket: RoomSocket, input: { text: string; visibility: string; rest?: boolean }): SubmitReply;
  /** A Whisper to one ally (GEN-067): stored as a `whisper` entry for sender, target and the Human GM. */
  whisper(socket: RoomSocket, input: { to: string; text: string }): WhisperReply;
  /** Tries a stuck turn again (GEN-057 C2); does nothing when the AI GM is not stuck. */
  retry(socket: RoomSocket): void;
  /** A walk to another place (GEN-066): no weather, start right, password or INFILTRATE from the room yet. */
  move(socket: RoomSocket, input: { to: string }): MoveReply;
  /** GEN-058 (Q-030): the resolved turn of a game with a Human GM, held until the GM approves it; undefined = none. */
  heldTurn(gameId: string): HeldTurn | undefined;
  /**
   * Publishes the held turn as `edit` returns it (the GM's narration / result changes), then goes on with the
   * game. false = nothing was held, or the publish failed (the room then offers retry).
   */
  approve(gameId: string, edit: (turn: HeldTurn) => PhaseResolution): boolean;
  /** Starts resolving a closed turn nobody works on (after a restart, before anyone entered the room). */
  wake(gameId: string): void;
  /** Shutdown: forgets every socket (their close events no longer touch the database), then waits for running resolves. */
  stop(): Promise<void>;
}

/** A resolved turn before it is published. */
export interface HeldTurn {
  readonly at: TurnPoint;
  /** The engine state at the close (status `resolving`). */
  readonly state: PhaseState;
  readonly actions: readonly ClosedAction[];
  readonly resolution: PhaseResolution;
  /** GEN-059 (Q-205): the game's ending (entries only); approving publishes it instead of a turn. */
  readonly finale?: boolean;
}

const AWAITING_GM_PLAYER_MESSAGE = 'ผลของเทิร์นนี้รอ GM ตรวจและอนุมัติก่อน แล้วจะส่งให้ทุกคน';
const AWAITING_GM_MESSAGE = 'ผลของเทิร์นนี้รอคุณตรวจใน GM console แก้ได้ แล้วกดอนุมัติเพื่อส่งให้ผู้เล่น';

/**
 * The play room (GEN-056). Presence lives in memory (who has a socket open); everything players must not
 * lose lives in the database: the engine state, the actions, and every feed / narration entry with its
 * recipients. All database work is synchronous (better-sqlite3), so a replay and the socket registration
 * happen in one tick and no live entry can slip between them.
 */
export function createRoomService(
  db: Db,
  now: Clock,
  resolver: PhaseResolver,
  assets: GameAssets,
  log: (line: string) => void,
  weather?: WeatherService,
  /** Q-185: called once, after the publish that ends the game (finale / game_over) committed. */
  onGameEnded?: (gameId: string, status: 'finale' | 'game_over') => void,
): RoomService {
  /** gameId → socket → member. */
  const rooms = new Map<string, Map<RoomSocket, MemberRow>>();
  const resolving = new Map<string, Promise<void>>();
  /** Games whose closed turn the resolver could not finish (GEN-057); cleared by `retry` or a restart. */
  const stuck = new Map<string, ResolverStuck>();
  /** Games with a Human GM whose resolved turn waits for approval (GEN-058); lost on restart, resolved again then. */
  const held = new Map<string, HeldTurn>();
  /** Endings being told (GEN-059), awaited on shutdown. */
  const finaling = new Map<string, Promise<void>>();
  const shutdown = new AbortController();
  /** Weather picks still running (GEN-068), awaited on shutdown. */
  const picking = new Set<Promise<unknown>>();
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

  const placeView = placeViewOf;
  const characterName = (memberId: string | null) => characterNameOf(db, memberId);
  const entryView = (row: RoomEntryRow, viewer: MemberRow): RoomEntry => entryViewOf(db, row, viewer);

  /** Allies `me` may Whisper to and whose real name they see (GEN-067), by their presence ref. A discovered name alone (Q-134) opens no Whisper. */
  function alliesOf(me: MemberRow): { ref: string; name: string }[] {
    if (me.role === 'gm') return [];
    const visible = closeAlliesOf(db, me.id);
    if (visible.size === 0) return [];
    const active = new Set(activeMembers(db, me.gameId).map((m) => m.id));
    const presences = new Map(presencesInGame(db, me.gameId).map((p) => [p.memberId, p.ref]));
    return [...visible].flatMap((id) => {
      const ref = presences.get(id);
      return ref !== undefined && active.has(id) ? [{ ref, name: characterName(id) }] : [];
    });
  }

  /** The stored weather of the period `state` is in (GEN-068); null before it is picked. */
  function weatherView(gameId: string, state: PhaseState): PeriodWeather | null {
    const stored = weatherAt(db, gameId, state);
    return stored ? { weather: stored.weather, disaster: stored.disaster } : null;
  }

  const isEnded = (state: PhaseState) => state.status === 'finale' || state.status === 'game_over';
  const playing = (state: PhaseState) => state.status === 'collecting' || state.status === 'resolving';

  /** The period's weather, picked on first use; null without a weather service or when the pick failed. */
  async function weatherFor(gameId: string, state: PhaseState): Promise<PeriodWeather | null> {
    if (!weather || !playing(state)) return null;
    const run = weather.ensure(gameId, state);
    picking.add(run);
    try {
      const { weather: w, disaster } = await run;
      return { weather: w, disaster };
    } catch (error) {
      log(`[room] weather pick failed (game ${gameId}): ${error instanceof Error ? error.name : 'unknown error'}`);
      return null;
    } finally {
      picking.delete(run);
    }
  }

  /** A period just opened (or the room did): pick its weather if it has none yet, then show it to everyone. */
  function openPeriodWeather(gameId: string): void {
    if (!weather || stopped) return;
    const state = ensurePhaseState(db, gameId, now());
    if (!playing(state) || weatherAt(db, gameId, state) !== null) return;
    void weatherFor(gameId, state).then((w) => {
      if (w !== null && !stopped) broadcastRoom(gameId);
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
    if (held.has(me.gameId) && (state.status === 'resolving' || isEnded(state))) {
      return { code: 'awaiting_gm', message: me.role === 'gm' ? AWAITING_GM_MESSAGE : AWAITING_GM_PLAYER_MESSAGE, canRetry: false };
    }
    const s = stuck.get(me.gameId);
    // GEN-059: an untold ending of an ended game is stuck the same way (retry tells it).
    if (!s || (state.status !== 'resolving' && !isEnded(state))) return null;
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
      weather: weatherView(me.gameId, state),
      // Q-195: who sent is the GM's to see; a player gets the count and their own flag only.
      members: members.map((m) => ({
        memberId: m.id,
        name: m.name,
        role: m.role,
        online: online.has(m.id),
        ...(me.role === 'gm' || m.id === me.id ? { submitted: m.id in state.submissions } : {}),
      })),
      submittedCount: Object.keys(state.submissions).length,
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

  function hasHumanGm(gameId: string): boolean {
    return db.select({ humanGm: game.humanGm }).from(game).where(eq(game.id, gameId)).get()?.humanGm === true;
  }

  /**
   * Publishes a resolved turn in one transaction and opens the next turn. false = it is not published: the
   * turn is no longer the closed one, or the transaction failed (rolled back; the room then offers retry).
   */
  function publishTurn(gameId: string, turn: HeldTurn): boolean {
    const { state, actions, resolution } = turn;
    const outcome: { ended: 'finale' | 'game_over' | null } = { ended: null };
    const publish = () => db.transaction((tx) => {
          outcome.ended = null;
          const t = now();
          const current = ensurePhaseState(tx, gameId, t);
          if (current.status !== 'resolving' || current.day !== state.day || current.phase !== state.phase || current.turn !== state.turn) {
            return null;
          }
          const at = { day: current.day, phase: current.phase, turn: current.turn };
          const rows = (resolution.entries ?? []).map((entry) => {
            const recipients = recipientsOf(tx, gameId, entry);
            const locationId = entry.kind === 'feed' ? entry.locationId : null;
            const fallback = entry.fallback ? { fallback: entry.fallback } : {};
            return { row: insertEntry(tx, gameId, { kind: entry.kind, at, locationId, text: entry.text, ...fallback }, [...recipients], t), recipients };
          });
          // GEN-067: every Secret action that stood leaves a Hidden Evidence Tag at its place for this game day.
          for (const a of actions) {
            if (a.visibility === 'secret' && a.locationId !== null) {
              leaveHiddenEvidence(tx, { gameId, locationId: a.locationId, day: at.day, actorMemberId: a.memberId }, t);
            }
          }
          resolution.apply?.(tx);
          // GEN-066: a turn spent in the forest / at the sea from day 5 costs Stamina, on top of what the resolver said.
          // GEN-055: on the period's last turn, end_of_period restores of skills / items (capped at max).
          const settled = (results: Readonly<Record<string, PlayerResult>>) =>
            withPeriodEndEffects(tx, assets, gameId, current, withHazard(tx, assets, gameId, current, withKarma(tx, current, results)));
          let step = phaseStep(current, { type: 'resolved', results: settled(resolution.results ?? {}) }, rng);
          if (!step.ok) {
            log(`[room] resolver results refused (game ${gameId}): ${step.error.code}; the turn advances without them`);
            step = phaseStep(current, { type: 'resolved', results: settled({}) }, rng);
          }
          if (!step.ok) throw new Error(`phase engine refused an empty result: ${step.error.code}`);
          savePhaseState(tx, gameId, step.state, t);
          syncCharacterStats(tx, step.state, t);
          // GEN-055: karma per day / period for the unlock rules, then the skills that unlock now.
          settleTurnProgress(tx, assets, gameId, current, t);
          // GEN-066: trips to another zone arrive, rift visitors go back (after the feed's witnesses were taken).
          completeTravel(tx, gameId, t);
          // The timeline follows the period (GEN-053): events of the new period become active for the next turn.
          const next = step.state;
          if (isEnded(next)) {
            advanceTimeline(tx, gameId, 'end', t);
            // The one place a game ends (GEN-052 engine → finale / game_over). Q-185 hooks its backup after commit.
            outcome.ended = next.status === 'finale' ? 'finale' : 'game_over';
            // GEN-059: the ending is decided with the end itself (positions and items as this turn left them).
            settleEnding(tx, assets, gameId, next, t);
          } else if (next.day !== current.day || next.phase !== current.phase) advanceTimeline(tx, gameId, { day: next.day, phase: next.phase }, t);
          return { rows, ended: isEnded(next) };
        });
    let published: ReturnType<typeof publish>;
    try {
      published = publish();
    } catch (error) {
      // Rolled back as a whole: nothing of the turn is written; the room offers retry.
      log(`[room] publish failed (game ${gameId}): ${error instanceof Error ? error.name : 'unknown error'}`);
      stuck.set(gameId, { code: 'stuck', message: GM_STUCK_MESSAGE, ownerMessage: GM_STUCK_MESSAGE });
      broadcastRoom(gameId);
      return false;
    }
    if (published === null) return false;
    stuck.delete(gameId);
    deliver(gameId, published.rows);
    broadcastRoom(gameId);
    if (published.ended) startFinale(gameId);
    if (outcome.ended !== null) {
      try {
        onGameEnded?.(gameId, outcome.ended);
      } catch (error) {
        log(`[room] game-end hook failed (game ${gameId}): ${error instanceof Error ? error.name : 'unknown error'}`);
      }
    }
    return true;
  }

  /**
   * GEN-059: tells the stored ending of an ended game once (whole-town feed + one narration per player). An
   * AI failure leaves the game ended and the ending untold: the room offers retry, and a restart tries again.
   */
  function startFinale(gameId: string): void {
    if (finaling.has(gameId) || stopped) return;
    const ending = getEnding(db, gameId);
    if (!ending || ending.narrated) return;
    const run = (async () => {
      let told: FinaleResolution;
      try {
        told = resolver.finale ? await resolver.finale({ gameId, signal: shutdown.signal }) : { entries: templateFinaleEntries(db, assets, gameId) };
      } catch (error) {
        log(`[room] finale failed (game ${gameId}): ${error instanceof Error ? error.name : 'unknown error'}`);
        told = { stuck: { code: 'stuck', message: GM_STUCK_MESSAGE, ownerMessage: GM_STUCK_MESSAGE } };
      }
      if (stopped) return;
      if (told.stuck) {
        stuck.set(gameId, told.stuck);
        broadcastRoom(gameId);
        return;
      }
      stuck.delete(gameId);
      // Q-205 (Q-030): with a Human GM the ending waits for approval like a turn; without one it goes out at once.
      if (hasHumanGm(gameId)) {
        const state = ensurePhaseState(db, gameId, now());
        held.set(gameId, { at: { day: state.day, phase: state.phase, turn: state.turn }, state, actions: [], resolution: { entries: told.entries }, finale: true });
        broadcastRoom(gameId);
        return;
      }
      publishFinale(gameId, told.entries);
    })().finally(() => finaling.delete(gameId));
    finaling.set(gameId, run);
  }

  /** Stores and sends the ending entries once; false when the transaction failed (the room then offers retry). */
  function publishFinale(gameId: string, entries: readonly NonNullable<PhaseResolution['entries']>[number][]): boolean {
    const publish = () => db.transaction((tx) => {
      if (getEnding(tx, gameId)?.narrated !== false) return null;
      const t = now();
      const state = ensurePhaseState(tx, gameId, t);
      const at = { day: state.day, phase: state.phase, turn: state.turn };
      const out = entries.map((entry) => {
        const recipients = recipientsOf(tx, gameId, entry);
        const locationId = entry.kind === 'feed' ? entry.locationId : null;
        return { row: insertEntry(tx, gameId, { kind: entry.kind, at, locationId, text: entry.text }, [...recipients], t), recipients };
      });
      markNarrated(tx, gameId, t);
      return out;
    });
    let rows: ReturnType<typeof publish>;
    try {
      rows = publish();
    } catch (error) {
      log(`[room] finale publish failed (game ${gameId}): ${error instanceof Error ? error.name : 'unknown error'}`);
      stuck.set(gameId, { code: 'stuck', message: GM_STUCK_MESSAGE, ownerMessage: GM_STUCK_MESSAGE });
      broadcastRoom(gameId);
      return false;
    }
    if (rows) deliver(gameId, rows);
    broadcastRoom(gameId);
    return true;
  }

  /** Work after a published turn (the day summary); a failure is logged and never blocks the game. */
  async function afterTurn(gameId: string, resolution: PhaseResolution): Promise<void> {
    if (!resolution.after) return;
    try {
      await resolution.after();
    } catch (error) {
      log(`[room] after-turn work failed (game ${gameId}): ${error instanceof Error ? error.name : 'unknown error'}`);
    }
  }

  /**
   * Hands the closed turn to the resolver once and publishes what comes back, or (GEN-058) holds it for the
   * Human GM; `first` runs before (the after-turn work of a turn the GM just approved).
   */
  function startResolving(gameId: string, first?: () => Promise<void>): void {
    if (resolving.has(gameId)) return;
    const run = (async () => {
      if (first) await first();
      for (;;) {
        if (stopped) return;
        const state = ensurePhaseState(db, gameId, now());
        if (state.status !== 'resolving') return;
        const locations = locationSnapshot(db, gameId);
        const actions: ClosedAction[] = state.order.flatMap((id) => {
          const a = state.submissions[id];
          return a
            ? [{ memberId: id, text: a.text, visibility: a.visibility, rest: a.rest === true, locationId: locations.get(id) ?? null, travelingTo: travellingTo(db, id) }]
            : [];
        });

        // The resolver always gets the period's weather: picked now if the period opened without one.
        const periodWeather = await weatherFor(gameId, state);

        const at = { day: state.day, phase: state.phase, turn: state.turn };
        let resolution: PhaseResolution;
        try {
          resolution = await resolver.resolve({ gameId, at, actions, state, signal: shutdown.signal, weather: periodWeather });
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

        const turn: HeldTurn = { at, state, actions, resolution };
        // Q-030: with a Human GM the turn waits for approval (`approve`); without one it is published at once (C6).
        if (hasHumanGm(gameId)) {
          held.set(gameId, turn);
          broadcastRoom(gameId);
          return;
        }
        if (!publishTurn(gameId, turn)) return;
        await afterTurn(gameId, resolution);
        openPeriodWeather(gameId);
        // Loop: the next phase may close at once (nobody able to act).
      }
    })().finally(() => resolving.delete(gameId));
    resolving.set(gameId, run);
  }

  /** An ended game whose ending is untold (after a restart): tell it, unless it is stuck (waits for `retry`). */
  function wakeFinale(gameId: string): void {
    if (!stuck.has(gameId) && !held.has(gameId)) startFinale(gameId);
  }

  /** A closed turn nobody works on: resolve it, unless it is stuck (waits for `retry`) or held for the GM. */
  function wakeTurn(gameId: string): void {
    if (!stuck.has(gameId) && !held.has(gameId)) startResolving(gameId);
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
      if (state.status === 'resolving') wakeTurn(me.gameId);
      else if (isEnded(state)) wakeFinale(me.gameId);
      else openPeriodWeather(me.gameId);
    },

    heldTurn(gameId) {
      return held.get(gameId);
    },

    approve(gameId, edit) {
      const turn = held.get(gameId);
      if (!turn || stopped) return false;
      held.delete(gameId);
      const resolution = edit(turn);
      if (turn.finale) return publishFinale(gameId, resolution.entries ?? []);
      if (!publishTurn(gameId, { ...turn, resolution })) return false;
      // The after-turn work and the new period's weather (GEN-068), then the next turn if it closes at once.
      startResolving(gameId, async () => {
        await afterTurn(gameId, resolution);
        openPeriodWeather(gameId);
      });
      return true;
    },

    wake(gameId) {
      const state = ensurePhaseState(db, gameId, now());
      if (state.status === 'resolving') wakeTurn(gameId);
      else if (isEnded(state)) wakeFinale(gameId);
    },

    retry(socket) {
      const me = memberOf(socket);
      if (!me || !stuck.has(me.gameId)) return;
      stuck.delete(me.gameId);
      broadcastRoom(me.gameId);
      if (isEnded(ensurePhaseState(db, me.gameId, now()))) startFinale(me.gameId);
      else startResolving(me.gameId);
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
      if (travellingTo(db, me.id) !== null) return reject('traveling', TRAVELING_ACTION_MESSAGE);

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
        // Q-136: HP 0 locks Whisper like an action.
        if (state.players[me.id]?.condition === 'unconscious') return 'unconscious' as const;
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

    move(socket, input) {
      const me = memberOf(socket);
      if (!me || me.role === 'gm') return { type: 'move_rejected', code: 'cannot_act', message: LOCK_MESSAGE.not_a_player };
      const outcome = db.transaction((tx) => {
        const lock = lockOf(me, ensurePhaseState(tx, me.gameId, now()));
        if (lock) return { ok: false as const, code: 'cannot_act' as const, message: LOCK_MESSAGE[lock] };
        return travel(tx, assets, me.gameId, me.id, { to: normalizeActionText(input.to) }, now());
      });
      if (!outcome.ok) {
        const code: RoomMoveCode = outcome.code === 'infiltrate_invalid' ? 'cannot_act' : outcome.code;
        return { type: 'move_rejected', code, message: outcome.message };
      }
      broadcastRoom(me.gameId);
      if (outcome.state.status === 'resolving') startResolving(me.gameId);
      return { type: 'move_accepted', kind: outcome.kind, place: outcome.place, arrives: outcome.arrives };
    },

    async stop() {
      stopped = true;
      rooms.clear();
      shutdown.abort();
      while (resolving.size > 0 || picking.size > 0 || finaling.size > 0) await Promise.allSettled([...resolving.values(), ...picking, ...finaling.values()]);
    },
  };
}
