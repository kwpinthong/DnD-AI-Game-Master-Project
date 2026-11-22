import * as p from '../index.ts';

/**
 * The screen ↔ backend contract (GEN-099): which endpoint / socket event each screen of Screens and Flows v2
 * (GEN-086) uses, the schema of its payload, and whether the backend sends it today (`ready`) or a task
 * still has to (`pending` + owner). The web uses these schemas only; a backend change must keep its payloads
 * passing them. docs/contract.md is rendered from this file (`pnpm --filter @isekai/protocol contract:docs`)
 * and a test fails when the two differ. `new` = a backend gap of a task that is already done, no task yet.
 */

export const CONTRACT_SCREENS = [
  { id: 'home', title: '0. หน้าแรก + รายการเกม' },
  { id: 'join', title: '1. Join' },
  { id: 'create-game', title: '2. สร้างเกม' },
  { id: 'scenario-editor', title: '2b. แก้ scenario' },
  { id: 'lobby', title: '2c. Lobby' },
  { id: 'character', title: '3. สร้างตัวละคร + ของติดตัว' },
  { id: 'origin-card', title: '4k. การ์ดจุดเกิด' },
  { id: 'play-top-bar', title: '4.1 Play: top bar วัน / ช่วง / อากาศ / ส่งแล้ว' },
  { id: 'play-place', title: '4.2 Play: สถานที่ + คนที่อยู่ด้วย + เดินทาง' },
  { id: 'play-feed', title: '4.4 Play: feed สาธารณะ' },
  { id: 'play-private', title: '4.5 Play: เรื่องของคุณ (narration ส่วนตัว + ผลทอย) + Whisper' },
  { id: 'play-changes', title: '4.5 Play: ค่าที่เปลี่ยนต่อเทิร์น (log ส่วนตัว + ประวัติ)' },
  { id: 'play-hit', title: '4.5 Play: การ์ดผลที่โดน (pin)' },
  { id: 'play-self', title: '4.3 Play: สถานะตัวเอง (HP, แรง, เหรียญ, ฉายา, กรรมเป็นคำ, ลับ)' },
  { id: 'play-companions', title: '4.3 Play: คู่หู' },
  { id: 'play-inventory', title: '4.3 Play: ความสามารถ + ของ' },
  { id: 'play-action', title: '4.6 Play: ช่อง action' },
  { id: 'play-lock', title: '4b–4g Play: สถานะล็อก' },
  { id: 'play-astral', title: '4h Play: Astral Spirit' },
  { id: 'gm-console', title: '5. GM console' },
  { id: 'ending', title: '6. จบเกม: ฉากจบ + ชะตา + ความลับ' },
  { id: 'ending-rating', title: '6. จบเกม: ให้คะแนน + 👍' },
  { id: 'learning-library', title: '7. Learning library (ผู้ดูแล)' },
  { id: 'ai-usage', title: '8. AI usage (ผู้ดูแล)' },
  { id: 'my-style', title: '9. สไตล์ของฉัน' },
] as const;
export type ScreenId = (typeof CONTRACT_SCREENS)[number]['id'];

/** Every schema the contract names, by its export name (C1 checks each is exported under that name). */
export const CONTRACT_SCHEMAS = {
  HealthResponse: p.HealthResponse,
  ApiError: p.ApiError,
  JoinRequest: p.JoinRequest,
  JoinResponse: p.JoinResponse,
  JoinStyleFields: p.JoinStyleFields,
  MeResponse: p.MeResponse,
  CreateGameRequest: p.CreateGameRequest,
  CreateGameResponse: p.CreateGameResponse,
  GameMemorySetting: p.GameMemorySetting,
  MemorySourcesRequest: p.MemorySourcesRequest,
  MemorySourcesResponse: p.MemorySourcesResponse,
  UpdateGameRequest: p.UpdateGameRequest,
  GameView: p.GameView,
  GameMemoryView: p.GameMemoryView,
  Scenario: p.Scenario,
  GameScenarioResponse: p.GameScenarioResponse,
  CharacterRequest: p.CharacterRequest,
  CharacterResponse: p.CharacterResponse,
  LootResponse: p.LootResponse,
  LootChooseRequest: p.LootChooseRequest,
  OriginResponse: p.OriginResponse,
  GameTimelineResponse: p.GameTimelineResponse,
  SurroundingsResponse: p.SurroundingsResponse,
  PlaceView: p.PlaceView,
  TravelResponse: p.TravelResponse,
  CompanionsResponse: p.CompanionsResponse,
  CompanionView: p.CompanionView,
  BondView: p.BondView,
  SaveCompanionRequest: p.SaveCompanionRequest,
  InventoryResponse: p.InventoryResponse,
  InventoryEntry: p.InventoryEntry,
  GameLogResponse: p.GameLogResponse,
  GameRevealPlayer: p.GameRevealPlayer,
  GameRatingRequest: p.GameRatingRequest,
  GameRatingResponse: p.GameRatingResponse,
  RoomClientMessage: p.RoomClientMessage,
  RoomHello: p.RoomHello,
  RoomAction: p.RoomAction,
  RoomWhisper: p.RoomWhisper,
  RoomRetry: p.RoomRetry,
  RoomMove: p.RoomMove,
  RoomOmen: p.RoomOmen,
  RoomServerMessage: p.RoomServerMessage,
  RoomState: p.RoomState,
  RoomEntryMessage: p.RoomEntryMessage,
  RoomEntry: p.RoomEntry,
  RollView: p.RollView,
  HitView: p.HitView,
  TurnChange: p.TurnChange,
  PlaceActionView: p.PlaceActionView,
  AstralView: p.AstralView,
  RoomReady: p.RoomReady,
  RoomActionAccepted: p.RoomActionAccepted,
  RoomActionRejected: p.RoomActionRejected,
  RoomWhisperAccepted: p.RoomWhisperAccepted,
  RoomWhisperRejected: p.RoomWhisperRejected,
  RoomMoveAccepted: p.RoomMoveAccepted,
  RoomMoveRejected: p.RoomMoveRejected,
  RoomError: p.RoomError,
  RoomOmenAccepted: p.RoomOmenAccepted,
  RoomOmenRejected: p.RoomOmenRejected,
  GmConsoleResponse: p.GmConsoleResponse,
  GmTurnEditRequest: p.GmTurnEditRequest,
  GmPendingTurn: p.GmPendingTurn,
  GmApproveResponse: p.GmApproveResponse,
  GmAdjustRequest: p.GmAdjustRequest,
  GmAdjustResponse: p.GmAdjustResponse,
  GmInsertEventRequest: p.GmInsertEventRequest,
  GmInsertEventResponse: p.GmInsertEventResponse,
  GmLogResponse: p.GmLogResponse,
  AdminSessionRequest: p.AdminSessionRequest,
  AdminSessionResponse: p.AdminSessionResponse,
  AiUsageOverviewResponse: p.AiUsageOverviewResponse,
  AiUsageGameResponse: p.AiUsageGameResponse,
  LearningLibraryResponse: p.LearningLibraryResponse,
  PlayerStyleRequest: p.PlayerStyleRequest,
  PlayerStyleResponse: p.PlayerStyleResponse,
} as const;
export type ContractSchemaName = keyof typeof CONTRACT_SCHEMAS;

/** Who gets the payload: `player` (a player's own session), `gm` (the Human GM only), `admin` (the server owner), `any` (anyone). */
export type Audience = 'player' | 'gm' | 'admin' | 'any';
export type ContractStatus = 'ready' | 'pending';

interface ItemBase {
  audience: Audience;
  status: ContractStatus;
  /** Ready: the task that built it. Pending: the task that will (`new` = no task yet). */
  owner: string;
  screens: readonly ScreenId[];
  note?: string;
}

export interface HttpItem extends ItemBase {
  kind: 'http';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** As Fastify registers it (`:param`). */
  path: string;
  request: ContractSchemaName | null;
  /** null = 204, no body. Non-2xx answers are always `ApiError`. */
  response: ContractSchemaName | null;
}

export interface SocketItem extends ItemBase {
  kind: 'socket';
  direction: 'client' | 'server';
  /** The message's `type`. */
  type: string;
  schema: ContractSchemaName;
}

export type ContractItem = HttpItem | SocketItem;

const http = (
  method: HttpItem['method'],
  path: string,
  request: ContractSchemaName | null,
  response: ContractSchemaName | null,
  rest: ItemBase,
): HttpItem => ({ kind: 'http', method, path, request, response, ...rest });
const socket = (direction: SocketItem['direction'], type: string, schema: ContractSchemaName, rest: ItemBase): SocketItem => ({
  kind: 'socket',
  direction,
  type,
  schema,
  ...rest,
});
const ready = (owner: string, audience: Audience, screens: readonly ScreenId[], note?: string): ItemBase => ({
  status: 'ready',
  owner,
  audience,
  screens,
  ...(note ? { note } : {}),
});
const pending = (owner: string, audience: Audience, screens: readonly ScreenId[], note?: string): ItemBase => ({
  status: 'pending',
  owner,
  audience,
  screens,
  ...(note ? { note } : {}),
});

const PLAY_ROOM: readonly ScreenId[] = ['play-top-bar', 'play-self', 'play-action', 'play-lock'];

export const CONTRACT: readonly ContractItem[] = [
  // --- before the game ---
  http('GET', '/health', null, 'HealthResponse', ready('GEN-023', 'any', ['home'], 'ต่อไม่ได้ = "ติดต่อ server ไม่ได้"')),
  http('GET', '/api/me', null, 'MeResponse', ready('GEN-024', 'any', ['home', 'join'])),
  http('POST', '/api/join', 'JoinRequest', 'JoinResponse', ready('GEN-024', 'any', ['join'])),
  http('POST', '/api/logout', null, null, ready('GEN-024', 'any', ['home'])),
  http('POST', '/api/games', 'CreateGameRequest', 'CreateGameResponse', ready('GEN-025', 'any', ['create-game'])),
  http('POST', '/api/memory/sources', 'MemorySourcesRequest', 'MemorySourcesResponse', pending('GEN-083', 'any', ['create-game'], 'เกมต้นทางที่ผ่านเกณฑ์ของ toggle ความทรงจำ; รหัสผู้เล่นอยู่ใน body เท่านั้น ไม่ใส่ใน URL / header (Q-276)')),
  http('GET', '/api/game', null, 'GameView', ready('GEN-025', 'player', ['lobby', 'play-top-bar'])),
  http('PATCH', '/api/game', 'UpdateGameRequest', 'GameView', ready('GEN-025', 'player', ['lobby'], 'เจ้าของเท่านั้น ก่อนเริ่ม')),
  http('POST', '/api/game/invite-code', null, 'GameView', ready('GEN-025', 'player', ['lobby'], 'เจ้าของเท่านั้น')),
  http('DELETE', '/api/game/members/:memberId', null, 'GameView', ready('GEN-025', 'player', ['lobby'], 'เจ้าของเตะ')),
  http('DELETE', '/api/game', null, null, ready('GEN-112', 'player', ['lobby'], 'เจ้าของเท่านั้น (คนอื่น 403); body {confirmName} ต้องตรงชื่อเกม; ปุ่ม "ออกจากเกม" ไม่ลบเกม')),
  http('POST', '/api/game/start', null, 'GameView', ready('GEN-025 + GEN-065', 'player', ['lobby'], 'สุ่มจุดเกิดตอนเริ่ม')),
  http('GET', '/api/game/scenario', null, 'GameScenarioResponse', ready('GEN-046', 'gm', ['scenario-editor'])),
  http('PUT', '/api/game/scenario', 'Scenario', 'GameScenarioResponse', ready('GEN-046', 'gm', ['scenario-editor'])),
  http('POST', '/api/game/scenario/reset', null, 'GameScenarioResponse', ready('GEN-046', 'gm', ['scenario-editor'])),
  http('GET', '/api/game/character', null, 'CharacterResponse', ready('GEN-047 + GEN-067', 'player', ['character', 'play-self'])),
  http('POST', '/api/game/character', 'CharacterRequest', 'CharacterResponse', ready('GEN-047', 'player', ['character'])),
  http('PUT', '/api/game/character', 'CharacterRequest', 'CharacterResponse', ready('GEN-047', 'player', ['character'])),
  http('GET', '/api/game/character/loot', null, 'LootResponse', ready('GEN-048 + GEN-073', 'player', ['character'])),
  http('POST', '/api/game/character/loot', null, 'LootResponse', ready('GEN-048 + GEN-073', 'player', ['character'], 'วิเคราะห์ / สุ่มใหม่ (AI)')),
  http('POST', '/api/game/character/loot/choose', 'LootChooseRequest', 'LootResponse', ready('GEN-048 + GEN-073', 'player', ['character'])),
  http('GET', '/api/game/origin', null, 'OriginResponse', ready('GEN-065', 'player', ['origin-card', 'play-self', 'ending'])),

  // --- play ---
  http('GET', '/api/game/timeline', null, 'GameTimelineResponse', ready('GEN-053', 'player', ['play-feed', 'gm-console'])),
  http('GET', '/api/game/surroundings', null, 'SurroundingsResponse', ready('GEN-050 + GEN-067', 'player', ['play-place', 'play-self', 'gm-console'])),
  http('GET', '/api/game/travel', null, 'TravelResponse', ready('GEN-105', 'player', ['play-place'], 'แผ่นเดินทาง: โซน + ปลายทาง + ป้าย (กฎเดียวกับ move ของ GEN-066)')),
  http('GET', '/api/game/companions', null, 'CompanionsResponse', ready('GEN-054', 'player', ['play-companions'])),
  http('POST', '/api/game/companions', 'SaveCompanionRequest', 'CompanionsResponse', ready('GEN-054', 'player', ['play-companions', 'play-place'])),
  http('DELETE', '/api/game/companions/:ref', null, 'CompanionsResponse', ready('GEN-054', 'player', ['play-companions'])),
  http('GET', '/api/game/inventory', null, 'InventoryResponse', ready('GEN-055', 'player', ['play-inventory'])),
  http('GET', '/api/game/log', null, 'GameLogResponse', ready('GEN-037 + GEN-059', 'player', ['home', 'play-top-bar', 'play-changes', 'ending'], '[ประวัติ] + รายการเกม; `reveal` หลังจบเท่านั้น; entries รวม kind `changes` (GEN-114)')),

  socket('client', 'hello', 'RoomHello', ready('GEN-056', 'player', PLAY_ROOM, 'ข้อความแรก มี token + afterSeq')),
  socket('client', 'action', 'RoomAction', ready('GEN-056 + GEN-063', 'player', ['play-action'])),
  socket('client', 'whisper', 'RoomWhisper', ready('GEN-067', 'player', ['play-private'])),
  socket('client', 'retry', 'RoomRetry', ready('GEN-057', 'player', ['play-lock'])),
  socket('client', 'move', 'RoomMove', ready('GEN-066', 'player', ['play-place'])),
  socket('client', 'omen', 'RoomOmen', ready('GEN-070', 'player', ['play-astral'], 'ลางสังหรณ์ ≤ 200 ตัว ถึงผู้เล่น 1 คน วันละครั้งใน NOCTHERION (Q-193)')),
  socket('server', 'room', 'RoomState', ready('GEN-056', 'player', [...PLAY_ROOM, 'play-place', 'play-private', 'play-astral', 'gm-console'])),
  socket('server', 'entry', 'RoomEntryMessage', ready('GEN-056', 'player', ['play-feed', 'play-private', 'play-hit', 'play-changes', 'play-astral'], 'entry kind `changes` (GEN-114): RoomEntry.changes = ค่า HP / Stamina / เหรียญ / คำกรรม / ของ / สถานะ ที่เปลี่ยนในเทิร์น พร้อมเหตุผล จากตัวเลขของ server; ส่งเฉพาะเจ้าของ + GM คน; ย้อนดูได้ใน GET /api/game/log')),
  socket('server', 'ready', 'RoomReady', ready('GEN-056', 'player', ['play-feed'], 'replay ครบแล้ว')),
  socket('server', 'action_accepted', 'RoomActionAccepted', ready('GEN-056', 'player', ['play-action'])),
  socket('server', 'action_rejected', 'RoomActionRejected', ready('GEN-056', 'player', ['play-action'])),
  socket('server', 'whisper_accepted', 'RoomWhisperAccepted', ready('GEN-067', 'player', ['play-private'])),
  socket('server', 'whisper_rejected', 'RoomWhisperRejected', ready('GEN-067', 'player', ['play-private'])),
  socket('server', 'move_accepted', 'RoomMoveAccepted', ready('GEN-066', 'player', ['play-place'])),
  socket('server', 'move_rejected', 'RoomMoveRejected', ready('GEN-066', 'player', ['play-place'])),
  socket('server', 'error', 'RoomError', ready('GEN-056', 'player', ['play-lock'])),
  socket('server', 'omen_accepted', 'RoomOmenAccepted', ready('GEN-070', 'player', ['play-astral'])),
  socket('server', 'omen_rejected', 'RoomOmenRejected', ready('GEN-070', 'player', ['play-astral'])),

  // --- Human GM ---
  http('GET', '/api/game/gm/console', null, 'GmConsoleResponse', ready('GEN-058', 'gm', ['gm-console'])),
  http('POST', '/api/game/gm/turn/edit', 'GmTurnEditRequest', 'GmPendingTurn', ready('GEN-058', 'gm', ['gm-console'])),
  http('POST', '/api/game/gm/turn/approve', null, 'GmApproveResponse', ready('GEN-058', 'gm', ['gm-console'])),
  http('POST', '/api/game/gm/adjust', 'GmAdjustRequest', 'GmAdjustResponse', ready('GEN-058', 'gm', ['gm-console'])),
  http('POST', '/api/game/gm/events', 'GmInsertEventRequest', 'GmInsertEventResponse', ready('GEN-058', 'gm', ['gm-console'])),
  http('GET', '/api/game/gm/log', null, 'GmLogResponse', ready('GEN-058', 'gm', ['gm-console'])),

  // --- after the end ---
  http('GET', '/api/game/rating', null, 'GameRatingResponse', ready('GEN-078', 'player', ['ending-rating'], 'หลังเกมจบเท่านั้น (ก่อนจบ 409); ไม่ใช่สมาชิก 403; `eligible` / `blocker` เป็นของ GEN-079')),
  http('PUT', '/api/game/rating', 'GameRatingRequest', 'GameRatingResponse', ready('GEN-078', 'player', ['ending-rating'], 'คนละ 1 คะแนน ส่งใหม่ = แทนค่าเดิม')),
  http('PUT', '/api/game/rating/likes/:sourceRef', null, 'GameRatingResponse', ready('GEN-078', 'player', ['ending-rating'], '👍 action → ผล ด้วย `sourceRef` (ADR GEN-077); ref ที่หน้าสรุปไม่เปิด = 404 `ruling_not_found`')),
  http('DELETE', '/api/game/rating/likes/:sourceRef', null, 'GameRatingResponse', ready('GEN-078', 'player', ['ending-rating'], 'ยกเลิก 👍')),

  // --- server owner ---
  http('POST', '/api/admin/session', 'AdminSessionRequest', 'AdminSessionResponse', ready('GEN-061', 'any', ['ai-usage', 'learning-library'])),
  http('POST', '/api/admin/logout', null, null, ready('GEN-061', 'admin', ['ai-usage', 'learning-library'])),
  http('GET', '/api/admin/ai-usage', null, 'AiUsageOverviewResponse', ready('GEN-061', 'admin', ['ai-usage'])),
  http('GET', '/api/admin/ai-usage/:gameId', null, 'AiUsageGameResponse', ready('GEN-061', 'admin', ['ai-usage'])),
  http('GET', '/api/admin/learning', null, 'LearningLibraryResponse', pending('GEN-084', 'admin', ['learning-library'], 'ชนิด entry ตาม ADR ของ GEN-077')),
  http('DELETE', '/api/admin/learning/:id', null, 'LearningLibraryResponse', pending('GEN-084', 'admin', ['learning-library'])),
  http('DELETE', '/api/admin/learning/games/:gameId', null, 'LearningLibraryResponse', pending('GEN-084', 'admin', ['learning-library'])),

  // --- player style (player code, Q-167) ---
  http('POST', '/api/style', 'PlayerStyleRequest', 'PlayerStyleResponse', pending('GEN-082', 'any', ['my-style'])),
  http('PUT', '/api/style/opt-out', 'PlayerStyleRequest', 'PlayerStyleResponse', pending('GEN-082', 'any', ['my-style', 'join'])),
  http('POST', '/api/style/delete', 'PlayerStyleRequest', 'PlayerStyleResponse', pending('GEN-082', 'any', ['my-style'])),
];

/**
 * Fields the screens need inside a schema the server already sends (or parses). The server does not fill
 * them yet; the web must handle them absent until the owner sends them. `value`: an enum value instead of
 * a field. Each has a sample in the schema's fixtures (C4).
 */
export interface PendingField {
  schema: ContractSchemaName;
  /** Dotted path; `[]` steps into arrays. */
  path: string;
  value?: string;
  owner: string;
  screens: readonly ScreenId[];
  note: string;
}

export const PENDING_FIELDS: readonly PendingField[] = [
  { schema: 'RoomState', path: 'you.placeActions', owner: 'GEN-069', screens: ['play-action'], note: 'ชิป action ของสถานที่' },
  { schema: 'RoomAction', path: 'placeAction', owner: 'GEN-069', screens: ['play-action'], note: 'ใช้ชิปของสถานที่เป็น action ของเทิร์น' },
  { schema: 'GameView', path: 'memory', owner: 'GEN-083', screens: ['lobby'], note: 'Lobby บอกสถานะความทรงจำ' },
  { schema: 'GameMemorySetting', path: 'enabled', owner: 'GEN-083', screens: ['create-game'], note: 'จะเป็น `CreateGameRequest.memory`' },
  { schema: 'JoinStyleFields', path: 'playerCode', owner: 'GEN-082', screens: ['join'], note: 'จะเป็น `JoinRequest.playerCode` + `noStyle`' },
];
