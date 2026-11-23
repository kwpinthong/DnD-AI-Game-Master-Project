import type { AiPurpose } from '../ai/provider.ts';
import type { Beat, DayContext, DialogueContext, JournalContext, NarrationContext } from '../gm/context.ts';
import type { FinaleContext } from '../gm/finale.ts';
import { npcLineLimits } from '../gm/npc-lines.ts';
import type { SceneContext } from '../gm/scene.ts';
import type { NpcChatContext } from '../npc-chat/prompt.ts';

/**
 * GEN-167: the fixed Thai style eval set (Nok 2026-11-23). Each scene is the state + action of one AI call, written
 * as the context the game itself sends (the same types, so a change to a context shape breaks this file, not the
 * eval). Tokens only ({{p:ref}} / {{n:id}}), never a real name; NPC ids are the default scenario's.
 */

/** Every purpose whose answer is Thai prose a player reads. */
export const THAI_PURPOSES = ['narrate_place', 'narrate_player', 'npc_dialogue', 'summarize_journal', 'summarize_day', 'finale', 'npc_chat'] as const satisfies readonly AiPurpose[];
export type ThaiPurpose = (typeof THAI_PURPOSES)[number];

/** ISK-025: a chat with an NPC outside the turn; `chat` is the message JSON the game sends. */
export interface ChatSceneContext {
  kind: 'npc_chat';
  chat: NpcChatContext;
}

export type StyleSceneContext = SceneContext | NarrationContext | DialogueContext | JournalContext | DayContext | FinaleContext | ChatSceneContext;

export interface StyleScene {
  id: string;
  title: string;
  purpose: ThaiPurpose;
  /** The scenario NPCs the scene is about. */
  npcs: string[];
  context: StyleSceneContext;
}

const ALIAS: Record<string, string> = {
  beggar: 'เด็กขอทานตาบอดข้างหนึ่ง',
  amnesiac: 'หญิงสาวผู้พกนาฬิกาพกตาย',
  nun: 'แม่ชีผู้เหนื่อยล้าแห่งโบสถ์เก่า',
  guard: 'ทหารยามหน้าตาบึ้งตึง',
  'cloaked-man': 'ชายชุดคลุมมอมแมมในตรอกมืด',
  merchant: 'พ่อค้าเร่ผู้สวมแว่นหนา',
};
const GRADE: Record<string, string> = { beggar: 'F', amnesiac: 'F', nun: 'B', guard: 'B', 'cloaked-man': 'B', merchant: 'B' };

const PLACE: Record<'fountain' | 'temple' | 'market' | 'barracks', SceneContext['place']> = {
  fountain: { id: 'fountain', name: 'น้ำพุกลางเมือง', tags: ['public', 'town'] },
  temple: { id: 'temple', name: 'โบสถ์', tags: ['holy', 'town'] },
  market: { id: 'market', name: 'ย่านการค้า-ตลาดมืด', tags: ['trade', 'town'] },
  barracks: { id: 'barracks', name: 'ค่ายทหารป้องกันเมือง', tags: ['military', 'town'] },
};

const A = { ref: 'p_a', looks: '', title: 'นักเดินทางผมเปีย', self: true, karmaBand: 0 };
const B = { ref: 'p_b', looks: 'ชายร่างสูงสวมเสื้อคลุมขาด', title: 'ชายแปลกหน้าถือหอก', self: false, karmaBand: -1 };

/** An NPC of a narration: here = may speak; persona = a short personality, tokens only. */
const npc = (id: string, persona: string | null, affinity = 0, met = false, here = true): NarrationContext['npcs'][number] => ({
  id,
  alias: ALIAS[id]!,
  grade: GRADE[id]!,
  here,
  lingering: false,
  persona,
  bonds: [{ player: 'p_a', affinity, met }],
});

const beat = (actionId: string, text: string, result: string, extra: Partial<Beat> = {}): Beat => ({
  actionId,
  kind: 'own_action',
  actor: 'p_a',
  text,
  result,
  target: null,
  targetNpc: null,
  moved: null,
  items: [],
  ...extra,
});

const narration = (n: Omit<NarrationContext, 'kind' | 'answers' | 'privateLines' | 'journal'> & Partial<Pick<NarrationContext, 'answers' | 'privateLines' | 'journal'>>): NarrationContext => ({
  kind: 'gm_narration',
  answers: [],
  privateLines: false,
  journal: null,
  ...n,
});

const dialogue = (n: Omit<DialogueContext, 'kind' | 'answers' | 'privateLines' | 'limits'> & Partial<Pick<DialogueContext, 'answers' | 'privateLines'>>): DialogueContext => ({
  kind: 'gm_dialogue',
  answers: [],
  privateLines: false,
  limits: npcLineLimits('normal'),
  ...n,
});

export const STYLE_SCENES: StyleScene[] = [
  {
    id: 'greeting',
    title: 'ทักทายเด็กขอทานที่น้ำพุ',
    purpose: 'npc_dialogue',
    npcs: ['beggar'],
    context: dialogue({
      audience: { place: 'fountain' },
      turn: { day: 1, phase: 'EOSORIA', turn: 1 },
      place: PLACE.fountain,
      cast: [A],
      npcs: [npc('beggar', 'เด็กกำพร้าช่างสังเกต พูดสุภาพแบบเด็ก ระแวงคนแปลกหน้าแต่ใจดี')],
      answers: [{ npcId: 'beggar', actionIds: ['a1'], via: 'target' }],
      beats: [beat('a1', '{{p:p_a}} ย่อตัวลงทักทาย {{n:beggar}} แล้วยื่นขนมปังให้ครึ่งก้อน', 'success', { targetNpc: 'beggar', kind: 'public_action' })],
      narration: ['{{p:p_a}} ย่อตัวลงข้างขอบน้ำพุ ยื่นขนมปังครึ่งก้อนให้ {{n:beggar}} ตาข้างที่ยังดีของเด็กเหลือบมองมืออย่างลังเล'],
    }),
  },
  {
    id: 'ask-way',
    title: 'ถามทางไปโบสถ์กับทหารยาม',
    purpose: 'narrate_player',
    npcs: ['guard'],
    context: narration({
      audience: { player: 'p_a' },
      turn: { day: 1, phase: 'SOLARION', turn: 1 },
      place: PLACE.barracks,
      cast: [A],
      npcs: [npc('guard', 'ทหารผ่านศึก พูดห้วน ไม่ชอบคนต่างถิ่น แต่ซื่อตรงต่อหน้าที่', -5)],
      answers: [{ npcId: 'guard', actionIds: ['a1'], via: 'target' }],
      privateLines: true,
      journal: { saga: null, yesterday: null },
      beats: [beat('a1', '{{p:p_a}} ถาม {{n:guard}} ว่าทางไปโบสถ์ไปทางไหน', 'success', { targetNpc: 'guard' })],
    }),
  },
  {
    id: 'threat',
    title: 'ข่มขู่ชายชุดคลุมในตรอก',
    purpose: 'npc_dialogue',
    npcs: ['cloaked-man'],
    context: dialogue({
      audience: { place: 'market' },
      turn: { day: 3, phase: 'NOCTHERION', turn: 1 },
      place: PLACE.market,
      cast: [A, B],
      npcs: [npc('cloaked-man', 'นักต้มตุ๋นปากจัด พูดภาษาตลาด หัวเราะเยาะแม้ตอนถูกขู่', -10, true)],
      answers: [{ npcId: 'cloaked-man', actionIds: ['a1'], via: 'target' }],
      beats: [
        beat('a1', '{{p:p_a}} กระชากคอเสื้อ {{n:cloaked-man}} แนบกำแพง ขู่ให้บอกว่าใครขโมยถุงเงิน', 'success', { targetNpc: 'cloaked-man', kind: 'public_action' }),
        beat('b1', '{{p:p_b}} ยืนขวางปากตรอกไว้', 'success', { actor: 'p_b', kind: 'public_action' }),
      ],
      narration: ['{{p:p_a}} กระชากคอเสื้อ {{n:cloaked-man}} จนหลังกระแทกกำแพงชื้น ปากตรอกมี {{p:p_b}} ยืนขวางไว้ ไม่มีทางหนี'],
    }),
  },
  {
    id: 'sad',
    title: 'ฉากเศร้า: แม่ชีกับจดหมายของคนที่จากไป',
    purpose: 'narrate_place',
    npcs: ['nun'],
    context: narration({
      audience: { place: 'temple' },
      turn: { day: 4, phase: 'HESPERION', turn: 2 },
      place: PLACE.temple,
      cast: [{ ...A, self: false }],
      npcs: [npc('nun', 'แม่ชีที่ดูแลเด็กกำพร้ามานาน เหนื่อยแต่ไม่เคยบ่น พูดนุ่มและช้า', 20, true)],
      answers: [{ npcId: 'nun', actionIds: ['a1'], via: 'target' }],
      beats: [beat('a1', '{{p:p_a}} ยื่นจดหมายที่พบในซากบ้านให้ {{n:nun}} จดหมายเป็นลายมือของเด็กที่หายไปเมื่อฤดูก่อน', 'success', { targetNpc: 'nun', kind: 'public_action', items: ['จดหมายเปื้อนเขม่า'] })],
    }),
  },
  {
    id: 'period-change',
    title: 'เปลี่ยนช่วงเวลา: ค่ำลงที่น้ำพุ',
    purpose: 'narrate_place',
    npcs: ['beggar', 'amnesiac'],
    context: {
      kind: 'gm_scene',
      turn: { day: 2, phase: 'NOCTHERION', turn: 1 },
      newDay: false,
      weather: 'ลมแรง',
      place: PLACE.fountain,
      npcs: { arrived: [{ id: 'amnesiac', alias: ALIAS.amnesiac! }], left: [{ id: 'beggar', alias: ALIAS.beggar! }], lingering: [] },
    },
  },
  {
    id: 'new-day-rain',
    title: 'วันใหม่ ฝนตกที่ตลาด',
    purpose: 'narrate_place',
    npcs: ['merchant'],
    context: {
      kind: 'gm_scene',
      turn: { day: 5, phase: 'EOSORIA', turn: 1 },
      newDay: true,
      weather: 'ฝนตก',
      place: PLACE.market,
      npcs: { arrived: [{ id: 'merchant', alias: ALIAS.merchant! }], left: [], lingering: [] },
    },
  },
  {
    id: 'many-npcs',
    title: 'คุยกับหลาย NPC พร้อมกันที่ตลาด',
    purpose: 'npc_dialogue',
    npcs: ['merchant', 'cloaked-man', 'guard'],
    context: dialogue({
      audience: { place: 'market' },
      turn: { day: 5, phase: 'SOLARION', turn: 2 },
      place: PLACE.market,
      cast: [A, B],
      npcs: [
        npc('merchant', 'พ่อค้าช่างเจรจา สุภาพแบบคนขายของ นับเหรียญตลอดเวลา', 10, true),
        npc('cloaked-man', 'นักต้มตุ๋นปากจัด พูดภาษาตลาด', 0, true),
        npc('guard', 'ทหารผ่านศึก พูดห้วน ซื่อตรงต่อหน้าที่', 0, true),
      ],
      answers: [
        { npcId: 'merchant', actionIds: ['a1'], via: 'target' },
        { npcId: 'guard', actionIds: ['b1'], via: 'target' },
      ],
      beats: [
        beat('a1', '{{p:p_a}} ถาม {{n:merchant}} ว่าเมื่อคืนเห็นใครแบกหีบออกจากตลาดไหม', 'success', { targetNpc: 'merchant', kind: 'public_action' }),
        beat('b1', '{{p:p_b}} เรียก {{n:guard}} มาดูรอยงัดที่ประตูโกดัง', 'success', { actor: 'p_b', targetNpc: 'guard', kind: 'public_action' }),
      ],
      narration: ['{{p:p_a}} เอนตัวพิงแผงของ {{n:merchant}} ถามถึงหีบที่หายไป ขณะที่ {{p:p_b}} กวักมือเรียก {{n:guard}} ไปดูรอยงัด {{n:cloaked-man}} ยืนฟังอยู่ห่างๆ'],
    }),
  },
  {
    id: 'haggle',
    title: 'ต่อราคากับพ่อค้า',
    purpose: 'narrate_player',
    npcs: ['merchant'],
    context: narration({
      audience: { player: 'p_a' },
      turn: { day: 6, phase: 'HESPERION', turn: 1 },
      place: PLACE.market,
      cast: [A],
      npcs: [npc('merchant', 'พ่อค้าช่างเจรจา สุภาพแบบคนขายของ นับเหรียญตลอดเวลา', 5, true)],
      answers: [{ npcId: 'merchant', actionIds: ['a1'], via: 'target' }],
      privateLines: true,
      journal: { saga: '{{p:p_a}} มาถึงเมืองพร้อมเงินติดตัวไม่มาก', yesterday: null },
      beats: [beat('a1', '{{p:p_a}} ต่อราคาตะเกียงน้ำมันจาก 12 เหลือ 8 เหรียญ', 'crit', { targetNpc: 'merchant', items: ['ตะเกียงน้ำมัน'] })],
    }),
  },
  {
    id: 'fail-sneak',
    title: 'ลอบผ่านทหารยามแต่พลาด',
    purpose: 'narrate_place',
    npcs: ['guard'],
    context: narration({
      audience: { place: 'barracks' },
      turn: { day: 7, phase: 'NOCTHERION', turn: 2 },
      place: PLACE.barracks,
      cast: [{ ...A, self: false }],
      npcs: [npc('guard', 'ทหารผ่านศึก พูดห้วน ไม่ชอบคนต่างถิ่น', -5, true)],
      beats: [beat('a1', '{{p:p_a}} พยายามย่องผ่านหลัง {{n:guard}} เข้าไปในคลังอาวุธ', 'fumble', { kind: 'public_action' })],
    }),
  },
  {
    id: 'comfort',
    title: 'ปลอบหญิงสาวที่จำอะไรไม่ได้',
    purpose: 'npc_dialogue',
    npcs: ['amnesiac'],
    context: dialogue({
      audience: { player: 'p_a' },
      turn: { day: 2, phase: 'NOCTHERION', turn: 2 },
      place: PLACE.fountain,
      cast: [A],
      npcs: [npc('amnesiac', 'หญิงสาวที่ความจำหาย พูดน้อย ประโยคสั้น มักหยุดกลางประโยค', 15, true)],
      answers: [{ npcId: 'amnesiac', actionIds: ['a1'], via: 'target' }],
      privateLines: true,
      beats: [beat('a1', '{{p:p_a}} นั่งลงข้าง {{n:amnesiac}} ถามเบาๆ ว่านาฬิกาพกเรือนนั้นเป็นของใคร', 'success', { targetNpc: 'amnesiac' })],
      narration: ['{{p:p_a}} นั่งลงข้าง {{n:amnesiac}} บนขอบน้ำพุที่เย็นเฉียบ เข็มของนาฬิกาพกในมือเธอยังหยุดนิ่งเหมือนทุกคืน'],
    }),
  },
  {
    id: 'journal',
    title: 'บันทึกประจำวันของผู้เล่น',
    purpose: 'summarize_journal',
    npcs: ['nun', 'beggar'],
    context: {
      kind: 'gm_journal',
      day: 4,
      player: 'p_a',
      saga: '{{p:p_a}} มาถึงเมืองเมื่อสามวันก่อน ได้รู้จัก {{n:beggar}} ที่น้ำพุ',
      seen: [
        'เช้านี้ {{n:beggar}} พาคุณไปดูซากบ้านที่ถูกไฟไหม้ท้ายย่านชุมชน',
        'คุณพบจดหมายเปื้อนเขม่าใต้แผ่นไม้',
        'ตอนเย็น {{n:nun}} รับจดหมายไปแล้วนิ่งไปนาน ก่อนจะขอบคุณคุณด้วยเสียงสั่น',
      ],
    },
  },
  {
    id: 'day-summary',
    title: 'สรุปเหตุการณ์ทั้งวันของเมือง',
    purpose: 'summarize_day',
    npcs: ['merchant', 'guard'],
    context: {
      kind: 'gm_day',
      day: 5,
      saga: 'เมืองเริ่มเห็นแสงประหลาดบนฟ้าทุกคืน ผู้คนกระซิบถึงลางร้าย',
      log: [
        'ฝนตกทั้งเช้า ตลาดเงียบกว่าปกติ',
        '{{p:p_a}} สืบเรื่องหีบที่หายจาก {{n:merchant}}',
        '{{p:p_b}} พา {{n:guard}} ไปดูรอยงัดที่ประตูโกดัง',
        'ตกค่ำมีคนเห็นเงาคนแบกหีบมุ่งหน้าไปทางป่า',
      ],
    },
  },
  {
    id: 'finale',
    title: 'ฉากจบของเกม',
    purpose: 'finale',
    npcs: ['nun', 'beggar'],
    context: {
      kind: 'gm_finale',
      reason: 'finale',
      path: 'good',
      events: [
        { id: 'd5-fire', day: 5, phase: 'NOCTHERION', kind: 'disaster', title: 'ไฟไหม้ย่านชุมชน', outcome: 'ดับได้ทันก่อนลามถึงโบสถ์', intervened: true, side: 'good' },
        { id: 'd12-meteor', day: 12, phase: 'NOCTHERION', kind: 'meteor', title: 'อุกกาบาตตก', outcome: 'ชาวเมืองส่วนใหญ่หลบในที่ปลอดภัยทัน', intervened: true, side: 'good' },
      ],
      players: [
        { ref: 'p_a', appearance: 'นักเดินทางผมเปีย', place: 'โบสถ์', karmaTier: 'ผู้มีเมตตา', karmaBand: 1, companions: ['{{n:beggar}}'], outcome: 'survived', protectedBy: [], inSafeZone: true },
        { ref: 'p_b', appearance: 'ชายร่างสูงสวมเสื้อคลุมขาด', place: 'ป่า', karmaTier: 'ธรรมดา', karmaBand: 0, companions: [], outcome: 'defeated', protectedBy: [], inSafeZone: false },
      ],
    },
  },
];
