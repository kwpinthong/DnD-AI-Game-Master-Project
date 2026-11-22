import { GameView, RoomEntry, RoomState, SurroundingsResponse, type CharacterView } from '@isekai/protocol';
import { CONTRACT_FIXTURES as F, CONTRACT_SCREENS, type ScreenId } from '@isekai/protocol/contract';

/**
 * isekai-mock-layer (GEN-100): the states the web can be put in without a server, all built from the GEN-099
 * fixtures (`@isekai/protocol/contract`). A scenario only picks fixtures or derives a state from one
 * (another lock, another turn); it never makes up a payload shape, and test/mock.test.tsx (C4) parses
 * every answer it gives against the contract schema. Dev only: main.tsx loads this with VITE_MOCK=1.
 */

/** What the mock room server can do, from a script step or a gallery button. */
export type MockOp = 'nextTurn' | 'hit' | 'othersSubmit' | 'closeTurn' | 'drop';
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
  room: {
    state: RoomState;
    entries: readonly RoomEntry[];
    script: readonly MockStep[];
  };
}

const ok = (body: unknown): MockReply => ({ status: 200, body });

const ROOM_STATES = F.RoomState.map((s) => RoomState.parse(s));
const ENTRIES = F.RoomEntry.map((e) => RoomEntry.parse(e));
const BASE_ROOM = ROOM_STATES[0]!;
const lockState = (code: string) => ROOM_STATES.find((s) => s.you.lock?.code === code)!;

/** The entries a player has at the start: everything but the hit (it arrives live) and the omen (Astral only). */
const START_ENTRIES = ENTRIES.filter((e) => e.kind !== 'hit' && e.kind !== 'omen');
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

/** GET /api/game/surroundings with your own gauges changed, so the status column agrees with the lock (GEN-088). */
function surroundingsWith(you: Partial<CharacterView>): Readonly<Record<string, MockReply>> {
  const base = SurroundingsResponse.parse(F.SurroundingsResponse[0]);
  if (base.view !== 'player' || !base.you) throw new Error('the first SurroundingsResponse fixture is the player view');
  return { 'GET /api/game/surroundings': ok({ ...base, you: { ...base.you, ...you } }) };
}
const SPENT = surroundingsWith({ stamina: { current: 0, max: 30 } });
const DOWN = surroundingsWith({ hp: { current: 0, max: 30 } });

const ALL_SCREENS = CONTRACT_SCREENS.map((s) => s.id);
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
      'GET /api/game/character/loot': ok(F.LootResponse[0]),
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
  { id: 'single', title: 'เล่นคนเดียว', note: 'Single mode ไม่มีตัวนับคนส่ง', session: 'player', screens: ['play-top-bar'], http: {}, room: room(ROOM_STATES.find((s) => s.mode === 'single')!) },
  {
    id: 'gm',
    title: 'Human GM',
    note: 'GM ดูห้อง เทิร์นรออนุมัติ',
    session: 'gm',
    screens: ['gm-console', 'scenario-editor', 'play-top-bar'],
    http: { 'GET /api/game': ok(gmGame) },
    room: room(gmRoom),
  },
  {
    id: 'ended',
    title: 'จบเกม',
    note: 'ฉากจบ เปิดความลับของทุกคน',
    session: 'player',
    screens: ['ending', 'home', 'play-lock'],
    http: { 'GET /api/game/log': ok(F.GameLogResponse[1]) },
    room: room(endedRoom),
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
];

/** Unknown ids fall back to `normal`, so a typo in ?scenario= still opens a page. */
export const scenarioById = (id: string): MockScenario => SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0]!;
