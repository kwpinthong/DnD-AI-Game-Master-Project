import type { z } from 'zod';
import type * as p from '../index.ts';
import { defaultScenario } from '../scenario-default.ts';
import type { CONTRACT_SCHEMAS } from './registry.ts';

type In<S extends z.ZodType> = z.input<S>;

/**
 * Sample payloads for every contract schema (GEN-099 C4), typed against the schema's input so a schema
 * change that breaks them fails the protocol typecheck as well as the test. GEN-100's mock layer and the
 * screen gallery use these. Names / places are the sheet's; characters are made up (Screens and Flows v2).
 */
type Fixtures = { [K in keyof typeof CONTRACT_SCHEMAS]: readonly z.input<(typeof CONTRACT_SCHEMAS)[K]>[] };

const GAME_ID = 'g-0001';
const ME = 'm-lin';
const AT = { day: 3, phase: 'SOLARION', turn: 1 } as const;
const FOUNTAIN = { id: 'fountain', name: 'น้ำพุกลางเมือง' };
const FOUNTAIN_ZONED = { ...FOUNTAIN, zone: { id: 'central', name: 'โซนใจกลางเมือง' } };
const CHURCH = { id: 'church', name: 'โบสถ์' };

const member = { id: ME, gameId: GAME_ID, name: 'นก' };
const feedbackRow: In<typeof p.FeedbackRow> = {
  id: 7,
  gameId: GAME_ID,
  memberId: ME,
  type: 'bug',
  text: 'ปุ่มส่งค้าง',
  context: { day: 3, period: 'SOLARION', turn: 2, page: 'play', userAgent: 'Mozilla/5.0' },
  status: 'new',
  createdAt: '2026-11-23T10:00:00.000Z',
  updatedAt: '2026-11-23T10:00:00.000Z',
};

const gameView: In<typeof p.GameView> = {
  id: GAME_ID,
  name: 'เมืองก่อนอุกกาบาต',
  mode: 'online',
  humanGm: false,
  npcDialogue: 'normal',
  tone: 'A',
  inviteCode: 'K7Q2MX',
  status: 'lobby',
  startedAt: null,
  you: { memberId: ME, role: 'player' },
  members: [
    { id: ME, name: 'นก', role: 'player', ready: true, hasCharacter: true },
    { id: 'm-bell', name: 'เบล', role: 'player', ready: false, hasCharacter: true },
    { id: 'm-ton', name: 'ต้น', role: 'player', ready: false, hasCharacter: false },
  ],
  players: { count: 3, min: 2, max: 6 },
  canEditScenario: false,
  startBlockers: ['ยังไม่สร้างตัวละคร: ต้น'],
};

const characterView = {
  name: 'ลิน',
  appearance: 'หญิงผ้าคลุมเทา แผลเป็นที่คาง',
  personality: 'ช่างสังเกต พูดน้อย ขี้ระแวง',
  // ISK-006: made before the chips (CharacterResponse has one made with them).
  avatarId: null,
  appearanceTraits: null,
  hp: { current: 22, max: 30 },
  stamina: { current: 18, max: 30 },
  coins: 18,
  socialTitle: 'คนคุ้นหน้า',
  conduct: 'เป็นกลาง',
  statuses: [] as string[],
  strength: { label: 'ช่างสังเกต', description: 'มองเห็นรายละเอียดที่คนอื่นพลาด' },
  weakness: { label: 'กลัวความมืด', description: 'ในที่มืดใจสั่น' },
  editable: false,
} as const;

const lootOption = (id: string, kind: 'skill' | 'item', name: string): In<typeof p.LootOption> => ({
    id,
    kind,
    name,
    description: kind === 'skill' ? 'มองทะลุคำโกหกของคนตรงหน้า' : 'ผลึกที่สะท้อนความจริง',
    rank: 'B',
    triggerType: kind === 'skill' ? 'Active' : 'Passive',
    dailyLimit: kind === 'skill' ? 2 : 0,
    verbTags: ['OBSERVE'],
    targetTags: ['NPC'],
  effects: [],
});
const strength = { label: 'ช่างสังเกต', description: 'มองเห็นรายละเอียดที่คนอื่นพลาด' };
const weakness = { label: 'กลัวความมืด', description: 'ใจสั่นเมื่ออยู่ในที่มืด' };

const inventoryEntry = {
  id: 'own-1',
  name: 'Glare of Truth',
  rank: 'B',
  alignment: 'Neutral',
  category: 'Perception',
  triggerType: 'Active',
  dailyLimit: 2,
  usesLeftToday: 1,
  description: 'มองทะลุคำโกหกของคนตรงหน้า',
} as const;

const roll: In<typeof p.RollView> = {
  d20: 14,
  difficulty: 'ยาก',
  outcome: 'success',
  factors: [
    { label: 'Glare of Truth', kind: 'skill', dir: 'up' },
    { label: 'ฝนตก: ลอบเร้นง่ายขึ้น', kind: 'weather', dir: 'up' },
    { label: 'ง่วงซึม', kind: 'status', dir: 'down' },
    { label: 'ชะตา', kind: 'fate', dir: 'unknown' },
  ],
};
const hit: In<typeof p.HitView> = { actor: null, changes: [{ stat: 'coins', delta: -12 }, { stat: 'item_lost', name: 'Prism of Truth' }] };

const turnChanges: In<typeof p.TurnChange>[] = [
  { stat: 'stamina', delta: -3, reason: 'เดินทางข้ามโซน' },
  { stat: 'hp', delta: -5, reason: 'ถูกโจมตี' },
  { stat: 'coins', delta: -5, reason: 'ค่าที่พักโรงเตี๊ยม' },
  { stat: 'conduct', from: 'เป็นกลาง', to: 'ใจดี', reason: 'การกระทำของคุณ' },
  { stat: 'status_gained', name: 'ง่วงซึม', reason: 'อดนอน' },
  { stat: 'bond', name: 'เด็กขอทานตาบอดข้างหนึ่ง', from: 'ห่างเหิน', to: 'คุ้นเคย', reason: 'การกระทำในเทิร์นนี้' },
];
const narration: In<typeof p.RoomEntry> = { seq: 12, kind: 'narration', ...AT, place: null, text: 'คุณสังเกตว่านักบวชแจกขนมปังเฉพาะบ้านที่มีเด็ก', roll, myVote: 'down', myReasons: ['too_long'] };
const entries: In<typeof p.RoomEntry>[] = [
  // GEN-107: myVote null / 'up' / 'down' = the three button states (none / pressed ถูกใจ / pressed ไม่ถูกใจ)
  { seq: 10, kind: 'feed', ...AT, place: FOUNTAIN_ZONED, text: 'ชายผมแดงตะโกนขายยาสมุนไพรเสียงดัง', myVote: null },
  { seq: 11, kind: 'feed', ...AT, place: null, text: 'ประกาศเช้า: ทหารปิดท่าเรือ', myVote: 'up' },
  narration,
  { seq: 13, kind: 'hit', ...AT, place: null, text: 'ถุงเงินของคุณหายไป', hit },
  { seq: 14, kind: 'whisper', ...AT, place: null, text: 'คืนนี้เจอกันที่โบสถ์', whisper: { from: 'ลิน', to: 'ต้น', mine: true } },
  { seq: 15, kind: 'narration', ...AT, place: null, text: 'ระบบบรรยายแทน AI GM', fallback: true },
  { seq: 16, kind: 'omen', day: 6, phase: 'NOCTHERION', turn: 1, place: null, text: 'เงาใต้แท่นบูชากำลังรอคืนจันทราโลหิต' },
  { seq: 17, kind: 'changes', ...AT, place: null, text: 'ลิน', changes: turnChanges },
  { seq: 18, kind: 'npc', ...AT, place: FOUNTAIN_ZONED, text: 'ถ้าเจ้าอยากรู้เรื่องนาฬิกา ก็นั่งลงก่อนสิ', npc: { ref: 'n-ref-lucia', name: 'ลูเซีย', grade: 'F', kind: 'dialogue' } },
  { seq: 19, kind: 'npc', ...AT, place: FOUNTAIN_ZONED, text: 'เด็กขอทานเงยหน้ามองแล้วรีบถอยไปชิดกำแพง', npc: { ref: 'n-ref-noah', name: 'โนอา', grade: 'F', kind: 'reaction' } },
  { seq: 20, kind: 'npc', ...AT, place: null, text: 'ข้าเห็นว่าเจ้าไม่ได้มาที่นี่เพื่อน้ำพุเท่านั้น', npc: { ref: 'n-ref-lucia', name: 'ลูเซีย', kind: 'dialogue', private: true } },
  // GEN-129: another player's public action; the actor is the alias (Social Title) until the viewer knows the name
  { seq: 21, kind: 'player', ...AT, place: FOUNTAIN_ZONED, text: 'โยนเหรียญลงในหมวกของคุณ แล้วเดินจากไป', actor: { name: 'ผู้มาเยือนเสื้อคลุมแดง' } },
  // GEN-145: a new period began (server text, no votes)
  { seq: 23, kind: 'time', day: 6, phase: 'HESPERION', turn: 1, place: null, text: 'ระฆังหอคอยดังกังวานไปทั่วเมือง บัดนี้เข้าสู่ช่วง HESPERION (ค่ำ 18:00-23:59) แล้ว' },
  // ISK-014: the morning news, one line per item, the same for everyone (no votes)
  { seq: 24, kind: 'news', day: 6, phase: 'EOSORIA', turn: 1, place: null, text: 'หมอกพิษยังปกคลุมป่าทิศตะวันออก\nข่าวลือว่าแม่ชีผู้เหนื่อยล้าแห่งโบสถ์เก่าไม่ได้นอนทั้งคืน' },
];

const you: In<typeof p.RoomYou> = {
  memberId: ME,
  role: 'player',
  place: FOUNTAIN_ZONED,
  lock: null,
  secretUsed: false,
  drowsy: true,
  action: null,
  allies: [{ ref: 'p-ton', name: 'ต้น' }],
  placeActions: [],
  astral: null,
};
const meInRoom: In<typeof p.RoomMember> = { memberId: ME, name: 'นก', role: 'player', online: true, submitted: false };
const roomMembers: In<typeof p.RoomMember>[] = [
  meInRoom,
  { memberId: 'm-bell', name: 'เบล', role: 'player', online: true },
  { memberId: 'm-ton', name: 'ต้น', role: 'player', online: false },
];
const roomState: In<typeof p.RoomState> = {
  type: 'room',
  gameId: GAME_ID,
  mode: 'online',
  ...AT,
  status: 'collecting',
  weather: { weather: 'Rain', disaster: false },
  members: roomMembers,
  submittedCount: 3,
  you,
  gmStatus: null,
};
const astral: In<typeof p.AstralView> = {
  since: { day: 6, phase: 'HESPERION', turn: 2 },
  omen: { canSend: true, targets: [{ ref: 'p-ton', label: 'ชายผมแดง ผ้าพันแผล' }] },
};
/** One state per lock / screen state of 4a–4h. */
const roomStates: In<typeof p.RoomState>[] = [
  roomState,
  { ...roomState, status: 'resolving', you: { ...you, lock: { code: 'resolving', message: 'กำลังสรุปผล SOLARION เทิร์น 1…' }, action: { text: 'ตามนักบวชไปดู', visibility: 'secret', rest: false } } },
  { ...roomState, you: { ...you, lock: { code: 'traveling', message: 'กำลังเดินทางไป ป่า ถึงเมื่อจบเทิร์นนี้' } } },
  { ...roomState, you: { ...you, lock: { code: 'exhausted', message: 'คุณหมดแรง ต้องพักเทิร์นนี้' } } },
  { ...roomState, you: { ...you, lock: { code: 'unconscious', message: 'คุณสลบ 1 เทิร์น' } } },
  { ...roomState, you: { ...you, lock: { code: 'recovering', message: 'พักฟื้นที่สถานพยาบาลกลาง เหลือ 1 เทิร์น' } } },
  { ...roomState, phase: 'NOCTHERION', you: { ...you, place: null, lock: { code: 'astral_spirit', message: 'ลินเป็น Astral Spirit ตั้งแต่วันที่ 6 HESPERION' }, astral } },
  {
    ...roomState,
    you: {
      ...you,
      secretUsed: true,
      placeActions: [{ id: 'inn_rest', label: 'พัก (5 เหรียญ)', costCoins: 5, usesLeftToday: null, blocked: null }],
    },
  },
  { ...roomState, gmStatus: { code: 'stuck', message: 'AI GM ติดขัด', canRetry: true } },
  { ...roomState, mode: 'single', members: [meInRoom], submittedCount: 0 },
];

const gmCharacter: In<typeof p.GmCharacterView> = {
  memberId: ME,
  ref: 'p-lin',
  playerName: 'นก',
  name: 'ลิน',
  appearance: 'หญิงผ้าคลุมเทา แผลเป็นที่คาง',
  personality: 'ช่างสังเกต พูดน้อย',
  hp: { current: 22, max: 30 },
  stamina: { current: 18, max: 30 },
  injury: 'ปกติ',
  socialTitle: 'คนคุ้นหน้า',
  reputationScore: 14,
  karma: 3,
  conduct: 'เป็นกลาง',
  locationId: 'fountain',
  knowsNamesOf: [],
  npcBonds: [{ npcId: 'merchant', affinity: 52, nameRevealed: true }],
  playerBonds: [],
  curses: [{ label: 'หวาดกลัว', source: 'Venom of Despair', value: -3, turnsLeft: 2 }],
};
const gmTimelineEvent: In<typeof p.GmTimelineEvent> = { id: 'ev-5', day: 5, phase: 'EOSORIA', title: 'ภัยพิบัติเริ่ม', status: 'pending', outcome: null, outcomeSource: null, outcomeSide: null };
const gmPendingTurn: In<typeof p.GmPendingTurn> = {
  at: AT,
  entries: [{ index: 0, kind: 'narration', memberId: ME, locationId: null, text: 'คุณสังเกตว่า…', edited: false }],
  results: [{ memberId: ME, before: { hp: 22, stamina: 18, karma: 3 }, after: { hp: 22, stamina: 16, karma: 3 }, edited: false }],
  checks: [
    {
      memberId: ME,
      text: 'ตามนักบวช',
      visibility: 'secret',
      tags: ['OBSERVE', 'PRIEST'],
      dc: 14,
      modifiers: [{ label: 'Glare of Truth', value: 2 }, { label: 'ฝน', value: 1 }],
      d20: 14,
      total: 17,
      outcome: 'success',
    },
  ],
};
/** Q-215: the held turn is the game's ending (narration only). */
const gmFinaleTurn: In<typeof p.GmPendingTurn> = {
  at: { day: 12, phase: 'NOCTHERION', turn: 2 },
  entries: [{ index: 0, kind: 'feed', memberId: null, locationId: null, text: 'ม่านปาฏิหาริย์กางออกเหนือเมือง…', edited: false }],
  results: [],
  finale: true,
};
/** GEN-186: the held scene of a period that just opened (narration only). */
const gmSceneTurn: In<typeof p.GmPendingTurn> = {
  at: { day: 1, phase: 'HESPERION', turn: 1 },
  entries: [{ index: 0, kind: 'feed', memberId: null, locationId: 'fountain', text: 'แสงตะวันสุดท้ายลับหลังหอระฆัง…', edited: false }],
  results: [],
  checks: [],
  scene: true,
};
/** GEN-128: the held NPC lines of a published turn (text only). */
const gmDialogueTurn: In<typeof p.GmPendingTurn> = {
  at: { day: 1, phase: 'SOLARION', turn: 1 },
  entries: [{ index: 0, kind: 'feed', memberId: null, locationId: 'fountain', text: 'ข้าจำเจ้าได้ เจ้าคนที่มาเมื่อวาน', edited: false }],
  results: [],
  checks: [],
  dialogue: true,
};
const gmOverride = {
  id: 1,
  gmMemberId: 'm-gm',
  gmName: 'จีเอ็ม',
  kind: 'adjust',
  at: AT,
  target: `${ME}.hp`,
  before: 22,
  after: 25,
  reason: 'แก้ผลที่ AI ให้ผิด',
  createdAt: 1_795_000_000_000,
} as const;

const totals = {
  calls: 12,
  okCalls: 11,
  failedCalls: 1,
  inputTokens: 52_000,
  cachedInputTokens: 30_000,
  cacheWriteTokens: 4_000,
  outputTokens: 9_000,
  costUsdMicros: 410_000,
  unpricedCalls: 0,
} as const;
const ceiling = { spentUsdMicros: 410_000, ceilingUsdMicros: 20_000_000, percent: 2, status: 'ok' } as const;

const revealPlayer: In<typeof p.GameRevealPlayer> = {
  memberId: ME,
  lobbyName: 'นก',
  characterName: 'ลิน',
  karma: 24,
  karmaTier: 'ผู้มีจิตใจเอื้อเฟื้อ',
  outcome: 'survived',
  spawn: 'ลูกมือล้างจานประจำร้าน',
  companions: ['โนอา'],
  secretActions: [{ day: 2, phase: 'HESPERION', turn: 1, text: 'แอบเข้าโบสถ์ชั้นใต้ดิน', sourceRef: '2-HESPERION-1-7' }],
  appearance: 'หญิงผ้าคลุมเทา แผลเป็นที่คาง',
  finalTitle: 'ผู้ใจบุญ',
  epilogue: 'ลินยืนดูแสงรุ่งอรุณคืนสู่เมือง',
};
const reveal: In<typeof p.GameReveal> = { path: 'good', players: [revealPlayer] };
const playerTimeline: In<typeof p.GameTimelineResponse> = {
  view: 'player',
  at: { day: 3, phase: 'SOLARION' },
  ended: false,
  events: [{ id: 'ev-1', day: 1, phase: 'EOSORIA', title: 'ข่าวลืออุกกาบาต', status: 'resolved' }],
};
const gameLog: In<typeof p.GameLogResponse> = {
  game: { id: GAME_ID, name: 'เมืองก่อนอุกกาบาต', mode: 'online', humanGm: false, status: 'playing', endReason: null, at: AT, startedAt: '2026-11-22T12:00:00.000Z' },
  you: { memberId: ME, role: 'player' },
  members: [{ name: 'นก', role: 'player' }, { name: 'เบล', role: 'player' }],
  timeline: playerTimeline,
  entries,
  reveal: null,
};

const origin: In<typeof p.OriginView> = {
  kind: 'standard',
  tierLabel: 'จุดเกิดมาตรฐาน',
  spawnLabel: 'ลูกมือล้างจานประจำร้าน',
  location: { id: 'inn', name: 'โรงเตี๊ยมและกิลด์นักเดินทาง' },
  initialTitle: 'ลูกมือผู้ขยันขันแข็ง',
  passive: '+2 Stamina เมื่อพักที่โรงเตี๊ยม',
  illness: null,
  narration: 'คุณลืมตาขึ้นท่ามกลางกองจานสกปรก…',
} as const;

const correction: In<typeof p.AdminCorrection> = {
  id: 1,
  gameId: 'g-1',
  seq: 41,
  original: 'ข้าไม่ไว้ใจเจ้าหรอกนะ เจ้าหนู',
  edited: 'ข้ายังไม่ไว้ใจเจ้า',
  npc: 'โนอา',
  scene: 'npc-dialogue',
  reasons: ['out_of_character'],
  libraryCandidate: true,
  createdAt: '2026-11-23T09:30:00.000Z',
};
const rating: In<typeof p.GameRatingView> = { mine: { score: 9, comment: 'สนุกมาก' }, myVotes: { '2-HESPERION-1-7': 'up' }, canVote: true, average: 8.6, raters: 3, members: 4 };
const learningSource = { sourceGameId: 'g-old', sourceGameName: 'คืนจันทราโลหิต', sourceScore: 8.6, status: 'active', createdAt: 1_795_200_000_000 } as const;
const scheduleRow = { npc: 'โนอา', location: 'น้ำพุกลางเมือง', periods: ['SOLARION', 'HESPERION'], weathers: [], condition: '', note: 'ช่วงบ่าย-ค่ำ' };
const gameDataSummary: In<typeof p.GameDataSetSummary> = {
  name: 'NPC_Schedule',
  file: 'npc-schedule.json',
  records: 1,
  updatedAt: '2026-11-22T12:00:00.000Z',
  canUndo: true,
};
/** GEN-192: Voice is one object; the list counts its rules and NPC profiles. */
const voiceSummary: In<typeof p.GameDataSetSummary> = { name: 'Voice', file: 'voice.json', records: 0, parts: { forbidden: 2, npcs: 1 }, updatedAt: '2026-11-23T12:00:00.000Z', canUndo: false };
const voiceValue = {
  version: 1,
  tone: 'A',
  guide: { voice: 'ผู้เล่าเรื่องที่ยืนข้างผู้เล่น', register: 'ภาษาเขียนกลาง', length: 'ประโยคสั้น', use: ['กริยาตรง'] },
  forbidden: [
    { id: 'dai_tham_kan', match: { type: 'regex', value: '(ได้)?ทำการ' }, scope: 'all', severity: 'block', fix: 'ตัด ทำการ ใช้กริยาตรง' },
    { id: 'pronoun_repeat', match: { type: 'density', words: ['เขา', 'เธอ'], max: 1, perSentences: 2 }, scope: 'narration', severity: 'flag', fix: 'ละประธาน' },
  ],
  pairs: [{ bad: 'เขาได้ทำการเปิดประตูออก', good: 'เขาผลักประตูเปิด' }],
  npcs: {
    beggar: {
      register: 'child_polite',
      self: ['ผม'],
      you: { default: 'พี่', wary: 'ท่าน' },
      particles: ['ครับ', 'นะครับ'],
      catchphrases: ['ไม่เป็นไรครับ ผมชินแล้ว'],
      never: ['คำหยาบ'],
      neverWords: ['ค่ะ', 'เจ้า'],
      note: 'ติดอ่างตอนตื่นเต้น',
      forms: { ss_good: { register: 'archaic_divine', self: ['เรา'] } },
    },
  },
};

const learningEntries: In<typeof p.LearningEntryView>[] = [
  {
    ...learningSource,
    id: 'le-1',
    type: 'good_example',
    content: 'ผู้เล่นยื่นเหรียญให้ทหารยาม → ปานกลาง สำเร็จ',
    tags: ['persuade', 'guard'],
    detail: { sourceRef: 'ruling-3-SOLARION-1-4', kind: 'ruling', npcId: null, up: 3, down: 0, players: 4, dcLabel: 'ปานกลาง', d20: 12, result: 'success' },
  },
  {
    ...learningSource,
    id: 'le-5',
    type: 'avoid',
    content: 'บรรยายยืดยาวก่อนบอกผล',
    tags: [],
    detail: { sourceRef: 'entry-52', kind: 'narration', npcId: null, up: 0, down: 3, players: 4, dcLabel: null, d20: null, result: null },
  },
  { ...learningSource, id: 'le-2', type: 'lore', content: 'เมืองรอดเพราะม่านปาฏิหาริย์ โนอากลายเป็นเซราฟิเอล', tags: ['ending_good'], detail: { endingPath: 'good', npcIds: ['noa'] } },
  { ...learningSource, id: 'le-3', type: 'feedback_note', content: 'อยากให้ AI GM บอกเบาะแสชัดขึ้นตอนวันที่ 7', tags: [], detail: { fromComments: 2 } },
  { ...learningSource, id: 'le-4', type: 'style', status: 'suspended', content: 'ชอบสังเกตก่อนลงมือ', tags: ['observe'], detail: { topVerbs: ['observe', 'persuade'], secretShare: 0.25 } },
];

const adminGameRow = {
  id: 'g-1',
  name: 'เมืองก่อนอุกกาบาต',
  phase: 'playing',
  endedReason: null,
  day: 4,
  period: 'EOSORIA',
  playerCount: 3,
  lastActionAt: '2026-11-23T08:00:00.000Z',
  aiUsd: 0.42,
} as const;

export const CONTRACT_FIXTURES: Fixtures = {
  HealthResponse: [{ ok: true, db: 'connected' }],
  ApiError: [
    { code: 'invalid_input', message: 'กรอกไม่ครบ', fields: { pin: 'PIN ต้องเป็นตัวเลข 4-6 หลัก' } },
    { code: 'locked', message: 'ล็อกชั่วคราว ลองใหม่เวลา 14:32', retryAt: '2026-11-22T07:32:00.000Z' },
    { code: 'cannot_start', message: 'ยังเริ่มไม่ได้', reasons: ['ยังไม่สร้างตัวละคร: ต้น'] },
    { code: 'join_closed_day', message: 'เกมเลยวันที่ 9 แล้ว รับคนเพิ่มไม่ได้' },
    { code: 'session_expired', message: 'session หมดอายุ เข้าเกมใหม่ด้วยชื่อและ PIN เดิม' },
  ],
  JoinRequest: [{ inviteCode: 'K7Q-2MX', name: 'นก', pin: '1234' }],
  JoinResponse: [{ token: 't0k3n', expiresAt: '2026-12-22T00:00:00.000Z', created: true, member }],
  JoinStyleFields: [{ playerCode: 'nok-2026', noStyle: false }],
  MeResponse: [{ member }],
  CreateGameRequest: [{ createCode: 'ลับเฉพาะ', gameName: 'เมืองก่อนอุกกาบาต', mode: 'online', humanGm: false, npcDialogue: 'low', tone: 'B', name: 'นก', pin: '1234' },
    { createCode: 'ลับเฉพาะ', gameName: 'เมืองก่อนอุกกาบาต', mode: 'single', humanGm: false, name: 'นก', pin: '1234', playerCode: 'nok-2026', noStyle: true, memory: { enabled: true, sourceGameIds: ['g-old'] } },
    { createCode: 'ลับเฉพาะ', gameName: 'เมืองของ GM', mode: 'online', humanGm: true, name: 'จีเอ็ม', pin: '1234', scenario: defaultScenario() },
  ],
  CreateGameResponse: [{ token: 't0k3n', expiresAt: '2026-12-22T00:00:00.000Z', member, game: gameView }],
  GameMemorySetting: [{ enabled: true, sourceGameIds: ['g-old'] }, { enabled: false }],
  MemorySourcesRequest: [{ playerCode: 'nok-2026' }],
  MemorySourcesResponse: [{ games: [{ id: 'g-old', name: 'คืนจันทราโลหิต', score: 8.6, endedAt: '2026-11-20T00:00:00.000Z' }, { id: 'g-new', name: 'เมืองไร้คะแนน', score: null, endedAt: '2026-11-21T00:00:00.000Z' }] }, { games: [] }],
  GameReadyRequest: [{ ready: true }, { ready: false }],
  GameView: [gameView, { ...gameView, status: 'started', startedAt: '2026-11-22T12:00:00.000Z', startBlockers: [], memory: { enabled: true, sources: [{ id: 'g-old', name: 'คืนจันทราโลหิต' }] } }],
  GameMemoryView: [{ enabled: false, sources: [] }],
  Scenario: [defaultScenario()],
  GameScenarioResponse: [{ scenario: defaultScenario(), locked: false }],
  CharacterRequest: [
    {
      name: 'ลิน',
      personality: 'ช่างสังเกต พูดน้อย',
      avatarId: 'avatar-03',
      appearanceTraits: { hairColor: 'black', hairStyle: 'long', eyes: 'blue', build: 'tall', outfit: 'traveler', feature: 'scar', extra: 'ถือย่ามผ้า' },
    },
  ],
  CharacterResponse: [
    { character: characterView },
    { character: null },
    {
      character: {
        ...characterView,
        appearance: 'ผมยาวสีดำ ดวงตาสีฟ้า รูปร่างผอมสูง สวมชุดเดินทาง มีแผลเป็นที่แก้ม ถือย่ามผ้า',
        avatarId: 'avatar-03',
        appearanceTraits: { hairColor: 'black', hairStyle: 'long', eyes: 'blue', build: 'tall', outfit: 'traveler', feature: 'scar', extra: 'ถือย่ามผ้า' },
      },
    },
  ],
  AppearanceOptionsResponse: [
    {
      categories: {
        hairColor: [{ id: 'black', label: 'ดำ' }, { id: 'red', label: 'แดง' }],
        hairStyle: [{ id: 'long', label: 'ยาว' }, { id: 'shaved', label: 'โกน' }],
        eyes: [{ id: 'blue', label: 'ฟ้า' }, { id: 'heterochromia', label: 'สองสี' }],
        build: [{ id: 'tall', label: 'ผอมสูง' }],
        outfit: [{ id: 'traveler', label: 'ชุดเดินทาง' }],
        feature: [{ id: 'none', label: 'ไม่มี' }, { id: 'scar', label: 'แผลเป็นที่แก้ม' }],
      },
    },
  ],
  LootResponse: [
    {
      loot: {
        offer: { strength, weakness, skills: [lootOption('s1', 'skill', 'Glare of Truth')], items: [lootOption('i1', 'item', 'Prism of Truth')] },
        chosen: null,
        rerollsUsed: 0,
        rerollLimit: null,
        canReroll: true,
        needsNewChoice: false,
      },
    },
    {
      loot: {
        offer: null,
        chosen: { strength, weakness, skill: lootOption('s1', 'skill', 'Glare of Truth'), item: lootOption('i1', 'item', 'Prism of Truth') },
        rerollsUsed: 2,
        rerollLimit: null,
        canReroll: false,
        needsNewChoice: false,
      },
    },
  ],
  LootChooseRequest: [{ skillIds: ['s1'], itemIds: ['i1'] }],
  OriginResponse: [{ view: 'player', origin }, { view: 'player', origin: null }, { view: 'gm', origins: [{ ...origin, memberId: ME }] }],
  GameTimelineResponse: [playerTimeline, { view: 'gm', at: null, ended: false, events: [gmTimelineEvent] }],
  SurroundingsResponse: [
    {
      view: 'player',
      you: characterView,
      place: FOUNTAIN_ZONED,
      people: [{ ref: 'p-red', avatarId: 'avatar-05', appearance: 'ชายผมแดง ผ้าพันแผล', injury: 'บาดเจ็บ', socialTitle: 'คนคุ้นหน้า', name: null }],
      npcs: [{ ref: 'n-1', name: 'เด็กชายตัวผอม', nameRevealed: false }],
    },
    { view: 'gm', characters: [gmCharacter], evidence: [{ id: 1, locationId: 'church', day: 2, actorMemberId: ME }] },
  ],
  PlaceView: [FOUNTAIN, FOUNTAIN_ZONED],
  TravelResponse: [
    {
      from: FOUNTAIN_ZONED,
      zones: [
        {
          zone: { id: 'central', name: 'โซนใจกลางเมือง' },
          sameZone: true,
          staminaCost: 1,
          arrives: 'now',
          destinations: [
            { id: 'inn', name: 'โรงเตี๊ยมและกิลด์นักเดินทาง', tags: ['safe'], note: null, action: 'go' },
            { ...CHURCH, tags: [], note: null, action: 'go' },
            { id: 'church-crypt', name: 'โบสถ์ (ชั้นใต้ดิน)', tags: ['restricted'], note: 'ต้องมีสิทธิ์ หรือแทรกซึม (ทอย)', action: 'infiltrate' },
          ],
        },
        {
          zone: { id: 'east-forest', name: 'โซนป่าทิศตะวันออก' },
          sameZone: false,
          staminaCost: 3,
          arrives: 'next_turn',
          destinations: [{ id: 'forest', name: 'ป่า', tags: ['hazard'], note: 'อันตรายตั้งแต่วันที่ 5: แรงลดทุกเทิร์นที่อยู่', action: 'go' }],
        },
      ],
    },
    { from: null, zones: [] },
  ],
  CompanionsResponse: [
    {
      companions: [
        { ref: 'n-1', name: 'เด็กชายตัวผอม', nameRevealed: false, role: 'main', bond: { word: 'สนิท', step: 5 } },
        { ref: 'n-2', name: 'ทหารยามหนวดเฟิ้ม', nameRevealed: false, role: 'secondary' },
      ],
    },
    { companions: [] },
  ],
  CompanionView: [{ ref: 'n-1', name: 'โนอา', nameRevealed: true, role: 'main', bond: { word: 'ผูกพัน', step: 6 } }],
  BondView: [{ word: 'ห่างเหิน', step: 3 }],
  SaveCompanionRequest: [{ ref: 'n-1' }],
  InventoryResponse: [
    {
      inventory: {
        skills: [inventoryEntry],
        items: [{ ...inventoryEntry, id: 'own-2', name: 'Prism of Truth', triggerType: 'Passive', dailyLimit: 0, usesLeftToday: null }],
        discoveries: [{ kind: 'skill', name: 'Holy Light', text: 'สวดมนต์ที่โบสถ์ 3 วันติด' }],
      },
    },
  ],
  InventoryEntry: [inventoryEntry],
  GameLogResponse: [
    gameLog,
    { ...gameLog, game: { ...gameLog.game, status: 'ended', endReason: 'finale' }, reveal },
    { ...gameLog, game: { ...gameLog.game, status: 'ended', endReason: 'closed', closedEarly: true, closeReason: 'ทดสอบระบบ' }, reveal },
  ],
  GameRevealPlayer: [revealPlayer],
  ResponseVoteRequest: [{ vote: 'up' }, { vote: 'down' }, { vote: null }, { vote: 'down', reasons: ['translation', 'too_long'] }],
  ResponseVoteResponse: [{ seq: 11, myVote: 'up' }, { seq: 12, myVote: null }, { seq: 12, myVote: 'down', myReasons: ['translation'] }],
  GameRatingRequest: [{ score: 9, comment: 'สนุกมาก' }, { score: 7 }],
  GameRatingResponse: [
    { rating },
    { rating: { mine: null, myVotes: {}, canVote: true, average: null, raters: 0, members: 4 } },
    // GEN-171: a 👎, and the Human GM's view (rates, never votes).
    { rating: { ...rating, myVotes: { '2-HESPERION-1-7': 'down' } } },
    { rating: { ...rating, myVotes: {}, canVote: false } },
  ],
  RoomClientMessage: [{ type: 'hello', token: 't0k3n', afterSeq: 0 }],
  RoomHello: [{ type: 'hello', token: 't0k3n', afterSeq: 12 }, { type: 'hello', token: 't0k3n', afterSeq: 0, lobby: true }],
  RoomAction: [{ type: 'action', text: 'ตามนักบวชไปดูว่าเอาขนมปังมาจากไหน', visibility: 'secret' }, { type: 'action', text: 'พักที่โรงเตี๊ยม', visibility: 'public', rest: true, placeAction: 'inn_rest' }],
  RoomWhisper: [{ type: 'whisper', to: 'p-ton', text: 'คืนนี้เจอกันที่โบสถ์' }],
  RoomRetry: [{ type: 'retry' }],
  RoomMove: [{ type: 'move', to: 'โบสถ์' }],
  RoomOmen: [{ type: 'omen', to: 'p-ton', text: 'เงาใต้แท่นบูชากำลังรอคืนจันทราโลหิต' }],
  RoomServerMessage: [roomState, { type: 'entry', entry: narration }, { type: 'omen_accepted' }],
  RoomState: roomStates,
  RoomEntryMessage: entries.map((entry) => ({ type: 'entry', entry }) as const),
  RoomEntry: entries,
  RollView: [roll, { d20: 20, difficulty: 'แทบเป็นไปไม่ได้', outcome: 'critical_success', factors: [] }],
  TurnChange: turnChanges,
  NpcLineView: [
    { ref: 'n-ref-lucia', name: 'ลูเซีย', grade: 'F', kind: 'dialogue' },
    { ref: 'n-ref-noah', name: 'โนอา', kind: 'reaction', private: true },
  ],
  HitView: [hit, { actor: 'ชายผมแดง ผ้าพันแผล', changes: [{ stat: 'hp', delta: -8 }] }],
  PlaceActionView: [{ id: 'train', label: 'ฝึก TRAIN (วันนี้เหลือ 1)', costCoins: null, usesLeftToday: 1, blocked: null }],
  AstralView: [astral],
  RoomReady: [{ type: 'ready', lastSeq: 16 }],
  RoomActionAccepted: [{ type: 'action_accepted' }],
  RoomActionRejected: [{ type: 'action_rejected', code: 'secret_quota_used', message: 'ใช้ลับวันนี้แล้ว รีเซ็ตเช้าวันที่ 4' }],
  RoomWhisperAccepted: [{ type: 'whisper_accepted' }],
  RoomWhisperRejected: [{ type: 'whisper_rejected', code: 'not_allowed', message: 'ยังไม่มีพันธมิตรที่สนิทพอจะ Whisper ได้' }],
  RoomMoveAccepted: [{ type: 'move_accepted', kind: 'same_zone', place: { ...CHURCH, zone: { id: 'central', name: 'โซนใจกลางเมือง' } }, arrives: 'now' }],
  RoomMoveRejected: [{ type: 'move_rejected', code: 'not_enough_stamina', message: 'แรงไม่พอเดินทาง' }],
  RoomError: [{ type: 'error', code: 'no_character', message: 'สร้างตัวละครก่อน' }],
  RoomOmenAccepted: [{ type: 'omen_accepted' }],
  RoomOmenRejected: [{ type: 'omen_rejected', code: 'not_noctherion', message: 'ส่งลางสังหรณ์ได้อีกครั้งคืนนี้' }],
  GameClosedEvent: [{ type: 'game_closed', reason: 'ทดสอบระบบ', hasSummary: true }, { type: 'game_closed', reason: null, hasSummary: false }],
  LobbyReadyEvent: [{ type: 'lobby_ready', memberId: 'm-bell', ready: true }, { type: 'lobby_ready', memberId: 'm-bell', ready: false }],
  LobbyStartBlockedEvent: [{ type: 'lobby_start_blocked', reason: 'ยังไม่ได้ตั้งค่า AI' }],
  RematchReadyEvent: [{ type: 'rematch_ready', memberId: 'm-bell', ready: true }, { type: 'rematch_ready', memberId: 'm-bell', ready: false }],
  RematchStartedEvent: [{ type: 'rematch_started', gameId: 'g-round-2' }],
  AdminGamesResponse: [{ games: [adminGameRow, { ...adminGameRow, id: 'g-lobby', name: 'ห้องรอ', phase: 'lobby', day: null, period: null, playerCount: 2, lastActionAt: null, aiUsd: 0 }] }, { games: [] }],
  AdminGameRow: [adminGameRow, { ...adminGameRow, phase: 'ended', endedReason: 'closed' }],
  AdminCloseGameRequest: [{ confirmName: 'เมืองก่อนอุกกาบาต', reason: 'ทดสอบระบบ' }, { confirmName: 'เมืองก่อนอุกกาบาต' }],
  AdminMembersResponse: [
    {
      members: [
        { id: 'm-gm', name: 'จีเอ็ม', role: 'gm', hasCharacter: false, ready: false, kickedAt: null },
        { id: 'm-1', name: 'นก', role: 'player', hasCharacter: true, ready: false, kickedAt: null },
        { id: 'm-2', name: 'บี', role: 'player', hasCharacter: false, ready: false, kickedAt: '2026-11-24T10:00:00.000Z' },
      ],
    },
    { members: [] },
  ],
  AdminInviteCodeResponse: [{ inviteCode: 'K7Q2MX' }],
  GmConsoleResponse: [
    {
      view: 'gm',
      at: AT,
      status: 'collecting',
      characters: [gmCharacter],
      evidence: [],
      actions: [{ memberId: ME, ...AT, text: 'ตามนักบวช', visibility: 'secret', rest: false }],
      events: [gmTimelineEvent],
      legendaries: defaultScenario().legendaries,
      pending: gmPendingTurn,
      fallbacks: [{ at: AT, kind: 'narration', memberId: ME, locationId: null, cause: 'timeout' }],
      npcs: [{ npcId: 'merchant', name: 'พ่อค้าเร่', curses: [{ label: 'มึนงง', source: 'Mist of Confusion', value: -2, turnsLeft: 1 }] }],
      autoApproveLines: false,
    },
  ],
  GmTurnEditRequest: [{ reason: 'ปรับถ้อยคำ', narrations: [{ index: 0, text: 'คุณเห็นนักบวช…' }], results: [{ memberId: ME, hp: 20 }] }],
  GmPendingTurn: [gmPendingTurn, gmFinaleTurn, gmSceneTurn, gmDialogueTurn],
  GmApproveResponse: [{ approved: AT }],
  GmAdjustRequest: [{ field: 'hp', memberId: ME, value: 25, reason: 'แก้ผล' }, { field: 'affinity', memberId: ME, npcId: 'merchant', value: 30, reason: 'แก้ผล' }],
  GmAdjustResponse: [{ override: gmOverride }],
  GmInsertEventRequest: [{ day: 6, phase: 'EOSORIA', title: 'ไฟไหม้ตลาด', reason: 'เพิ่มแรงกดดัน' }],
  GmInsertEventResponse: [{ event: { ...gmTimelineEvent, id: 'ev-gm-1', day: 6, title: 'ไฟไหม้ตลาด' } }],
  GmLogResponse: [{ overrides: [gmOverride] }],
  GmSettings: [{ autoApproveLines: true }, { autoApproveLines: false }],
  GmVotesResponse: [
    {
      players: 3,
      entries: [
        { seq: 11, kind: 'feed', at: AT, text: 'ระฆังดังทั่วเมือง', up: 2, down: 0, good: true, avoid: false },
        { seq: 12, kind: 'narration', at: AT, text: 'คุณเห็นนักบวช…', up: 0, down: 2, good: false, avoid: true },
      ],
    },
    { players: 2, entries: [] },
  ],
  AdminSessionRequest: [{ code: 'รหัสผู้ดูแล' }],
  AdminSessionResponse: [{ token: 'adm1n', expiresAt: '2026-11-22T13:00:00.000Z' }],
  AiUsageOverviewResponse: [
    {
      generatedAt: '2026-11-22T12:00:00.000Z',
      totals,
      byPurpose: [{ purpose: 'gm_adjudicate', totals }],
      failures: [{ kind: 'timeout', count: 1 }],
      games: [{ game: { id: GAME_ID, name: 'เมืองก่อนอุกกาบาต' }, totals, ceiling, lastCallAt: '2026-11-22T11:59:00.000Z' }],
    },
  ],
  AiUsageGameResponse: [
    {
      generatedAt: '2026-11-22T12:00:00.000Z',
      game: { id: GAME_ID, name: null },
      ceiling,
      totals,
      byPurpose: [{ purpose: 'narrate_player', totals }],
      byPeriod: [{ day: 3, phase: 'SOLARION', totals }, { day: null, phase: null, totals }],
      byModel: [{ model: 'claude-sonnet-5-5', priced: true, totals }],
      failures: [],
      refusals: [
        {
          at: '2026-11-22T11:58:00.000Z',
          purpose: 'gm_adjudicate',
          stage: 'first',
          errors: [{ code: 'stamina_cost_mismatch', path: 'actions[0].staminaCost', message: 'general costs 3, got 9', got: '9' }],
          proposal: '{"actions":[{"actionId":"act-1","actor":"r1","staminaCost":9,"reason":"{{p:r1}} ค้นห้องเก็บของ…"}]}',
        },
      ],
    },
  ],
  GameDataListResponse: [
    { sets: [gameDataSummary, { ...gameDataSummary, name: 'NPC', file: 'npc.json', records: 12, canUndo: false }, voiceSummary] },
  ],
  GameDataSetResponse: [
    { set: gameDataSummary, value: [scheduleRow] },
    { set: voiceSummary, value: voiceValue },
  ],
  GameDataSaveRequest: [{ value: [scheduleRow] }],
  GameDataAuditResponse: [
    {
      entries: [
        {
          id: 1,
          name: 'NPC_Schedule',
          action: 'edit',
          at: '2026-11-22T12:00:00.000Z',
          backupFile: 'NPC_Schedule-2026-11-22T12-00-00-000Z-1a2b3c4d.json',
          changes: [{ index: 0, old: { ...scheduleRow, periods: ['EOSORIA'] }, new: scheduleRow }],
        },
      ],
    },
    { entries: [] },
  ],
  GameDataImportPreviewResponse: [
    { set: gameDataSummary, value: [scheduleRow], changes: [{ index: 0, old: { ...scheduleRow, periods: ['EOSORIA'] }, new: scheduleRow }] },
    { set: gameDataSummary, value: [scheduleRow], changes: [] },
  ],
  GameDataExportResponse: [{ exportedAt: '2026-11-22T12:00:00.000Z', files: { 'npc-schedule.json': [scheduleRow] } }],
  LearningLibraryResponse: [
    {
      entries: learningEntries,
      counts: { lore: 1, feedback_note: 1, good_example: 1, avoid: 1, style: 1 },
    },
    { entries: [], counts: { lore: 0, feedback_note: 0, good_example: 0, avoid: 0, style: 0 } },
  ],
  GameLearningResponse: [{ status: 'done' }, { status: 'failed' }, { status: 'pending' }],
  LearningExtractResponse: [
    { status: 'done', message: 'สกัดความรู้แล้ว', lore: 2, feedback: 1 },
    { status: 'failed', message: 'สกัดไม่สำเร็จ', lore: 0, feedback: 0 },
  ],
  PlayerStyleRequest: [{ playerCode: 'nok-2026' }, { playerCode: 'nok-2026', optOut: true }],
  PlayerStyleResponse: [{ style: { verbs: [{ verb: 'OBSERVE', count: 14 }, { verb: 'PERSUADE', count: 6 }], summary: 'ชอบสังเกตก่อนลงมือ' }, optOut: false }, { style: null, optOut: false }],
  // GEN-168: the server owner's 👎 review
  AdminDownvotesResponse: [
    {
      entries: [
        { gameId: 'g-1', gameName: 'คืนจันทราโลหิต', seq: 41, scene: 'npc-dialogue', npc: { id: 'npc-noa', name: 'โนอา' }, at: { day: 2, phase: 'SOLARION', turn: 1 }, text: 'ข้าไม่ไว้ใจเจ้าหรอกนะ เจ้าหนู', down: 3, reasons: { out_of_character: 2, translation: 1 }, corrections: [correction] },
        { gameId: 'g-1', gameName: 'คืนจันทราโลหิต', seq: 44, scene: 'narration', npc: null, at: { day: 2, phase: 'HESPERION', turn: 2 }, text: 'ฝนตกหนักจนมองไม่เห็นอะไรเลยแม้แต่ปลายจมูกของตัวเองที่ยื่นออกไป', down: 1, reasons: { too_long: 1 }, corrections: [] },
      ],
    },
    { entries: [] },
  ],
  AdminCorrectionRequest: [{ gameId: 'g-1', seq: 41, edited: 'ข้ายังไม่ไว้ใจเจ้า', toLibrary: true }, { gameId: 'g-1', seq: 44, edited: 'ฝนตกหนักจนมองแทบไม่เห็นทาง' }],
  AdminCorrectionResponse: [{ correction }],
  AdminCorrectionsExportResponse: [
    {
      exportedAt: '2026-11-23T10:00:00.000Z',
      count: 1,
      jsonl: '{"npc":"โนอา","scene":"npc-dialogue","reasons":["out_of_character"],"original":"ข้าไม่ไว้ใจ {{PLAYER_1}} หรอกนะ","edited":"ข้ายังไม่ไว้ใจ {{PLAYER_1}}","libraryCandidate":true}\n',
    },
  ],
  // GEN-169: the style checker
  StyleFlagsResponse: [
    {
      stats: [
        { npc: { id: 'archbishop', alias: 'นักบวชผู้ใจบุญประจำเมือง' }, reason: 'pronoun_mismatch', count: 3 },
        { npc: null, reason: 'dai_tham_kan', count: 1 },
      ],
    },
    { stats: [] },
  ],
  StyleSettingsRequest: [{ rewrite: true }, { defaultTone: 'C' }, {}],
  StyleSettingsResponse: [{ settings: { rewrite: false, defaultTone: 'A' } }],
  // GEN-167: two eval rounds side by side (a failed scene, a real-name flag), and no round yet.
  StyleEvalResponse: [
    {
      previous: {
        id: 1,
        createdAt: 1_795_400_000_000,
        provider: 'anthropic',
        models: ['claude-sonnet-5-5'],
        voiceVersion: 1,
        costUsdMicros: 182_000,
        scenes: [
          { sceneId: 'greeting', title: 'ทักทายเด็กขอทานที่น้ำพุ', purpose: 'npc_dialogue', ok: true, text: '{{n:beggar}}: สวัสดีขอรับ ท่านมาจากไหนหรือ', failure: null, flags: [], costUsdMicros: 12_000 },
          { sceneId: 'ask-way', title: 'ถามทางไปโบสถ์', purpose: 'narrate_player', ok: true, text: 'ทหารยามชี้ไปทางหอระฆังโดยไม่พูดสักคำ', failure: null, flags: [], costUsdMicros: 15_000 },
        ],
      },
      current: {
        id: 2,
        createdAt: 1_795_500_000_000,
        provider: 'anthropic',
        models: ['claude-sonnet-5-5'],
        voiceVersion: 2,
        costUsdMicros: 170_000,
        scenes: [
          { sceneId: 'greeting', title: 'ทักทายเด็กขอทานที่น้ำพุ', purpose: 'npc_dialogue', ok: true, text: '{{n:beggar}}: พี่ใจดีจัง… ขอบคุณนะ', failure: null, flags: [], costUsdMicros: 11_000 },
          { sceneId: 'ask-way', title: 'ถามทางไปโบสถ์', purpose: 'narrate_player', ok: false, text: null, failure: 'timeout: timeout', flags: [], costUsdMicros: 0 },
          { sceneId: 'sad', title: 'ฉากเศร้าที่โบสถ์', purpose: 'narrate_place', ok: true, text: 'โนอานั่งเงียบอยู่หน้าแท่นบูชา', failure: null, flags: ['real_name'], costUsdMicros: 14_000 },
        ],
      },
      marks: { greeting: 'better' },
      summary: { better: 1, same: 0, worse: 0, unmarked: 2 },
    },
    { current: null, previous: null, marks: {}, summary: { better: 0, same: 0, worse: 0, unmarked: 0 } },
  ],
  StyleEvalMarkRequest: [{ mark: 'better' }, { mark: 'worse' }, { mark: null }],
  // GEN-151: the NPC example library
  NpcLibraryResponse: [
    {
      npcs: [
        {
          npcId: 'npc-noa',
          npcName: 'โนอา',
          examples: [
            { id: 1, npcId: 'npc-noa', scene: 'npc-dialogue', text: 'ข้ายังไม่ไว้ใจ {{p:player}} หรอก', source: 'correction', gameId: 'g-1', seq: 41, createdAt: '2026-11-23T09:30:00.000Z' },
            { id: 2, npcId: 'npc-noa', scene: 'npc-reaction', text: '{{n:npc-noa}} ยักไหล่', source: 'vote', gameId: 'g-1', seq: 47, createdAt: '2026-11-23T09:40:00.000Z' },
          ],
        },
      ],
      upvoted: [
        { gameId: 'g-1', gameName: 'คืนจันทราโลหิต', seq: 48, scene: 'npc-dialogue', npc: { id: 'npc-noa', name: 'โนอา' }, at: { day: 2, phase: 'SOLARION', turn: 2 }, text: 'เจ้าหนูนี่กล้าดีนะ', up: 2, inLibrary: false },
        { gameId: 'g-1', gameName: 'คืนจันทราโลหิต', seq: 47, scene: 'npc-reaction', npc: { id: 'npc-noa', name: 'โนอา' }, at: { day: 2, phase: 'SOLARION', turn: 1 }, text: 'โนอายักไหล่', up: 1, inLibrary: true },
      ],
      candidates: [{ ...correction, id: 2, seq: 44, original: 'ฝนตกหนัก', edited: 'ฝนตกพรำ ๆ ทั่วลานน้ำพุ', npc: null, scene: 'narration', reasons: [] }],
      npcChoices: [{ id: 'npc-noa', name: 'โนอา' }, { id: 'npc-mira', name: 'มีรา' }],
      goodLines: [{ gameId: 'g-old', seq: 52, npc: { id: 'npc-mira', name: 'มีรา' }, text: '{{n:npc-mira}} หัวเราะ "ผู้เล่นกล้าดีนี่"', up: 3 }],
    },
    { npcs: [], upvoted: [], candidates: [], npcChoices: [], goodLines: [] },
  ],
  NpcExampleAddRequest: [
    { from: 'vote', gameId: 'g-1', seq: 48, npcId: 'npc-noa', scene: 'npc-dialogue' },
    { from: 'correction', correctionId: 2, npcId: 'npc-mira' },
    { from: 'correction', correctionId: 1 },
  ],
  // GEN-178: the style review round
  StyleReviewResponse: [
    {
      running: false,
      minSignals: 20,
      gamesPerRound: 5,
      gamesSinceRound: 2,
      waiting: { downvotes: 3, flags: 4, reasons: { too_long: 2 }, rules: { dai_tham_kan: 4 }, npcs: { '': 5, 'npc-noa': 2 } },
      rounds: [
        {
          id: 2,
          trigger: 'manual',
          status: 'done',
          signals: 27,
          counts: { downvotes: 12, flags: 15, reasons: { out_of_character: 4, wrong_story: 8 }, rules: { dai_tham_kan: 10, pronoun_mismatch: 5 }, npcs: { '': 16, 'npc-noa': 11 } },
          patterns: [{ summary: 'บรรยายใช้ "ได้ทำการ" ซ้ำ', evidence: [41, 44] }],
          error: null,
          createdAt: '2026-11-23T10:00:00.000Z',
        },
        { id: 1, trigger: 'games', status: 'skipped', signals: 19, counts: { downvotes: 9, flags: 10, reasons: {}, rules: { loanword: 10 }, npcs: { '': 19 } }, patterns: [], error: null, createdAt: '2026-11-22T10:00:00.000Z' },
      ],
      proposals: [
        { id: 2, roundId: 2, kind: 'pair', npcId: null, content: { bad: 'เขามีความโกรธ', good: 'เขาโกรธ' }, reason: 'ตัด มีความ ที่ไม่จำเป็น', evidence: [44], status: 'proposed', voiceVersion: null, decidedAt: null },
        {
          id: 1,
          roundId: 2,
          kind: 'forbid',
          npcId: null,
          content: { id: 'tham_kan', match: { type: 'literal', value: 'ทำการ' }, scope: 'all', severity: 'block', fix: 'ตัด ทำการ' },
          reason: 'เจอซ้ำในบรรยาย',
          evidence: [41],
          status: 'approved',
          voiceVersion: 2,
          decidedAt: '2026-11-23T10:05:00.000Z',
        },
      ],
      voice: {
        version: 2,
        versions: [
          { version: 2, at: '2026-11-23T10:05:00.000Z', current: true },
          { version: 1, at: '2026-11-20T08:00:00.000Z', current: false },
        ],
      },
      goodCandidates: [{ gameId: 'g-1', seq: 48, npc: { id: 'npc-noa', name: 'โนอา' }, text: 'เจ้าหนูนี่กล้าดีนะ', up: 2 }],
    },
    {
      running: true,
      minSignals: 20,
      gamesPerRound: 5,
      gamesSinceRound: 0,
      waiting: { downvotes: 0, flags: 0, reasons: {}, rules: {}, npcs: {} },
      rounds: [],
      proposals: [],
      voice: { version: 1, versions: [{ version: 1, at: '2026-11-20T08:00:00.000Z', current: true }] },
      goodCandidates: [],
    },
  ],
  StyleProposalApproveRequest: [{}, { content: { bad: 'เขามีความสุข', good: 'เขาสุขใจ' } }],
  NpcChatRequest: [{ npc: 'r-merchant', text: 'วันนี้ตลาดคึกคักไหม' }, { npc: 'r-merchant', text: 'ขอดาบเล่มนั้นได้ไหม', whisper: true }],
  NpcChatStatus: [{ perPeriod: 5, left: 3 }, { perPeriod: 5, left: 0 }],
  NpcChatResponse: [
    { reply: 'คึกคักสิ พ่อค้าจากแดนเหนือเพิ่งมาถึง', suggestion: null, status: { perPeriod: 5, left: 4 } },
    { reply: 'ของดีแบบนี้ไม่ได้ให้กันง่ายๆ หรอกนะ', suggestion: 'ลองต่อรองซื้อดาบเป็น action ของเทิร์นนี้', status: { perPeriod: 5, left: 0 } },
  ],
  // ISK-010: Report & Feedback
  FeedbackInput: [{ type: 'bug', text: 'ปุ่มส่งค้าง', page: 'play', userAgent: 'Mozilla/5.0' }, { type: 'idea', text: 'อยากให้มีแผนที่', page: 'lobby' }],
  FeedbackRow: [feedbackRow, { ...feedbackRow, id: 8, type: 'idea', text: '<b>ไม่ใช่ HTML</b>', context: { day: null, period: null, turn: null, page: 'lobby', userAgent: '' }, status: 'done' }],
  AdminFeedbackResponse: [{ feedback: [feedbackRow] }, { feedback: [] }],
  AdminFeedbackStatusRequest: [{ status: 'reviewing' }, { status: 'done' }],
};
