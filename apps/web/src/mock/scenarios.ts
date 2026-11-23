import { GameView, OriginResponse, isVotableEntry, RoomEntry, RoomState, SurroundingsResponse, type CharacterView } from '@isekai/protocol';
import { CONTRACT_FIXTURES as F, CONTRACT_SCREENS, type ScreenId } from '@isekai/protocol/contract';

/**
 * isekai-mock-layer (GEN-100): the states the web can be put in without a server, all built from the GEN-099
 * fixtures (`@isekai/protocol/contract`). A scenario only picks fixtures or derives a state from one
 * (another lock, another turn); it never makes up a payload shape, and test/mock.test.tsx (C4) parses
 * every answer it gives against the contract schema. Dev only: main.tsx loads this with VITE_MOCK=1.
 */

/** What the mock room server can do, from a script step or a gallery button. */
export type MockOp = 'nextTurn' | 'hit' | 'othersSubmit' | 'closeTurn' | 'drop' | 'closeGame';
/** One scripted room event, `afterMs` after the first `hello` (the steps play in order). */
export interface MockStep {
  afterMs: number;
  op: MockOp;
}

/** An HTTP answer: a status + body, a network failure (server unreachable), or one that never comes (loading). */
export type MockReply = { status: number; body: unknown } | { fail: 'network' } | { pending: true };

export interface MockScenario {
  /** Also a host label of the mock base URL: lower case, digits and `-` only. */
  id: string;
  title: string;
  note: string;
  /** Who the main app is signed in as (boot.tsx): `guest` = no session. */
  session: 'guest' | 'player' | 'gm';
  /** Where the gallery shows it. */
  screens: readonly ScreenId[];
  /** Answers by contract route, `METHOD /path/:param` as in the registry; the rest use the default fixture. */
  http: Readonly<Record<string, MockReply>>;
  /**
   * Answers that change with time (GEN-090), by contract route: from `afterMs` after the first request to the
   * mock server the route answers with that step's reply (the latest due step wins), before it with `http`.
   */
  httpScript?: Readonly<Record<string, readonly { afterMs: number; reply: MockReply }[]>>;
  room: {
    state: RoomState;
    entries: readonly RoomEntry[];
    script: readonly MockStep[];
  };
}

const ok = (body: unknown): MockReply => ({ status: 200, body });

const ROOM_STATES = F.RoomState.map((s) => RoomState.parse(s));
const ENTRIES = F.RoomEntry.map((e) => RoomEntry.parse(e));
// The fixture says 3 sent while nobody has (GEN-131): the counter must start from the real number.
const BASE_ROOM: RoomState = { ...ROOM_STATES[0]!, submittedCount: 0 };
const lockState = (code: string) => ROOM_STATES.find((s) => s.you.lock?.code === code)!;

/**
 * The entries a player has at the start: everything but the hit (it arrives live) and the omen (Astral only).
 * An AI-written entry the fixtures give no vote state gets "not voted" (GEN-107: the server sends `myVote` for each of them).
 */
const START_ENTRIES = ENTRIES.filter((e) => e.kind !== 'hit' && e.kind !== 'omen').map((e) => (isVotableEntry({ kind: e.kind, ...(e.fallback ? { fallback: true as const } : {}) }) && e.myVote === undefined ? { ...e, myVote: null } : e));
/** GEN-107 C6: the Human GM never gets `myVote`, so no vote buttons. */
const GM_ENTRIES = START_ENTRIES.map(({ myVote: _myVote, ...entry }) => entry);
/** The pinned hit of the fixtures, sent by the `hit` op. */
export const HIT_ENTRY = ENTRIES.find((e) => e.kind === 'hit')!;
/** The whisper of the fixtures: the sender's name for a Whisper the player sends. */
export const WHISPER_ENTRY = ENTRIES.find((e) => e.kind === 'whisper')!;

const LOBBY_GAME = GameView.parse(F.GameView[0]);
const STARTED_GAME = GameView.parse(F.GameView[1]);
const ME = BASE_ROOM.you.memberId;

const waitingRoom: RoomState = {
  ...BASE_ROOM,
  members: BASE_ROOM.members.map((m) => (m.memberId === ME ? { ...m, submitted: true } : m)),
  submittedCount: 2,
  you: { ...BASE_ROOM.you, action: { text: 'ตามนักบวชไปดูว่าเอาขนมปังมาจากไหน', visibility: 'public', rest: false } },
};

const endedRoom: RoomState = {
  ...BASE_ROOM,
  status: 'game_over',
  you: { ...BASE_ROOM.you, lock: { code: 'game_ended', message: 'เกมจบแล้ว ดูสรุปได้ที่รายการเกม' } },
};

const GM_ID = 'm-gm';
const gmRoom: RoomState = {
  ...BASE_ROOM,
  members: [
    ...BASE_ROOM.members.map((m) => ({ ...m, submitted: m.memberId === ME })),
    { memberId: GM_ID, name: 'จีเอ็ม', role: 'gm', online: true },
  ],
  submittedCount: 1,
  you: { memberId: GM_ID, role: 'gm', place: null, lock: { code: 'not_a_player', message: 'GM ไม่มีตัวละคร' }, secretUsed: false, drowsy: false, action: null, allies: [] },
  gmStatus: { code: 'awaiting_gm', message: 'เทิร์นนี้สรุปแล้ว รอ GM อนุมัติ', canRetry: false },
};
const gmGame: GameView = {
  ...STARTED_GAME,
  humanGm: true,
  you: { memberId: GM_ID, role: 'gm', isOwner: false },
  members: [...STARTED_GAME.members, { id: GM_ID, name: 'จีเอ็ม', role: 'gm', isOwner: false, hasCharacter: false }],
};
const noCharacterGame: GameView = {
  ...LOBBY_GAME,
  members: LOBBY_GAME.members.map((m) => (m.id === ME ? { ...m, hasCharacter: false } : m)),
  startBlockers: ['ยังไม่สร้างตัวละคร: นก, ต้น'],
};

// --- GEN-090: the pages before the game starts ---
/** A newcomer for the lobby's member list (`lobby-join`). */
const NEWCOMER = { id: 'm-pla', name: 'ปลา', role: 'player', isOwner: false, hasCharacter: false } as const;
const joinedGame: GameView = {
  ...LOBBY_GAME,
  members: [...LOBBY_GAME.members, NEWCOMER],
  players: { ...LOBBY_GAME.players, count: LOBBY_GAME.players.count + 1 },
  startBlockers: ['ยังไม่สร้างตัวละคร: ต้น, ปลา'],
};
/** The fixture character before the start: still editable. */
const DRAFT_CHARACTER = { character: { ...F.CharacterResponse[0]!.character!, editable: true } };
const LOOT_OFFER = F.LootResponse[0]!;
const LOOT_EMPTY = { loot: { ...LOOT_OFFER.loot, offer: null } };
const LOOT_KEPT = { loot: { ...F.LootResponse[1]!.loot, canReroll: true } };
const ORIGIN = OriginResponse.parse(F.OriginResponse[0]);
/** A rare start whose crossing story the AI is still writing. */
const RARE_ORIGIN = ORIGIN.view === 'player' && ORIGIN.origin ? { ...ORIGIN.origin, kind: 'special', tierLabel: 'จุดเกิดพิเศษ', narration: null } : null;
/** Saving in the character steps answers like before the start (the default fixture is a started game's). */
const DRAFT_SAVES = {
  'POST /api/game/character': ok(DRAFT_CHARACTER),
  'PUT /api/game/character': ok(DRAFT_CHARACTER),
  'POST /api/game/character/loot/choose': ok(LOOT_KEPT),
} as const;

/** GET /api/game/surroundings with your own gauges changed, so the status column agrees with the lock (GEN-088). */
function surroundingsWith(you: Partial<CharacterView>): Readonly<Record<string, MockReply>> {
  const base = SurroundingsResponse.parse(F.SurroundingsResponse[0]);
  if (base.view !== 'player' || !base.you) throw new Error('the first SurroundingsResponse fixture is the player view');
  return { 'GET /api/game/surroundings': ok({ ...base, you: { ...base.you, ...you } }) };
}
const SPENT = surroundingsWith({ stamina: { current: 0, max: 30 } });
const DOWN = surroundingsWith({ hp: { current: 0, max: 30 } });

/** GEN-091: the held finale (Q-215) and a rated game with a low average (shown only, GEN-079), both from the fixtures. */
const FINALE_TURN = F.GmPendingTurn.find((t) => t.finale)!;
const LOW_RATING = { rating: { ...F.GameRatingResponse[0]!.rating, mine: { score: 6, comment: 'ช่วงกลางเกมช้าไปหน่อย' }, average: 7.4 } };

/** An ended game whose secrets span days 1, 2, 3 and 4 and two players, so the end page's day filter shows (Q-270). */
const ENDED_LOG = F.GameLogResponse[1]!;
const LIN = ENDED_LOG.reveal!.players[0]!;
const ENDED_DAYS_LOG = {
  ...ENDED_LOG,
  reveal: {
    ...ENDED_LOG.reveal!,
    players: [
      {
        ...LIN,
        secretActions: [
          { day: 1, phase: 'EOSORIA', turn: 1, text: 'แอบฟังข่าวลือที่ตลาด', sourceRef: '1-EOSORIA-1-3' },
          ...LIN.secretActions,
          { day: 4, phase: 'SOLARION', turn: 2, text: 'ซ่อนกุญแจไว้ใต้บันไดโบสถ์', sourceRef: '4-SOLARION-2-9' },
        ],
      },
      {
        ...LIN,
        memberId: 'm-bel',
        lobbyName: 'เบล',
        characterName: 'ไรเดน',
        secretActions: [{ day: 3, phase: 'EOSORIA', turn: 1, text: 'ลอบตามนักบวชไปที่ห้องใต้ดิน', sourceRef: '3-EOSORIA-1-5' }],
      },
    ],
  },
};

/** GEN-116: turn 1's NPC line is published after turn 2's first entry (later seq, same day / phase / turn as its own narration). */
const LATE_NPC_ENTRIES: readonly RoomEntry[] = (() => {
  const first = START_ENTRIES.find((e) => e.kind === 'feed')!;
  return [
    first,
    { ...first, seq: 30, turn: first.turn === 1 ? 2 : 1, text: 'เทิร์นถัดมา: ฝนเริ่มซา', myVote: null },
    { ...ENTRIES.find((e) => e.kind === 'npc' && !e.npc?.private)!, seq: 31, day: first.day, phase: first.phase, turn: first.turn, myVote: null },
  ];
})();

// --- ISK-002: the admin game list, and games the server owner closed ---
const ADMIN_ROW = F.AdminGameRow[0]!;
/** Every status the เกม tab words (C1), one row each, plus one already closed. */
const ADMIN_GAMES = {
  games: [
    { ...ADMIN_ROW, id: 'g-lobby', name: 'ห้องรอวันหยุด', phase: 'lobby', day: null, period: null, playerCount: 2, lastActionAt: null, aiUsd: 0 },
    { ...ADMIN_ROW, id: 'g-setup', name: 'ตั้งตัวละครกันอยู่', phase: 'setup', day: null, period: null, aiUsd: 0.03 },
    ADMIN_ROW,
    { ...ADMIN_ROW, id: 'g-end', name: 'คืนจันทราโลหิต', phase: 'ended', endedReason: 'finale', day: 12, period: 'NOCTHERION', aiUsd: 1.8 },
    { ...ADMIN_ROW, id: 'g-closed', name: 'ทดลองระบบ', phase: 'ended', endedReason: 'closed', day: 2, period: 'SOLARION', aiUsd: 0.1 },
  ],
};
const CLOSED_LOG = F.GameLogResponse.find((l) => l.game.closedEarly)!;

const ALL_SCREENS =CONTRACT_SCREENS.map((s) => s.id);
const room = (state: RoomState, script: readonly MockStep[] = [], entries: readonly RoomEntry[] = START_ENTRIES) => ({ state, entries, script });

export const SCENARIOS: readonly MockScenario[] = [
  {
    id: 'normal',
    title: 'ปกติ',
    note: 'เกมเริ่มแล้ว เทิร์นเปิดรับ action อยู่ที่น้ำพุ',
    session: 'player',
    screens: ALL_SCREENS,
    http: {},
    room: room(BASE_ROOM),
  },
  {
    id: 'guest',
    title: 'ยังไม่เข้าเกม',
    note: 'ไม่มี session: หน้าแรกเปิดฟอร์ม join',
    session: 'guest',
    screens: ['home', 'join', 'create-game'],
    http: { 'GET /api/me': { status: 401, body: { code: 'unauthorized', message: 'กรุณาเข้าเกมใหม่' } } },
    room: room(BASE_ROOM),
  },
  {
    id: 'lobby',
    title: 'ห้องรอ ก่อนเริ่ม',
    note: 'เจ้าของเกม ยังมีคนไม่สร้างตัวละคร',
    session: 'player',
    screens: ['home', 'lobby'],
    http: { 'GET /api/game': ok(LOBBY_GAME) },
    room: room(BASE_ROOM),
  },
  {
    id: 'no-character',
    title: 'ยังไม่มีตัวละคร',
    note: 'สร้างตัวละครใหม่ + ของติดตัวที่ AI เสนอ',
    session: 'player',
    screens: ['lobby', 'character'],
    http: {
      'GET /api/game': ok(noCharacterGame),
      'GET /api/game/character': ok(F.CharacterResponse[1]),
      'GET /api/game/character/loot': ok(LOOT_OFFER),
      ...DRAFT_SAVES,
    },
    room: room(BASE_ROOM),
  },
  {
    id: 'lobby-join',
    title: 'ห้องรอ มีคนเข้าเพิ่ม',
    note: 'สมาชิกใหม่ (ปลา) เข้าห้องหลังเปิดหน้าไม่กี่วินาที',
    session: 'player',
    screens: ['lobby'],
    http: { 'GET /api/game': ok(LOBBY_GAME) },
    httpScript: { 'GET /api/game': [{ afterMs: 4000, reply: ok(joinedGame) }] },
    room: room(BASE_ROOM),
  },
  {
    id: 'start-while-creating',
    title: 'เกมเริ่มระหว่างสร้างตัวละคร',
    note: 'เจ้าของกดเริ่มเกมตอนหน้าสร้างตัวละครยังเปิดอยู่: พาไปหน้าเล่น แก้ไม่ได้แล้ว',
    session: 'player',
    screens: ['lobby'],
    http: { 'GET /api/game': ok({ ...LOBBY_GAME, startBlockers: [] }), 'GET /api/game/character': ok(DRAFT_CHARACTER), 'GET /api/game/character/loot': ok(LOOT_KEPT), ...DRAFT_SAVES },
    httpScript: { 'GET /api/game': [{ afterMs: 12_000, reply: ok(STARTED_GAME) }] },
    room: room(BASE_ROOM),
  },
  {
    id: 'loot-loading',
    title: 'รอ AI เสนอของติดตัว',
    note: 'กดให้ AI วิเคราะห์แล้วคำตอบยังไม่มา',
    session: 'player',
    screens: ['character'],
    http: {
      'GET /api/game': ok(noCharacterGame),
      'GET /api/game/character': ok(DRAFT_CHARACTER),
      'GET /api/game/character/loot': ok(LOOT_EMPTY),
      'POST /api/game/character/loot': { pending: true },
      ...DRAFT_SAVES,
    },
    room: room(BASE_ROOM),
  },
  {
    id: 'loot-error',
    title: 'AI วิเคราะห์บุคลิกล้ม',
    note: 'AI ไม่ตอบ (503): ขึ้นข้อความ + ปุ่มลองใหม่ ไม่นับเป็นการสุ่ม',
    session: 'player',
    screens: ['character'],
    http: {
      'GET /api/game': ok(noCharacterGame),
      'GET /api/game/character': ok(DRAFT_CHARACTER),
      'GET /api/game/character/loot': ok(LOOT_EMPTY),
      'POST /api/game/character/loot': { status: 503, body: { code: 'ai_unavailable', message: 'วิเคราะห์ไม่สำเร็จ ลองอีกครั้ง' } },
      ...DRAFT_SAVES,
    },
    room: room(BASE_ROOM),
  },
  {
    id: 'origin-rare',
    title: 'จุดเกิดหายาก เรื่องยังเขียนไม่เสร็จ',
    note: 'การ์ดจุดเกิดติดป้าย "หายาก" และ AI ยังเขียน narration อยู่',
    session: 'player',
    screens: ['origin-card'],
    http: {
      'GET /api/game/origin': ok({ view: 'player', origin: RARE_ORIGIN }),
    },
    room: room(BASE_ROOM),
  },
  {
    id: 'waiting',
    title: 'รอคนอื่นส่ง',
    note: 'ส่ง action แล้ว รออีกคน แล้วเทิร์นปิด สรุปผล และเปิดเทิร์นใหม่ตามลำดับ',
    session: 'player',
    screens: ['play-top-bar', 'play-action', 'play-lock'],
    http: {},
    room: room(waitingRoom, [
      { afterMs: 2000, op: 'othersSubmit' },
      { afterMs: 3500, op: 'closeTurn' },
      { afterMs: 6000, op: 'nextTurn' },
    ]),
  },
  { id: 'exhausted', title: 'หมดแรง', note: 'Stamina หมด ต้องพักเทิร์นนี้', session: 'player', screens: ['play-lock', 'play-action', 'play-self'], http: SPENT, room: room(lockState('exhausted')) },
  { id: 'unconscious', title: 'สลบ', note: 'HP 0 สลบ 1 เทิร์น', session: 'player', screens: ['play-lock', 'play-action', 'play-self'], http: DOWN, room: room(lockState('unconscious')) },
  { id: 'resolving', title: 'กำลังสรุปผล', note: 'เทิร์นปิดแล้ว AI GM กำลังสรุป', session: 'player', screens: ['play-lock', 'play-action'], http: {}, room: room(lockState('resolving')) },
  { id: 'traveling', title: 'กำลังเดินทางข้ามโซน', note: 'เทิร์นนี้คือการเดินทาง (lock ที่ server ยังไม่ส่ง)', session: 'player', screens: ['play-lock', 'play-place'], http: {}, room: room(lockState('traveling')) },
  { id: 'recovering', title: 'พักฟื้น', note: 'พักที่สถานพยาบาล (GEN-070)', session: 'player', screens: ['play-lock'], http: {}, room: room(lockState('recovering')) },
  {
    id: 'astral',
    title: 'Astral Spirit',
    note: 'ตายถาวร ส่งลางสังหรณ์ได้คืนละครั้ง (GEN-070)',
    session: 'player',
    screens: ['play-lock', 'play-astral', 'play-private'],
    http: {},
    room: room(lockState('astral_spirit'), [], ENTRIES.filter((e) => e.kind !== 'hit')),
  },
  {
    id: 'secret-used',
    title: 'quota ลับหมด',
    note: 'ใช้ Secret ของวันนี้แล้ว ส่ง Secret อีกจะถูกปฏิเสธ',
    session: 'player',
    screens: ['play-action'],
    http: {},
    room: room(ROOM_STATES.find((s) => s.you.secretUsed)!),
  },
  {
    id: 'vote',
    title: 'ให้คะแนน AI GM',
    note: 'ข้อความ AI GM 3 สถานะ: ยังไม่โหวต (seq 10) / ถูกใจ (11) / ไม่ถูกใจ (12); entry ที่ไม่ใช่ AI ไม่มี myVote',
    session: 'player',
    screens: ['play-action'],
    http: {},
    room: room(BASE_ROOM),
  },
  {
    id: 'hit',
    title: 'โดนผลจากคนอื่น',
    note: 'ผู้เล่นอื่นขโมยของ: การ์ด "เกิดกับคุณ" มาหลังเปิดห้อง',
    session: 'player',
    screens: ['play-hit', 'play-private', 'play-self'],
    http: {},
    room: room(BASE_ROOM, [{ afterMs: 1500, op: 'hit' }]),
  },
  {
    id: 'reconnect',
    title: 'socket หลุดแล้วต่อใหม่',
    note: 'หลุดหลังเปิดห้อง ต่อใหม่เองแล้วได้เรื่องที่พลาด',
    session: 'player',
    screens: ['play-feed', 'play-top-bar'],
    http: {},
    room: room(BASE_ROOM, [{ afterMs: 1500, op: 'drop' }]),
  },
  {
    id: 'period-change',
    title: 'เปลี่ยนช่วงเวลา / อากาศ',
    note: 'เทิร์น 2 แล้วข้ามไปช่วงถัดไป อากาศเปลี่ยน',
    session: 'player',
    screens: ['play-top-bar', 'play-feed'],
    http: {},
    room: room(BASE_ROOM, [
      { afterMs: 1500, op: 'nextTurn' },
      { afterMs: 3000, op: 'nextTurn' },
    ]),
  },
  { id: 'stuck', title: 'AI GM ติดขัด', note: 'กดลองใหม่ได้', session: 'player', screens: ['play-lock'], http: {}, room: room(ROOM_STATES.find((s) => s.gmStatus)!) },
  {
    id: 'late-npc',
    title: 'NPC พูดมาทีหลัง',
    note: 'บทพูด NPC ของเทิร์นก่อนมาถึงหลัง entry แรกของเทิร์นถัดไป ต้องอยู่ใต้เทิร์นของมันเอง (GEN-116)',
    session: 'player',
    screens: ['play-feed', 'play-npc'],
    http: {},
    room: room(BASE_ROOM, [], LATE_NPC_ENTRIES),
  },
  {
    id: 'budget-reached',
    title: 'AI GM หยุดเพราะงบ',
    note: 'งบ AI ของเดือนหมด เทิร์นค้างอยู่ ส่ง action ไม่ได้จนกว่างบกลับมา (GEN-122)',
    session: 'player',
    screens: ['play-lock', 'play-action'],
    http: {},
    room: room({ ...lockState('resolving'), status: 'resolving', gmStatus: { code: 'budget_reached', message: 'ใช้ครบงบ AI ของเดือนนี้แล้ว AI GM จะกลับมาเมื่อขึ้นเดือนใหม่', canRetry: false } }),
  },
  { id: 'single', title: 'เล่นคนเดียว', note: 'Single mode ไม่มีตัวนับคนส่ง', session: 'player', screens: ['play-top-bar'], http: {}, room: room(ROOM_STATES.find((s) => s.mode === 'single')!) },
  {
    id: 'gm',
    title: 'Human GM',
    note: 'GM ดูห้อง เทิร์นรออนุมัติ',
    session: 'gm',
    screens: ['gm-console', 'scenario-editor', 'play-top-bar'],
    http: { 'GET /api/game': ok(gmGame) },
    room: room(gmRoom, [], GM_ENTRIES),
  },
  {
    id: 'gm-finale',
    title: 'Human GM: ตอนจบรออนุมัติ',
    note: 'เทิร์นที่ค้างคือฉากจบ แก้ได้เฉพาะข้อความ (Q-215)',
    session: 'gm',
    screens: ['gm-console'],
    http: { 'GET /api/game': ok(gmGame), 'GET /api/game/gm/console': ok({ ...F.GmConsoleResponse[0], at: FINALE_TURN.at, status: 'finale', pending: FINALE_TURN }) },
    room: room(gmRoom, [], GM_ENTRIES),
  },
  {
    id: 'gm-budget',
    title: 'Human GM: ถึงเพดานงบ AI',
    note: 'AI GM หยุดเพราะใช้ครบงบของเดือน (Q-221)',
    session: 'gm',
    screens: ['gm-console'],
    http: { 'GET /api/game': ok(gmGame), 'GET /api/game/gm/console': ok({ ...F.GmConsoleResponse[0], status: 'resolving', pending: null }) },
    room: room({ ...gmRoom, status: 'resolving', gmStatus: { code: 'budget_reached', message: 'ใช้ครบงบ AI ของเดือนนี้แล้ว AI GM จะกลับมาเมื่อขึ้นเดือนใหม่หรือเมื่อปรับเพดาน', canRetry: false } }, [], GM_ENTRIES),
  },
  {
    id: 'ended',
    title: 'จบเกม ยังไม่ให้คะแนน',
    note: 'ฉากจบ เปิดความลับของทุกคน ส่งคะแนนแล้วฟอร์มเปลี่ยนเป็น "ส่งแล้ว"',
    session: 'player',
    screens: ['ending', 'ending-rating', 'home', 'play-lock'],
    http: { 'GET /api/game/log': ok(F.GameLogResponse[1]), 'GET /api/game/rating': ok(F.GameRatingResponse[1]) },
    room: room(endedRoom),
  },
  {
    id: 'ended-days',
    title: 'จบเกม ความลับหลายวัน',
    note: 'ความลับกระจายหลายวัน หลายคน: มีตัวกรองตามวัน',
    session: 'player',
    screens: ['ending'],
    http: { 'GET /api/game/log': ok(ENDED_DAYS_LOG), 'GET /api/game/rating': ok(F.GameRatingResponse[1]) },
    room: room(endedRoom),
  },
  {
    id: 'ended-rated',
    title: 'จบเกม ให้คะแนนแล้ว ผ่านเกณฑ์',
    note: 'คะแนนเฉลี่ยเกิน 8 และคนให้คะแนนครบครึ่ง',
    session: 'player',
    screens: ['ending-rating'],
    http: { 'GET /api/game/log': ok(F.GameLogResponse[1]) },
    room: room(endedRoom),
  },
  {
    id: 'ended-down',
    title: 'จบเกม โหวต 👎 การตัดสิน',
    note: 'GEN-171: ชุด 👍/👎 แบบ GEN-107 บนรายการ action → ผล; เห็นแค่โหวตของตัวเอง ไม่มียอดรวม',
    session: 'player',
    screens: ['ending', 'ending-rating'],
    http: { 'GET /api/game/log': ok(F.GameLogResponse[1]), 'GET /api/game/rating': ok(F.GameRatingResponse[2]) },
    room: room(endedRoom),
  },
  {
    id: 'ended-gm',
    title: 'จบเกม มุม Human GM',
    note: 'GEN-171: GM คนให้คะแนนได้ แต่ไม่มีปุ่มโหวตการตัดสิน (`canVote: false`)',
    session: 'player',
    screens: ['ending', 'ending-rating'],
    http: { 'GET /api/game/log': ok(F.GameLogResponse[1]), 'GET /api/game/rating': ok(F.GameRatingResponse[3]) },
    room: room(endedRoom),
  },
  {
    id: 'ended-low',
    title: 'จบเกม คะแนนไม่ผ่านเกณฑ์',
    note: 'คะแนนเฉลี่ยไม่เกิน 8: ไม่ถูกใช้เป็นความทรงจำ',
    session: 'player',
    screens: ['ending-rating'],
    http: { 'GET /api/game/log': ok(F.GameLogResponse[1]), 'GET /api/game/rating': ok(LOW_RATING), 'PUT /api/game/rating': ok(LOW_RATING) },
    room: room(endedRoom),
  },
  {
    id: 'ended-learning-failed',
    title: 'จบเกม สกัดความรู้ไม่สำเร็จ',
    note: 'Q-363: เจ้าของเกมเห็น "สกัดไม่สำเร็จ" พร้อมปุ่มลองใหม่ (คนอื่นได้ 403 ไม่เห็นกล่องนี้)',
    session: 'player',
    screens: ['ending'],
    http: { 'GET /api/game/log': ok(F.GameLogResponse[1]), 'GET /api/game/learning': ok(F.GameLearningResponse[1]) },
    room: room(endedRoom),
  },
  {
    id: 'chat-colours',
    title: 'สีของแชต (เทียบ mockup)',
    note: 'มี badge ได้เหรียญ ปุ่มโหวต และกล่องผู้เล่นอื่น (entry kind `player`, GEN-129)',
    session: 'player',
    screens: ['play-feed', 'play-changes'],
    http: {},
    room: room(BASE_ROOM, [], [...START_ENTRIES, { seq: 22, kind: 'changes', day: BASE_ROOM.day, phase: BASE_ROOM.phase, turn: BASE_ROOM.turn, place: null, text: 'ลิน', changes: [{ stat: 'coins', delta: 1, reason: 'ได้ทิป' }] }]),
  },
  {
    id: 'game-data-voice',
    title: 'ชุด Voice (แบบฟอร์ม)',
    note: 'กดชุด Voice: คำต้องห้าม + โปรไฟล์พูด NPC (GEN-192)',
    session: 'guest',
    screens: ['game-data'],
    http: { 'GET /api/admin/game-data/:name': ok(F.GameDataSetResponse[1]) },
    room: room(BASE_ROOM),
  },
  {
    id: 'library-empty',
    title: 'library ว่าง',
    note: 'ยังไม่มีเกมที่ให้ความรู้',
    session: 'guest',
    screens: ['learning-library'],
    http: { 'GET /api/admin/learning': ok(F.LearningLibraryResponse[1]) },
    room: room(BASE_ROOM),
  },
  {
    id: 'library-loading',
    title: 'library กำลังโหลด',
    note: 'คำตอบไม่มาเลย',
    session: 'guest',
    screens: ['learning-library'],
    http: { 'GET /api/admin/learning': { pending: true } },
    room: room(BASE_ROOM),
  },
  {
    id: 'library-error',
    title: 'library โหลดไม่ได้',
    note: 'ติดต่อ server ไม่ได้',
    session: 'guest',
    screens: ['learning-library'],
    http: { 'GET /api/admin/learning': { fail: 'network' } },
    room: room(BASE_ROOM),
  },
  // ISK-002 C1-C3: the admin เกม tab
  {
    id: 'admin-games',
    title: 'รายการเกมทุกสถานะ',
    note: 'รอเริ่ม / กำลังเตรียมตัว / กำลังเล่น / จบแล้ว / ปิดโดยผู้ดูแล; [ปิดเกม] เฉพาะที่ยังไม่จบ กดแล้วพิมพ์ชื่อเกมเพื่อยืนยัน',
    session: 'guest',
    screens: ['admin-games'],
    http: { 'GET /api/admin/games': ok(ADMIN_GAMES) },
    room: room(BASE_ROOM),
  },
  { id: 'admin-games-loading', title: 'รายการเกมกำลังโหลด', note: 'คำตอบไม่มาเลย', session: 'guest', screens: ['admin-games'], http: { 'GET /api/admin/games': { pending: true } }, room: room(BASE_ROOM) },
  { id: 'admin-games-error', title: 'รายการเกมโหลดไม่ได้', note: 'ติดต่อ server ไม่ได้ มีปุ่มลองใหม่', session: 'guest', screens: ['admin-games'], http: { 'GET /api/admin/games': { fail: 'network' } }, room: room(BASE_ROOM) },
  { id: 'admin-games-empty', title: 'ยังไม่มีเกม', note: 'server ยังไม่มีเกมเลย', session: 'guest', screens: ['admin-games'], http: { 'GET /api/admin/games': ok(F.AdminGamesResponse[1]) }, room: room(BASE_ROOM) },
  {
    id: 'admin-close-error',
    title: 'ปิดเกมไม่สำเร็จ',
    note: 'กดยืนยันแล้ว server ตอบ 409 (มีคนปิดไปก่อน): กล่องยังเปิดอยู่พร้อมข้อความ',
    session: 'guest',
    screens: ['admin-games'],
    http: { 'GET /api/admin/games': ok(ADMIN_GAMES), 'POST /api/admin/games/:id/close': { status: 409, body: { code: 'already_ended', message: 'เกมนี้จบหรือถูกปิดไปแล้ว' } } },
    room: room(BASE_ROOM),
  },
  {
    id: 'admin-close-pending',
    title: 'กำลังปิดเกม',
    note: 'กดยืนยันแล้วคำตอบยังไม่มา: ปุ่มหมุนและกดซ้ำไม่ได้',
    session: 'guest',
    screens: ['admin-games'],
    http: { 'GET /api/admin/games': ok(ADMIN_GAMES), 'POST /api/admin/games/:id/close': { pending: true } },
    room: room(BASE_ROOM),
  },
  // ISK-002 C4-C7: the players' side of a close
  {
    id: 'closed-play',
    title: 'ผู้ดูแลปิดเกมระหว่างเล่น',
    note: 'game_closed มาหลังเปิดห้อง 1.5 วิ: ป้ายปิดไม่ได้ + เหตุผล + [ไปหน้าสรุป] (กดปุ่ม "ผู้ดูแลปิดเกม" ซ้ำได้)',
    session: 'player',
    screens: ['play-lock'],
    http: {},
    room: room(BASE_ROOM, [{ afterMs: 1500, op: 'closeGame' }]),
  },
  {
    id: 'closed-lobby',
    title: 'ผู้ดูแลปิดเกมตอนรอเริ่ม',
    note: 'ไม่มีเหตุผล ไม่มีหน้าสรุป: [กลับหน้าแรก]',
    session: 'player',
    screens: ['lobby'],
    http: { 'GET /api/game': ok({ ...LOBBY_GAME, closed: { reason: null, hasSummary: false } }) },
    room: room(BASE_ROOM),
  },
  {
    id: 'closed-reopen',
    title: 'เปิดเกมที่ถูกปิดไปแล้ว',
    note: 'พลาด event ไปแล้วเปิดหน้าใหม่: ป้ายเดิม [ไปหน้าสรุป] พาไปหน้าจบเกมแบบปิดก่อนกำหนด',
    session: 'player',
    screens: ['lobby'],
    http: { 'GET /api/game': ok({ ...STARTED_GAME, closed: { reason: 'ทดสอบระบบ', hasSummary: true } }), 'GET /api/game/log': ok(CLOSED_LOG), 'GET /api/game/rating': ok(F.GameRatingResponse[1]) },
    room: room(endedRoom),
  },
  {
    id: 'ended-closed',
    title: 'จบเกม ปิดก่อนกำหนด',
    note: 'ป้าย "ปิดก่อนกำหนด" + เหตุผลแทนฉากจบ ชะตา (กรรม) และความลับเหมือนจบปกติ; รายการเกมขึ้น "ปิดโดยผู้ดูแล"',
    session: 'player',
    screens: ['ending', 'home'],
    http: { 'GET /api/game/log': ok(CLOSED_LOG), 'GET /api/game/rating': ok(F.GameRatingResponse[1]) },
    room: room(endedRoom),
  },
];

/** Unknown ids fall back to `normal`, so a typo in ?scenario= still opens a page. */
export const scenarioById = (id: string): MockScenario => SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0]!;
