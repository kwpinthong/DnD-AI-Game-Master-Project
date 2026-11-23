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
  { id: 'play-npc', title: '4.4 Play: บทพูด NPC + reaction (avatar + ชื่อ + เกรด)' },
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
  { id: 'game-data', title: '10. ข้อมูลเกม (ผู้ดูแล)' },
  { id: 'vote-review', title: '11. ข้อความที่ถูก 👎 + แก้เป็น (ผู้ดูแล)' },
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
  ResponseVoteRequest: p.ResponseVoteRequest,
  ResponseVoteResponse: p.ResponseVoteResponse,
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
  NpcLineView: p.NpcLineView,
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
  GameClosedEvent: p.GameClosedEvent,
  AdminGamesResponse: p.AdminGamesResponse,
  AdminGameRow: p.AdminGameRow,
  AdminCloseGameRequest: p.AdminCloseGameRequest,
  GmConsoleResponse: p.GmConsoleResponse,
  GmTurnEditRequest: p.GmTurnEditRequest,
  GmPendingTurn: p.GmPendingTurn,
  GmApproveResponse: p.GmApproveResponse,
  GmAdjustRequest: p.GmAdjustRequest,
  GmAdjustResponse: p.GmAdjustResponse,
  GmInsertEventRequest: p.GmInsertEventRequest,
  GmInsertEventResponse: p.GmInsertEventResponse,
  GmLogResponse: p.GmLogResponse,
  GmVotesResponse: p.GmVotesResponse,
  GmSettings: p.GmSettings,
  AdminSessionRequest: p.AdminSessionRequest,
  AdminSessionResponse: p.AdminSessionResponse,
  AiUsageOverviewResponse: p.AiUsageOverviewResponse,
  AiUsageGameResponse: p.AiUsageGameResponse,
  GameDataListResponse: p.GameDataListResponse,
  GameDataSetResponse: p.GameDataSetResponse,
  GameDataSaveRequest: p.GameDataSaveRequest,
  GameDataAuditResponse: p.GameDataAuditResponse,
  GameDataImportPreviewResponse: p.GameDataImportPreviewResponse,
  GameDataExportResponse: p.GameDataExportResponse,
  LearningLibraryResponse: p.LearningLibraryResponse,
  LearningExtractResponse: p.LearningExtractResponse,
  GameLearningResponse: p.GameLearningResponse,
  PlayerStyleRequest: p.PlayerStyleRequest,
  PlayerStyleResponse: p.PlayerStyleResponse,
  AdminDownvotesResponse: p.AdminDownvotesResponse,
  AdminCorrectionRequest: p.AdminCorrectionRequest,
  AdminCorrectionResponse: p.AdminCorrectionResponse,
  AdminCorrectionsExportResponse: p.AdminCorrectionsExportResponse,
  StyleFlagsResponse: p.StyleFlagsResponse,
  StyleSettingsRequest: p.StyleSettingsRequest,
  StyleSettingsResponse: p.StyleSettingsResponse,
  StyleEvalResponse: p.StyleEvalResponse,
  StyleEvalMarkRequest: p.StyleEvalMarkRequest,
  NpcLibraryResponse: p.NpcLibraryResponse,
  NpcExampleAddRequest: p.NpcExampleAddRequest,
  StyleReviewResponse: p.StyleReviewResponse,
  StyleProposalApproveRequest: p.StyleProposalApproveRequest,
  NpcChatRequest: p.NpcChatRequest,
  NpcChatStatus: p.NpcChatStatus,
  NpcChatResponse: p.NpcChatResponse,
  FeedbackInput: p.FeedbackInput,
  FeedbackRow: p.FeedbackRow,
  AdminFeedbackResponse: p.AdminFeedbackResponse,
  AdminFeedbackStatusRequest: p.AdminFeedbackStatusRequest,
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
  http('GET', '/api/me', null, 'MeResponse', ready('GEN-024', 'any', ['home', 'join'], 'ISK-021 (ทุก route ของผู้เล่น): session ต่ออายุเป็น 30 วันนับจาก request ล่าสุด (เขียน DB ≤ 1 ครั้ง / ชั่วโมง); ส่ง token ที่หมดอายุ / ไม่รู้จัก = 401 `session_expired`, ไม่ส่ง token = 401 `unauthorized`')),
  http('POST', '/api/join', 'JoinRequest', 'JoinResponse', ready('GEN-024', 'any', ['join'], 'GEN-082: body ยังรับ `JoinStyleFields` (`playerCode` ไม่บังคับ ≤ 64, `noStyle`) ได้ด้วย; server เก็บแค่ HMAC ของรหัส; ISK-021: ชื่อ + PIN เดิม = member เดิม (`created` false) ทุกช่วง: lobby, ตั้งตัวละคร, กำลังเล่น, จบ, ถูกปิด ไม่นับที่นั่งเพิ่ม')),
  http('POST', '/api/logout', null, null, ready('GEN-024', 'any', ['home'])),
  http('POST', '/api/games', 'CreateGameRequest', 'CreateGameResponse', ready('GEN-025', 'any', ['create-game'], 'GEN-083: `memory` (ไม่ส่ง = ปิด) เปิดต้องมี `playerCode` และเกมต้นทาง 1-3 เกมจาก /api/memory/sources ของรหัสนั้น ไม่ตรง = 400 `fields.memory`; GEN-201: `noStyle` (ไม่ส่ง = เก็บ) เหมือน /api/join')),
  http('POST', '/api/memory/sources', 'MemorySourcesRequest', 'MemorySourcesResponse', ready('GEN-083', 'any', ['create-game'], 'เกมที่จบแล้วที่รหัสนั้นเป็นสมาชิก (ไม่มีเกณฑ์คะแนน) ใหม่ก่อน; รหัสผู้เล่นอยู่ใน body เท่านั้น ไม่ใส่ใน URL / header (Q-276); รหัสที่ไม่เคยใช้ = 403 (ผิด 5 ครั้ง / 10 นาที ต่อ IP = 429)')),
  http('GET', '/api/game', null, 'GameView', ready('GEN-025', 'player', ['lobby', 'play-top-bar'], 'GEN-083: `memory` สถานะความทรงจำ (เปิด + ชื่อเกมต้นทาง); ISK-001: `closed` {reason, hasSummary} เมื่อผู้ดูแลปิดเกม (null = ยังไม่ปิด)')),
  http('PATCH', '/api/game', 'UpdateGameRequest', 'GameView', ready('GEN-025', 'player', ['lobby'], 'เจ้าของเท่านั้น ก่อนเริ่ม (หลังเริ่ม = 409 `game_started` รวมถึง `memory`); `memory` ตรวจกับรหัสผู้เล่นที่เจ้าของใช้ตอนสร้าง')),
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
  http('GET', '/api/game/npc-chat', null, 'NpcChatStatus', ready('GEN-149', 'player', ['play-npc'], 'โควตาคุยกับ NPC ของช่วงนี้ (ค่าเริ่ม 5 ต่อช่วงต่อผู้เล่น ปรับได้ที่แถว System_Rules หมวด `NPC Chat`); `left` 0 = ปุ่มส่งปิดจนถึงช่วงถัดไป')),
  http('POST', '/api/game/npc-chat', 'NpcChatRequest', 'NpcChatResponse', ready('GEN-149', 'player', ['play-npc'], 'คุยกับ NPC ที่อยู่ที่เดียวกันตอนนี้ ตอบทันที เทิร์นไม่เดิน; AI รุ่นเล็ก purpose `npc_chat`; มีผลแค่ความสัมพันธ์ + ความจำของ NPC (ขอของ / ขู่ / รับเควส = `suggestion` ให้ทำเป็น action); คนที่อยู่ที่เดียวกันเห็นเป็น entry `player` + `npc` (whisper = ผู้พูดคนเดียว + GM คน); NPC ไม่อยู่ = 404 `npc_not_found`; ครบโควตา / ล็อก = 409 `not_allowed`; AI ล้ม = 503 `ai_unavailable` ไม่เสียโควตา')),
  http('GET', '/api/game/log', null, 'GameLogResponse', ready('GEN-037 + GEN-059', 'player', ['home', 'play-top-bar', 'play-changes', 'ending'], '[ประวัติ] + รายการเกม; `reveal` หลังจบเท่านั้น; entries รวม kind `changes` (GEN-114); ISK-001: `endReason` `closed` + `closedEarly` / `closeReason` เมื่อผู้ดูแลปิดเกมที่เล่นอยู่; ปิดตอนห้องรอ / ตั้งตัวละคร = 404 `not_started`')),

  socket('client', 'hello', 'RoomHello', ready('GEN-056', 'player', PLAY_ROOM, 'ข้อความแรก มี token + afterSeq')),
  socket('client', 'action', 'RoomAction', ready('GEN-056 + GEN-063', 'player', ['play-action'])),
  socket('client', 'whisper', 'RoomWhisper', ready('GEN-067', 'player', ['play-private'])),
  socket('client', 'retry', 'RoomRetry', ready('GEN-057', 'player', ['play-lock'])),
  socket('client', 'move', 'RoomMove', ready('GEN-066', 'player', ['play-place'])),
  socket('client', 'omen', 'RoomOmen', ready('GEN-070', 'player', ['play-astral'], 'ลางสังหรณ์ ≤ 200 ตัว ถึงผู้เล่น 1 คน วันละครั้งใน NOCTHERION (Q-193)')),
  socket('server', 'room', 'RoomState', ready('GEN-056', 'player', [...PLAY_ROOM, 'play-place', 'play-private', 'play-astral', 'gm-console'])),
  socket('server', 'entry', 'RoomEntryMessage', ready('GEN-056', 'player', ['play-feed', 'play-private', 'play-hit', 'play-changes', 'play-npc', 'play-astral'], 'entry kind `changes` (GEN-114): RoomEntry.changes = ค่า HP / Stamina / เหรียญ / คำกรรม / ของ / สถานะ ที่เปลี่ยนในเทิร์น พร้อมเหตุผล จากตัวเลขของ server; ส่งเฉพาะเจ้าของ + GM คน; ย้อนดูได้ใน GET /api/game/log. entry kind `npc` (GEN-110): บทพูดของ NPC 1 บรรทัดต่อ entry (`text` ≤ 120 ตัวอักษร, ใส่ชื่อตามที่คนดูรู้แล้ว) + RoomEntry.npc {ref, name (alias จนกว่าจะรู้ชื่อจริง, Q-219), grade? (เมื่อรู้ชื่อแล้วเท่านั้น), kind dialogue|reaction, private?}; public = มี `place` ส่งให้ทุกคนที่อยู่ที่นั่น (action Secret ไม่ทำให้เกิด), `private: true` = พูดกับผู้เล่นคนนี้คนเดียว (`place` null); ต่อเทิร์น: dialogue ≤ 3 บรรทัดต่อ NPC, reaction ≤ 3 NPC NPC ละ 1 บรรทัด, private ≤ 2 บรรทัดต่อผู้เล่น, รวม ≤ 12; ลำดับ entry = ลำดับบรรยาย (narration / feed ก่อน แล้วตามด้วย npc ของมัน); ย้อนดูได้ใน GET /api/game/log. entry kind `player` (GEN-129): action Public ของผู้เล่นคนอื่นที่อยู่ที่เดียวกัน = `text` ตามที่พิมพ์ + `place` + RoomEntry.actor {name} (ฉายา Social Title จนกว่าจะรู้ชื่อ, GEN-117; GM คนเห็นชื่อจริง); ไม่ส่ง action Secret และไม่ส่งให้เจ้าของ action เอง (ของตัวเองเป็นกล่องขวา); ไม่มีปุ่มโหวต; ย้อนดูได้ใน GET /api/game/log. entry kind `time` (GEN-145): ประกาศเปลี่ยนช่วงเวลาจาก server (template `time_announce` ของ GEN-150 ใส่ชื่อช่วง + ชั่วโมง และ "วันที่ N" เมื่อขึ้นวันใหม่) 1 entry ต่อห้อง ใต้เทิร์น 1 ของช่วงใหม่ `place` null ส่งทุกคน ไม่มี AI ไม่มีปุ่มโหวต; ตามด้วย feed บรรยายฉาก 2-3 ประโยคต่อสถานที่ที่มีผู้เล่น (AI, ก่อนผลของเทิร์น 1; AI ล้ม = มีแค่ประกาศ)')),
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
  socket('server', 'game_closed', 'GameClosedEvent', ready('ISK-001', 'player', ['lobby', 'play-lock', 'ending'], 'ผู้ดูแลปิดเกม: ส่งถึงทุก socket ที่ต่ออยู่ตอนปิด และหลัง `ready` ของคนที่เข้ามาใหม่; `hasSummary` false = ปิดตอนห้องรอ / ตั้งตัวละคร (ส่งตอน hello แล้วปิด socket code 4010, ไม่มีหน้าสรุป); หลังปิดทุกคำสั่งได้ `error` code `game_closed` ไม่มีอะไรเปลี่ยน; ไม่มี karma / DC')),

  // --- Human GM ---
  http('GET', '/api/game/gm/console', null, 'GmConsoleResponse', ready('GEN-058 + GEN-105 + GEN-104', 'gm', ['gm-console'], 'pending.checks (ทุกการทอยของเทิร์น: DC / modifiers+label / d20 / total / outcome; ไม่มีทอย = []) และ npcs (NPC ที่ติดคำสาป + turnsLeft) พร้อมแล้ว เห็นเฉพาะ GM')),
  http('POST', '/api/game/gm/turn/edit', 'GmTurnEditRequest', 'GmPendingTurn', ready('GEN-058', 'gm', ['gm-console'])),
  http('POST', '/api/game/gm/turn/approve', null, 'GmApproveResponse', ready('GEN-058', 'gm', ['gm-console'])),
  http('POST', '/api/game/gm/adjust', 'GmAdjustRequest', 'GmAdjustResponse', ready('GEN-058', 'gm', ['gm-console'])),
  http('POST', '/api/game/gm/events', 'GmInsertEventRequest', 'GmInsertEventResponse', ready('GEN-058', 'gm', ['gm-console'])),
  http('GET', '/api/game/gm/log', null, 'GmLogResponse', ready('GEN-058', 'gm', ['gm-console'])),
  http('PUT', '/api/game/gm/settings', 'GmSettings', 'GmSettings', ready('GEN-198', 'gm', ['gm-console'], 'สวิตช์ "อนุมัติบทพูดอัตโนมัติ" ต่อเกม (ค่าเริ่มปิด, อ่านค่าได้ที่ `GmConsoleResponse.autoApproveLines`): เปิดแล้วบทพูด NPC ของเทิร์นออกทันทีไม่เข้า console ผลเทิร์นยังรอ GM อนุมัติตามเดิม; ผู้เล่น 403')),
  http('GET', '/api/game/gm/votes', null, 'GmVotesResponse', ready('GEN-126', 'gm', ['gm-console', 'learning-library'], 'ถูกใจ / ไม่ถูกใจ ต่อข้อความ AI ที่มีคนโหวต (นับเฉพาะผู้เล่นตอนนี้); `good` (Q-286) = 👍 > ครึ่งของผู้เล่นทั้งหมด (ไม่โหวต = 👎, เสมอไม่ผ่าน); `avoid` (Q-287) = 👎 จริง > ครึ่งของผู้เล่นทั้งหมด (ไม่โหวตไม่นับ); ผู้เล่น 403 (เห็นแค่ `RoomEntry.myVote` ของตัวเอง)')),

  // --- rate the AI GM while playing (GEN-107) ---
  http('PUT', '/api/game/entries/:seq/vote', 'ResponseVoteRequest', 'ResponseVoteResponse', ready('GEN-107', 'player', ['play-action'], '👍/👎 ข้อความของ AI GM (`RoomEntry.myVote` ≠ undefined = มีปุ่ม); `vote: null` = ยกเลิก; ไม่ใช่ผู้เล่น / ไม่ใช่ผู้รับ entry 403; id ไม่มี/ไม่ใช่ข้อความ AI = 404 `response_not_found`; ใช้ได้หลังเกมจบ')),

  // --- after the end ---
  http('GET', '/api/game/rating', null, 'GameRatingResponse', ready('GEN-078', 'player', ['ending-rating'], 'หลังเกมจบเท่านั้น (ก่อนจบ 409); ไม่ใช่สมาชิก 403; `average` แสดงเฉยๆ ไม่เป็นเกณฑ์ (GEN-079)')),
  http('PUT', '/api/game/rating', 'GameRatingRequest', 'GameRatingResponse', ready('GEN-078', 'player', ['ending-rating'], 'คนละ 1 คะแนน ส่งใหม่ = แทนค่าเดิม')),
  http('GET', '/api/game/learning', null, 'GameLearningResponse', ready('GEN-084', 'player', ['ending'], 'Q-363: สถานะสกัดความรู้ของเกมนี้ เจ้าของเกมเท่านั้น (คนอื่น 403); ก่อนจบ 409')),
  http('POST', '/api/game/learning/extract', null, 'GameLearningResponse', ready('GEN-084', 'player', ['ending'], 'Q-363: เจ้าของเกมลองสกัดใหม่จากหน้าจบเกม (ครั้งเดียวต่อเกม สำเร็จแล้ว = `done` ไม่ call); คนอื่น 403; ก่อนจบ 409; Q-364: server สกัดเองเมื่อจบเกินกำหนด (LEARNING_AUTO_EXTRACT_HOURS ค่าเริ่ม 24)')),
  http('PUT', '/api/game/rating/votes/:sourceRef', 'ResponseVoteRequest', 'GameRatingResponse', ready('GEN-171', 'player', ['ending-rating'], '👍/👎 action → ผล ด้วย `sourceRef` (ADR GEN-077) แบบ GEN-107, `vote: null` = ยกเลิก; เก็บใน response_vote เป็น `ruling-${sourceRef}` (Q-325); เห็นแค่ `myVotes` ของตัวเอง ไม่มียอดรวม; GM คน / ไม่ใช่สมาชิก 403; ก่อนจบ 409; ref ที่หน้าสรุปไม่เปิด = 404 `ruling_not_found`')),

  // --- server owner ---
  http('POST', '/api/admin/session', 'AdminSessionRequest', 'AdminSessionResponse', ready('GEN-061', 'any', ['ai-usage', 'learning-library', 'game-data', 'vote-review'])),
  http('POST', '/api/admin/logout', null, null, ready('GEN-061', 'admin', ['ai-usage', 'learning-library', 'game-data', 'vote-review'])),
  http('GET', '/api/admin/game-data', null, 'GameDataListResponse', ready('GEN-147', 'admin', ['game-data'])),
  http('GET', '/api/admin/game-data/:name', null, 'GameDataSetResponse', ready('GEN-147', 'admin', ['game-data'], 'ไม่มีชุดนี้ = 404 `data_set_not_found`')),
  http('PUT', '/api/admin/game-data/:name', 'GameDataSaveRequest', 'GameDataSetResponse', ready('GEN-147', 'admin', ['game-data'], 'ตรวจด้วย schema เดียวกับ loader; ผิด = 400 `invalid_input` + `fields` ค่าเดิมไม่เปลี่ยน; backup ก่อนแก้ + audit 1 แถว; มีผลกับเกมใหม่และเทิร์นถัดไป')),
  http('POST', '/api/admin/game-data/:name/undo', null, 'GameDataSetResponse', ready('GEN-147', 'admin', ['game-data'], 'ย้อนการแก้ล่าสุดที่ยังไม่ถูกย้อน; ไม่มี = 409 `not_allowed`')),
  http('GET', '/api/admin/game-data/:name/asset-file', null, 'GameDataImportPreviewResponse', ready('GEN-173', 'admin', ['game-data'], 'อ่านไฟล์ asset ของชุดนี้ตอนนี้ + diff กับ DB ไม่บันทึกอะไร; ยืนยันด้วย PUT เดิม (backup + audit + undo); ไฟล์ผิด schema = 400 `invalid_input` + `fields`; ไม่มีชุด/ไฟล์ = 404 `data_set_not_found`')),
  http('GET', '/api/admin/game-data-audit', null, 'GameDataAuditResponse', ready('GEN-147', 'admin', ['game-data'])),
  http('GET', '/api/admin/game-data-export', null, 'GameDataExportResponse', ready('GEN-147', 'admin', ['game-data'], 'ชื่อไฟล์ → JSON ที่ loader เดิมโหลดกลับได้')),
  http('GET', '/api/admin/games', null, 'AdminGamesResponse', ready('ISK-001', 'admin', ['ai-usage'], 'หน้าจอเป็นของ ISK-002; ทุกเกม ไม่แบ่งหน้า เรียง `lastActionAt` ล่าสุดก่อน (ไม่มี = เวลาสร้าง); `phase` lobby / setup (เริ่มแล้วแต่ยังไม่มีใครเข้าห้องเล่น) / playing / ended + `endedReason` finale | game_over | closed; ไม่มี admin token = 401')),
  http('POST', '/api/admin/games/:id/close', 'AdminCloseGameRequest', 'AdminGameRow', ready('ISK-001', 'admin', ['ai-usage'],'`confirmName` ต้องตรงชื่อเกม (trim + NFC) ไม่ตรง = 400 `confirm_required`; `reason` trim ≤ 200 ตัว (ว่าง = ไม่มี) เกิน = 400 `reason_too_long`; จบแล้ว / ปิดแล้ว = 409 `already_ended`; ไม่มีเกม = 404 `game_not_found`; ไม่มี admin token = 401. เกมที่เล่นอยู่ = จบแบบ closed ไม่เรียก AI ฉากจบ หน้าสรุปเหมือนจบปกติ (GameLogResponse.game.closedEarly + closeReason) learning เหมือนจบปกติ; ห้องรอ / ตั้งตัวละคร = ไม่มีหน้าสรุป (GET /api/game/log 404 `not_started`); audit 1 แถวใน `game_close`; หลังปิด HTTP ที่เปลี่ยนเกม (ยกเว้นให้คะแนน / โหวต / ลบเกม) = 409 `game_closed`')),
  http('GET', '/api/admin/ai-usage', null, 'AiUsageOverviewResponse', ready('GEN-061', 'admin', ['ai-usage'])),
  http('GET', '/api/admin/ai-usage/:gameId', null, 'AiUsageGameResponse', ready('GEN-061', 'admin', ['ai-usage'])),
  http('GET', '/api/admin/learning', null, 'LearningLibraryResponse', ready('GEN-084', 'admin', ['learning-library'], '5 ชนิด (lore, feedback_note, good_example, avoid, style) + ชื่อเกมต้นทาง + วันที่; good/avoid มี 👍 / 👎 / ผู้เล่น; ไม่มี entry ที่ลบแล้ว; style ไม่มี playerKey')),
  http('DELETE', '/api/admin/learning/:id', null, 'LearningLibraryResponse', ready('GEN-084', 'admin', ['learning-library'], 'ลบแบบ tombstone: ไม่ถูกใช้ใน prompt อีก และสร้างใหม่ไม่กลับมา; ไม่มี / ลบแล้ว = 404 `response_not_found`')),
  http('DELETE', '/api/admin/learning/games/:gameId', null, 'LearningLibraryResponse', ready('GEN-084', 'admin', ['learning-library'], 'ลบทุก entry ของเกมต้นทางนั้น (tombstone); ไม่มี entry = 404 `game_not_found`')),
  http('POST', '/api/admin/learning/games/:gameId/extract', null, 'LearningExtractResponse', ready('GEN-080', 'admin', ['learning-library'], 'สกัด lore + feedback_note จากหน้าสรุปตอนจบ (ไม่มีเกณฑ์คะแนน) AI 1 call purpose `learning_extract`; ครั้งเดียวต่อเกม (ซ้ำ = `done` ไม่ call); AI ล้ม = `failed` "สกัดไม่สำเร็จ" ไม่มี entry เรียกซ้ำได้; เกมยังไม่จบ = 409 `not_allowed`; ไม่มีเกม = 404 `game_not_found`; เรียกเองอัตโนมัติเมื่อสมาชิกให้คะแนนครบ')),

  // --- GEN-168: review of 👎 messages (server owner) ---
  http('GET', '/api/admin/downvotes', null, 'AdminDownvotesResponse', ready('GEN-168', 'admin', ['vote-review'], 'ข้อความ AI ที่มี 👎 ทุกเกม พร้อม NPC / เหตุผล (นับ) / คู่ "แก้เป็น" ที่บันทึกไว้')),
  http('POST', '/api/admin/corrections', 'AdminCorrectionRequest', 'AdminCorrectionResponse', ready('GEN-168', 'admin', ['vote-review'], 'เก็บคู่ข้อความเดิม → ฉบับแก้ (+ NPC, ฉาก, เหตุผล) แบบเพิ่มอย่างเดียว + log 1 บรรทัด; ข้อความในเกมไม่เปลี่ยน; `toLibrary` = แค่ติดธงผู้สมัครคลังตัวอย่าง NPC (คลังเป็นของ GEN-151); ไม่มีข้อความ = 404 `response_not_found`')),
  http('GET', '/api/admin/corrections-export', null, 'AdminCorrectionsExportResponse', ready('GEN-168', 'admin', ['vote-review'], 'JSONL ทุกคู่ ชื่อจริงของผู้เล่นแทนด้วย `{{PLAYER_n}}`')),
  http('GET', '/api/admin/vote-snapshots-export', null, 'AdminCorrectionsExportResponse', ready('GEN-189', 'admin', ['vote-review'], 'JSONL โหวต 👍/👎 ของเกมที่ถูกลบ (เก็บไว้ก่อนลบ) ต่อข้อความ AI: `{ npc, scene, text, up, down, players, verdict }` ชื่อผู้เล่นแทนด้วย `{{PLAYER_n}}`')),
  // --- GEN-169: the server's style checker (server owner) ---
  http('GET', '/api/admin/style-flags', null, 'StyleFlagsResponse', ready('GEN-169', 'admin', ['vote-review'], 'จำนวนธงตรวจสำนวนต่อ NPC (id + alias ไม่ใช่ชื่อจริง) ต่อเหตุผล ไม่มีข้อความ; `npc: null` = บรรยาย')),
  http('GET', '/api/admin/style-settings', null, 'StyleSettingsResponse', ready('GEN-169', 'admin', ['vote-review'])),
  http('PUT', '/api/admin/style-settings', 'StyleSettingsRequest', 'StyleSettingsResponse', ready('GEN-169', 'admin', ['vote-review'], '`rewrite` = กฎ block ให้ AI เขียนใหม่ 1 ครั้ง (ค่าเริ่ม false = แค่ติดธง); GEN-177 `defaultTone` = โทนของเกมใหม่ที่ไม่ได้เลือก (บันทึกลง `tone` ของชุดข้อมูล Voice มี backup / audit / undo)')),
  // --- GEN-167: the Thai style eval set (`pnpm eval:style` writes the rounds; server owner) ---
  http('GET', '/api/admin/style-eval', null, 'StyleEvalResponse', ready('GEN-167', 'admin', ['vote-review'], 'รอบล่าสุด + รอบก่อน เทียบทีละฉาก (ข้อความที่ AI เขียน, เวอร์ชัน Voice, model, USD, ธง `real_name` / กฎสำนวน) + คะแนนที่ Nok ให้; prompt เก็บใน server ไม่ส่งมา; ยังไม่มีรอบ = `current: null`')),
  http('PUT', '/api/admin/style-eval/:runId/marks/:sceneId', 'StyleEvalMarkRequest', 'StyleEvalResponse', ready('GEN-167', 'admin', ['vote-review'], 'ดีขึ้น / เท่าเดิม / แย่ลง ของฉากนั้นในรอบนั้นเทียบรอบก่อน (null = ล้าง) บันทึกทันที; ไม่มีรอบ/ฉาก = 404 `response_not_found`; รอบแรก (ไม่มีรอบก่อน) = 409 `not_allowed`')),

  // --- GEN-151: NPC example library (server owner, on the Learning library page, Q-322) ---
  http('GET', '/api/admin/npc-library', null, 'NpcLibraryResponse', ready('GEN-151', 'admin', ['learning-library'], 'ตัวอย่างต่อ NPC (token เท่านั้น) + ข้อความที่ได้ 👍 + คู่ "แก้เป็น" ที่ติดธงแต่ยังไม่มี NPC')),
  http('POST', '/api/admin/npc-library', 'NpcExampleAddRequest', 'NpcLibraryResponse', ready('GEN-151', 'admin', ['learning-library'], 'เพิ่มตัวอย่างจากข้อความที่ได้ 👍 (+ NPC + ชนิดฉาก) หรือจากคู่ "แก้เป็น" (ใช้ฉบับแก้); ชื่อจริงแทนด้วย token ก่อนเก็บ; ซ้ำ = ไม่เพิ่ม; ไม่มีข้อความ / ไม่มี 👍 / NPC ไม่รู้จัก = 404 `response_not_found`; dialogue prompt ใส่ ≤ 3 ต่อ NPC')),
  http('DELETE', '/api/admin/npc-library/:id', null, 'NpcLibraryResponse', ready('GEN-151', 'admin', ['learning-library'], 'ลบตัวอย่าง มีผลกับ prompt ถัดไป; ไม่มี = 404 `response_not_found`')),

  // --- GEN-178: style review round (server owner; its own admin tab, listed with the 👎 review screen) ---
  http('GET', '/api/admin/style-review', null, 'StyleReviewResponse', ready('GEN-178', 'admin', ['vote-review'], 'สัญญาณที่รอ (👎 ตามชิป + flag ตาม rule id + ตาม NPC) / รอบ / ข้อเสนอ / เวอร์ชัน Voice / บทพูด NPC ที่ voteVerdict good ยังไม่อยู่ในคลัง')),
  http('POST', '/api/admin/style-review/run', null, 'StyleReviewResponse', ready('GEN-178', 'admin', ['vote-review'], '"รันตอนนี้": เริ่มรอบเบื้องหลังแล้วตอบทันที (`running`); สัญญาณใหม่ < 20 = `skipped` ไม่เรียก AI; AI 1 call purpose `style_review`; AI ล้ม = `failed` สัญญาณรอรอบหน้า')),
  http('POST', '/api/admin/style-review/proposals/:id/approve', 'StyleProposalApproveRequest', 'StyleReviewResponse', ready('GEN-178', 'admin', ['vote-review'], 'อนุมัติ (หรือแก้ `content` แล้วอนุมัติ) = Voice เวอร์ชันใหม่ บันทึกแบบ game data (backup / audit); ไม่มี = 404 `response_not_found`; ตัดสินแล้ว = 409 `not_allowed`; ไม่ผ่าน schema = 400 `invalid_input`')),
  http('POST', '/api/admin/style-review/proposals/:id/reject', null, 'StyleReviewResponse', ready('GEN-178', 'admin', ['vote-review'], 'ไม่อนุมัติ: Voice ไม่เปลี่ยน; ไม่มี = 404 / ตัดสินแล้ว = 409')),
  http('POST', '/api/admin/style-review/voice/:version/restore', null, 'StyleReviewResponse', ready('GEN-178', 'admin', ['vote-review'], 'ย้อน Voice เป็นเวอร์ชันนั้น (บันทึกเป็น edit ใหม่ เวอร์ชันใหม่กว่ายังอยู่ในประวัติ); ไม่มี = 404 `response_not_found`')),

  // --- player style (player code, Q-167) ---
  http('POST', '/api/style', 'PlayerStyleRequest', 'PlayerStyleResponse', ready('GEN-082', 'any', ['my-style'], 'สไตล์ของรหัสนั้น: top 3 verb + โทนสั้น จากเกมที่จบแล้ว (ไม่มีเกณฑ์คะแนน) หรือ `style: null`; รหัสอยู่ใน body เท่านั้น เก็บแค่ HMAC; รหัสที่ไม่เคยใช้ = 403 (ผิด 5 ครั้ง / 10 นาที ต่อ IP = 429); มี session ของสมาชิกที่รหัสไม่ตรง = 403')),
  http('PUT', '/api/style/opt-out', 'PlayerStyleRequest', 'PlayerStyleResponse', ready('GEN-082', 'any', ['my-style', 'join'], '"ไม่ให้เก็บสไตล์ฉัน" ของรหัสนั้นทุกเกม (`optOut` จำเป็น); เกมที่จบหลังจากนี้ไม่สร้างสไตล์ใหม่ และ AI ไม่ได้สไตล์นี้')),
  http('POST', '/api/style/delete', 'PlayerStyleRequest', 'PlayerStyleResponse', ready('GEN-082', 'any', ['my-style'], 'ลบสไตล์ทั้งหมดของรหัสนั้น (ลบจริง ไม่มี undo) แล้วตอบ `style: null`')),

  // --- ISK-010: Report & Feedback (screens of ISK-011 come later: listed on the nearest existing ones) ---
  http('POST', '/api/feedback', 'FeedbackInput', 'FeedbackRow', ready('ISK-010', 'player', ['lobby', 'play-action', 'ending'], '201; ทุกสมาชิกที่มี session (ไม่มี = 401); เกม / สมาชิกจาก session; day / period / turn จาก state ของเกม (ยังไม่มีเทิร์น = null) ไม่เชื่อ body; 400 `text_required` / `text_too_long` (> 1000 code point) / `invalid_type` / `invalid_page`; userAgent ตัดที่ 300; 5 ครั้ง / 10 นาที / สมาชิก (นับจากตาราง) = 429 `rate_limited`; ไม่ส่งถึงผู้เล่นอื่น ไม่ log ข้อความ')),
  http('GET', '/api/admin/feedback', null, 'AdminFeedbackResponse', ready('ISK-010', 'admin', ['learning-library'], 'ล่าสุด 200 แถว ใหม่ก่อน ไม่แบ่งหน้า; `?status=` / `?type=` กรอง (ค่านอกรายการ = 400 `invalid_status` / `invalid_type`); ไม่มี token = 401, token ที่ไม่ใช่ admin = 403; `text` แสดงแบบ escape')),
  http('PATCH', '/api/admin/feedback/:id', 'AdminFeedbackStatusRequest', 'FeedbackRow', ready('ISK-010', 'admin', ['learning-library'], 'เปลี่ยนสถานะ + updatedAt + audit 1 แถว (from / to / เวลา); สถานะนอกรายการ = 400 `invalid_status`; ไม่มี id = 404 `feedback_not_found`; ไม่มีการลบ')),
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
];
