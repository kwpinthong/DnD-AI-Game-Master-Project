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

const gameView: In<typeof p.GameView> = {
  id: GAME_ID,
  name: 'เมืองก่อนอุกกาบาต',
  mode: 'online',
  humanGm: false,
  npcDialogue: 'normal',
  inviteCode: 'K7Q2MX',
  status: 'lobby',
  startedAt: null,
  you: { memberId: ME, role: 'player', isOwner: true },
  members: [
    { id: ME, name: 'นก', role: 'player', isOwner: true, hasCharacter: true },
    { id: 'm-bell', name: 'เบล', role: 'player', isOwner: false, hasCharacter: true },
    { id: 'm-ton', name: 'ต้น', role: 'player', isOwner: false, hasCharacter: false },
  ],
  players: { count: 3, min: 2, max: 6 },
  canEditScenario: false,
  startBlockers: ['ยังไม่สร้างตัวละคร: ต้น'],
};

const characterView = {
  name: 'ลิน',
  appearance: 'หญิงผ้าคลุมเทา แผลเป็นที่คาง',
  personality: 'ช่างสังเกต พูดน้อย ขี้ระแวง',
  hp: { current: 22, max: 30 },
  stamina: { current: 18, max: 30 },
  coins: 18,
  socialTitle: 'คนคุ้นหน้า',
  conduct: 'เป็นกลาง',
  statuses: [] as string[],
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
];
const narration: In<typeof p.RoomEntry> = { seq: 12, kind: 'narration', ...AT, place: null, text: 'คุณสังเกตว่านักบวชแจกขนมปังเฉพาะบ้านที่มีเด็ก', roll, myVote: 'down' };
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

const rating: In<typeof p.GameRatingView> = { mine: { score: 9, comment: 'สนุกมาก' }, liked: ['2-HESPERION-1-7'], thumbs: { '2-HESPERION-1-7': 3 }, average: 8.6, raters: 3, members: 4, eligible: true, blocker: null };
const learningSource = { sourceGameId: 'g-old', sourceGameName: 'คืนจันทราโลหิต', sourceScore: 8.6, status: 'active', createdAt: 1_795_200_000_000 } as const;
const learningEntries: In<typeof p.LearningEntryView>[] = [
  {
    ...learningSource,
    id: 'le-1',
    type: 'ruling',
    content: 'ผู้เล่นยื่นเหรียญให้ทหารยาม → โน้มน้าวสำเร็จ',
    tags: ['persuade', 'guard'],
    detail: { sourceRef: '3-SOLARION-1-4', actionText: 'ผู้เล่นยื่นเหรียญให้ทหารยาม', check: 'ladder', dcLabel: 'ปานกลาง', d20: 12, result: 'success', thumbs: 3, players: 4 },
  },
  { ...learningSource, id: 'le-2', type: 'lore', content: 'เมืองรอดเพราะม่านปาฏิหาริย์ โนอากลายเป็นเซราฟิเอล', tags: ['ending_good'], detail: { endingPath: 'good', npcIds: ['noa'] } },
  { ...learningSource, id: 'le-3', type: 'feedback_note', content: 'อยากให้ AI GM บอกเบาะแสชัดขึ้นตอนวันที่ 7', tags: [], detail: { fromComments: 2 } },
  { ...learningSource, id: 'le-4', type: 'style', status: 'suspended', content: 'ชอบสังเกตก่อนลงมือ', tags: ['observe'], detail: { topVerbs: ['observe', 'persuade'], secretShare: 0.25 } },
];

export const CONTRACT_FIXTURES: Fixtures = {
  HealthResponse: [{ ok: true, db: 'connected' }],
  ApiError: [
    { code: 'invalid_input', message: 'กรอกไม่ครบ', fields: { pin: 'PIN ต้องเป็นตัวเลข 4-6 หลัก' } },
    { code: 'locked', message: 'ล็อกชั่วคราว ลองใหม่เวลา 14:32', retryAt: '2026-11-22T07:32:00.000Z' },
    { code: 'cannot_start', message: 'ยังเริ่มไม่ได้', reasons: ['ยังไม่สร้างตัวละคร: ต้น'] },
  ],
  JoinRequest: [{ inviteCode: 'K7Q-2MX', name: 'นก', pin: '1234' }],
  JoinResponse: [{ token: 't0k3n', expiresAt: '2026-12-22T00:00:00.000Z', created: true, member }],
  JoinStyleFields: [{ playerCode: 'nok-2026', noStyle: false }],
  MeResponse: [{ member }],
  CreateGameRequest: [{ createCode: 'ลับเฉพาะ', gameName: 'เมืองก่อนอุกกาบาต', mode: 'online', humanGm: false, npcDialogue: 'low', name: 'นก', pin: '1234' }],
  CreateGameResponse: [{ token: 't0k3n', expiresAt: '2026-12-22T00:00:00.000Z', member, game: gameView }],
  GameMemorySetting: [{ enabled: true, sourceGameIds: ['g-old'] }, { enabled: false }],
  MemorySourcesRequest: [{ playerCode: 'nok-2026' }],
  MemorySourcesResponse: [{ games: [{ id: 'g-old', name: 'คืนจันทราโลหิต', score: 8.6, endedAt: '2026-11-20T00:00:00.000Z' }] }, { games: [] }],
  UpdateGameRequest: [{ gameName: 'ชื่อใหม่' }, { mode: 'single' }, { npcDialogue: 'high' }],
  GameView: [gameView, { ...gameView, status: 'started', startedAt: '2026-11-22T12:00:00.000Z', startBlockers: [], memory: { enabled: true, sources: [{ id: 'g-old', name: 'คืนจันทราโลหิต' }] } }],
  GameMemoryView: [{ enabled: false, sources: [] }],
  Scenario: [defaultScenario()],
  GameScenarioResponse: [{ scenario: defaultScenario(), locked: false }],
  CharacterRequest: [{ name: 'ลิน', appearance: 'หญิงผ้าคลุมเทา', personality: 'ช่างสังเกต พูดน้อย' }],
  CharacterResponse: [{ character: characterView }, { character: null }],
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
      people: [{ ref: 'p-red', appearance: 'ชายผมแดง ผ้าพันแผล', injury: 'บาดเจ็บ', socialTitle: 'คนคุ้นหน้า', name: null }],
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
  GameLogResponse: [gameLog, { ...gameLog, game: { ...gameLog.game, status: 'ended', endReason: 'finale' }, reveal }],
  GameRevealPlayer: [revealPlayer],
  ResponseVoteRequest: [{ vote: 'up' }, { vote: 'down' }, { vote: null }],
  ResponseVoteResponse: [{ seq: 11, myVote: 'up' }, { seq: 12, myVote: null }],
  GameRatingRequest: [{ score: 9, comment: 'สนุกมาก' }, { score: 7 }],
  GameRatingResponse: [{ rating }, { rating: { mine: null, liked: [], average: null, raters: 1, members: 4, eligible: false, blocker: 'too_few_raters' } }],
  RoomClientMessage: [{ type: 'hello', token: 't0k3n', afterSeq: 0 }],
  RoomHello: [{ type: 'hello', token: 't0k3n', afterSeq: 12 }],
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
    },
  ],
  GmTurnEditRequest: [{ reason: 'ปรับถ้อยคำ', narrations: [{ index: 0, text: 'คุณเห็นนักบวช…' }], results: [{ memberId: ME, hp: 20 }] }],
  GmPendingTurn: [gmPendingTurn, gmFinaleTurn],
  GmApproveResponse: [{ approved: AT }],
  GmAdjustRequest: [{ field: 'hp', memberId: ME, value: 25, reason: 'แก้ผล' }, { field: 'affinity', memberId: ME, npcId: 'merchant', value: 30, reason: 'แก้ผล' }],
  GmAdjustResponse: [{ override: gmOverride }],
  GmInsertEventRequest: [{ day: 6, phase: 'EOSORIA', title: 'ไฟไหม้ตลาด', reason: 'เพิ่มแรงกดดัน' }],
  GmInsertEventResponse: [{ event: { ...gmTimelineEvent, id: 'ev-gm-1', day: 6, title: 'ไฟไหม้ตลาด' } }],
  GmLogResponse: [{ overrides: [gmOverride] }],
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
    },
  ],
  LearningLibraryResponse: [
    {
      entries: learningEntries,
      counts: { lore: 1, feedback_note: 1, ruling: 1, style: 1 },
    },
    { entries: [], counts: { lore: 0, feedback_note: 0, ruling: 0, style: 0 } },
  ],
  PlayerStyleRequest: [{ playerCode: 'nok-2026' }, { playerCode: 'nok-2026', optOut: true }],
  PlayerStyleResponse: [{ style: { verbs: [{ verb: 'OBSERVE', count: 14 }, { verb: 'PERSUADE', count: 6 }], summary: 'ชอบสังเกตก่อนลงมือ' }, optOut: false }, { style: null, optOut: false }],
};
