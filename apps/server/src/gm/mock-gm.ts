import type { AiCallRequest } from '../ai/provider.ts';
import type { DayContext, DialogueContext, JournalContext, NarrationContext, TurnContext } from './context.ts';
import { templateFinale, type FinaleContext } from './finale.ts';
import type { SceneContext } from './scene.ts';
import { GM_OUTPUT, type GmAction, type GmJournal, type GmNarration, type GmNpcLine, type GmTurnProposal } from './schema.ts';

/**
 * The Mock GM (AI_PROVIDER=mock without a script, plugged into the Mock provider by `ai/registry.ts`; tests
 * patch its answers): a valid answer built
 * from the request's own context, so a game runs offline end to end (GEN-057). Dev-only markers in an
 * action's text: `[mock:repair]` makes the first turn answer leave the last action out (forces a repair),
 * `[mock:slow]` makes narration wait 3 s (time to stop the server mid-resolve), `[mock:badnarration]` makes
 * every narration with that beat fail its checks (the server template is used, Q-151), `[mock:harm=ref]` /
 * `[mock:execute=ref]` aim the action at a player (GEN-070, see `TARGET_MARKER`).
 */

export const MOCK_REPAIR_MARKER = '[mock:repair]';
export const MOCK_SLOW_MARKER = '[mock:slow]';
export const MOCK_BAD_NARRATION_MARKER = '[mock:badnarration]';

/** The request's context: the first user message is always the context JSON. */
export function contextOf<T>(req: AiCallRequest): T {
  return JSON.parse(req.messages[0]!.text) as T;
}

const NO_EFFECTS = { repDelta: 0, karmaDelta: 0, affinity: [], damage: null, selfDamage: null, heal: null, addStatus: [], removeStatus: [] };

/** GEN-055 dev markers: `[mock:verb=PRAY]` sets the verb tag; `[mock:investigate=MIRACLE]` an INVESTIGATE on that topic (no roll). */
const VERB_MARKER = /\[mock:verb=([A-Z0-9_]+)\]/;
const INVESTIGATE_MARKER = /\[mock:investigate=([A-Z0-9_]+)\]/;
/** GEN-093 dev marker: `[mock:strategy=D10-S1:leader]` names the action's Day-10 plan and role (the server checks it). */
const STRATEGY_MARKER = /\[mock:strategy=([A-Z0-9-]+):(leader|support)\]/;

/**
 * GEN-095 dev marker: `[mock:curse]` casts the actor's Active CURSE source (Venom of Despair) on another player at
 * the same place (pvp), `[mock:curse=npc]` on an NPC there (DC 11). Without such a source or target: a plain action.
 */
const CURSE_MARKER = /\[mock:curse(=npc)?\]/;

function mockCurse(ctx: TurnContext, action: TurnContext['actions'][number]): Partial<GmAction> | null {
  const marker = CURSE_MARKER.exec(action.text);
  if (marker === null) return null;
  const me = ctx.players.find((p) => p.ref === action.actor);
  const source = me?.tagSources.find((s) => s.trigger !== 'passive' && s.verbTags.includes('CURSE'));
  if (!me || !source) return null;
  const base = { kind: 'complex' as const, staminaCost: 5, modifiers: [{ source: 'stat' as const }] };
  const activate = [{ ref: source.id, stamina: source.kind === 'skill' ? 4 : null }];
  if (marker[1] === '=npc') {
    const npc = ctx.npcs.find((n) => (n.placeFor?.[me.ref] ?? n.place) === me.place);
    return npc ? { ...base, check: { type: 'dc', dc: 11 }, targetNpc: npc.id, tagging: { verbTags: ['CURSE'], targetTags: ['NPC'], activate } } : null;
  }
  const other = ctx.players.find((p) => p.ref !== me.ref && p.place === me.place);
  if (!other) return null;
  const none = { damage: null, heal: null, takeItem: null, giveItem: null };
  return {
    ...base,
    check: { type: 'pvp' },
    targetPlayer: { player: other.ref, intent: 'harm', defenseRef: null, perceptionRef: null, onSuccess: none, onFail: none },
    tagging: { verbTags: ['CURSE'], targetTags: ['PLAYER'], activate },
  };
}

/**
 * GEN-070 dev markers (no roll): `[mock:harm=<player ref>]` a lethal hit on that player, `[mock:execute=<player ref>]`
 * an EXECUTE on that player (out cold). The ref is the `{{p:ref}}` of the context (the presence ref).
 */
const TARGET_MARKER = /\[mock:(harm|execute)=([A-Za-z0-9_-]+)\]/;
const NO_PLAYER_EFFECTS = { damage: null, heal: null, takeItem: null, giveItem: null };

/** A plain general action at DC 11 for one action of the context. */
export function mockAction(ctx: TurnContext, actionId: string): GmAction {
  const action = ctx.actions.find((a) => a.actionId === actionId)!;
  const curse = mockCurse(ctx, action);
  const known = (tag: string | undefined) => (tag !== undefined && ctx.tagVocabulary.includes(tag) ? tag : undefined);
  const topic = known(INVESTIGATE_MARKER.exec(action.text)?.[1]);
  const verb = topic !== undefined ? known('INVESTIGATE') : (known(VERB_MARKER.exec(action.text)?.[1]) ?? ctx.tagVocabulary[0]);
  const strategy = STRATEGY_MARKER.exec(action.text) ?? undefined;
  const aimed = TARGET_MARKER.exec(action.text);
  const targetPlayer: GmAction['targetPlayer'] = aimed
    ? {
        player: aimed[2]!,
        intent: aimed[1] as 'harm' | 'execute',
        defenseRef: null,
        perceptionRef: null,
        onSuccess: aimed[1] === 'harm' ? { ...NO_PLAYER_EFFECTS, damage: 'lethal' } : NO_PLAYER_EFFECTS,
        onFail: NO_PLAYER_EFFECTS,
      }
    : null;
  const marked = {
    ...(topic !== undefined ? { investigate: true, check: { type: 'none' as const }, targetTags: [topic] } : {}),
    ...(aimed ? { check: { type: 'none' as const } } : {}),
  };
  return {
    actionId,
    actor: action.actor,
    kind: 'general',
    tags: [],
    opposed: false,
    staminaCost: 3,
    check: marked.check ?? { type: 'dc', dc: 11 },
    modifiers: [{ source: 'stat' }],
    targetNpc: null,
    targetPlayer,
    looksAt: [],
    introducedNpcs: [],
    witnessNpcIds: [],
    repDeltaIfCaught: 0,
    onSuccess: NO_EFFECTS,
    onFail: NO_EFFECTS,
    tagging: { verbTags: verb === undefined ? [] : [verb], targetTags: marked.targetTags ?? [], activate: [] },
    moveTo: null,
    awareness: 'normal',
    investigate: marked.investigate ?? false,
    skillFlags: [],
    grants: [],
    strategy: strategy === undefined ? null : { id: strategy[1]!, role: strategy[2] as 'leader' | 'support' },
    intentSummary: `{{p:${action.actor}}} ${action.text}`.slice(0, 200),
    reason: 'Mock GM',
    ...curse,
  };
}

/** GEN-059 dev marker: `[mock:ending=good|evil|neutral]` in an action while the finale is active sets the ending path. */
const ENDING_MARKER = /\[mock:ending=(good|evil|neutral)\]/;

/** Q-243 dev marker: `[mock:outcome=good|evil|neutral]` in an action sets the outcome of the first active event, with that side. */
const OUTCOME_MARKER = /\[mock:outcome=(good|evil|neutral)\]/;

export function mockTurnProposal(ctx: TurnContext): GmTurnProposal {
  const finaleActive = ctx.events.active.some((e) => e.kind === 'finale');
  const marked = ctx.actions.map((a) => ENDING_MARKER.exec(a.text)?.[1]).find((p) => p !== undefined) as GmTurnProposal['endingPath'] | undefined;
  const side = ctx.actions.map((a) => OUTCOME_MARKER.exec(a.text)?.[1]).find((s) => s !== undefined) as 'good' | 'evil' | 'neutral' | undefined;
  const event = ctx.events.active[0];
  return {
    actions: ctx.order.map((id) => mockAction(ctx, id)),
    constraints: { add: [], release: [] },
    eventOutcomes: side && event ? [{ eventId: event.id, outcome: 'ผู้เล่นเข้าแทรกแซงเหตุการณ์ (Mock GM)', side }] : [],
    endingPath: finaleActive && marked ? marked : null,
    remember: [],
  };
}

const RESULT_WORD: Record<string, string> = {
  crit: 'สำเร็จอย่างงดงาม',
  success: 'สำเร็จ',
  fail: 'พลาด',
  fumble: 'พลาดอย่างหนัก',
  no_target: 'แต่เป้าหมายไม่อยู่ตรงนั้นแล้ว',
  skipped: 'แต่ไม่ได้ลงมือเพราะหมดสติไปก่อน',
  scene: '',
};

/**
 * GEN-110: the Mock GM's NPC lines. A place narration: 2 dialogue lines of the NPC a beat aims at (else the first NPC),
 * then a reaction of each other NPC (up to 3, in order). A player narration: one private line when the reader's action is Secret.
 */
export function mockNpcLines(all: Pick<NarrationContext, 'audience' | 'npcs' | 'beats' | 'privateLines'> & Partial<Pick<NarrationContext, 'answers'>>): GmNpcLine[] {
  const ctx = { ...all, npcs: all.npcs.filter((n) => n.here) };
  // GEN-143: the NPC asked answers first.
  const answering = ctx.npcs.find((n) => n.id === all.answers?.[0]?.npcId);
  if ('player' in ctx.audience) {
    const first = answering ?? ctx.npcs[0];
    return first && ctx.privateLines ? [{ npcId: first.id, kind: 'dialogue', text: 'ข้าเห็นนะว่าเจ้าทำอะไรอยู่ ไว้คุยกันทีหลัง' }] : [];
  }
  const aimed = answering?.id ?? ctx.beats.find((b) => b.targetNpc !== null && ctx.npcs.some((n) => n.id === b.targetNpc))?.targetNpc;
  const main = ctx.npcs.find((n) => n.id === aimed) ?? ctx.npcs[0];
  if (!main || ctx.beats.every((b) => b.kind !== 'public_action')) return [];
  return [
    { npcId: main.id, kind: 'dialogue', text: 'อ้อ เจ้าหมายถึงเรื่องนั้นสินะ เข้ามานั่งก่อน' },
    { npcId: main.id, kind: 'dialogue', text: 'ข้าจะเล่าเท่าที่ข้ารู้ให้ฟัง' },
    ...ctx.npcs.filter((n) => n.id !== main.id).slice(0, 3).map((n): GmNpcLine => ({ npcId: n.id, kind: 'reaction', text: 'หันมามองอย่างสงสัยแล้วเงียบไป' })),
  ];
}

export function mockNarration(ctx: NarrationContext): GmNarration {
  return {
    segments: ctx.beats.map((b) => ({
      actionId: b.actionId,
      text: [b.actor === null ? 'มีบางอย่างเกิดขึ้น' : `{{p:${b.actor}}}`, b.text, RESULT_WORD[b.result] ?? ''].filter((s) => s.length > 0).join(' ').slice(0, 800),
    })),
  };
}

export function mockDaySummary(ctx: DayContext): { recap: string; saga: string; news: string[] } {
  const recap = `วันที่ ${ctx.day}: ${ctx.log.join(' / ') || 'ไม่มีเหตุการณ์สำคัญ'}`.slice(0, 1800);
  const saga = [ctx.saga, recap].filter((s): s is string => s !== null).join('\n').slice(-4500);
  // ISK-014: tomorrow's events by name, else one rumour.
  const starting = (ctx.news?.starting ?? []).slice(0, 3).map((e) => `ชาวเมืองลือกันว่า${e.title}จะเริ่มขึ้นในวันนี้`);
  return { recap, saga, news: starting.length > 0 ? starting : ['ข่าวลือแพร่ไปทั่วตลาดว่าเมื่อคืนมีเสียงแปลกๆ ดังมาจากทางป่าทิศตะวันออก'] };
}

/** ISK-098: the day's journal from what the player saw, and one new topic of it. */
export function mockJournal(ctx: JournalContext): GmJournal {
  const seen = ctx.days.find((d) => d.day === ctx.day)?.seen ?? [];
  const journal = `วันที่ ${ctx.day}: ${seen.join(' / ') || 'ไม่มีเรื่องที่ได้เห็น'}`.slice(0, 750);
  return { journal, topics: [{ topicId: 'new', title: `เรื่องของวันที่ ${ctx.day}`, summary: journal }] };
}

/** The Mock GM's answer for a GM request, or undefined when `req` is not one. */
export async function cannedGmAnswer(req: AiCallRequest): Promise<unknown> {
  switch (req.output.name) {
    case GM_OUTPUT.turn: {
      const ctx = contextOf<TurnContext>(req);
      const proposal = mockTurnProposal(ctx);
      const forceRepair = req.messages.length === 1 && ctx.actions.some((a) => a.text.includes(MOCK_REPAIR_MARKER));
      return forceRepair ? { ...proposal, actions: proposal.actions.slice(0, -1) } : proposal;
    }
    case GM_OUTPUT.narration: {
      const ctx = contextOf<NarrationContext>(req);
      if (ctx.beats.some((b) => b.text.includes(MOCK_SLOW_MARKER))) await new Promise((r) => setTimeout(r, 3_000));
      // Never passes the checks (an action id that is not a beat), so the server template is used (Q-151).
      if (ctx.beats.some((b) => b.text.includes(MOCK_BAD_NARRATION_MARKER))) return { segments: [{ actionId: 'mock-not-a-beat', text: 'เรื่องที่ไม่อยู่ใน beat' }] };
      return mockNarration(ctx);
    }
    case GM_OUTPUT.dialogue:
      return { npcLines: mockNpcLines(contextOf<DialogueContext>(req)) };
    case GM_OUTPUT.daySummary:
      return mockDaySummary(contextOf<DayContext>(req));
    case GM_OUTPUT.journal:
      return mockJournal(contextOf<JournalContext>(req));
    case GM_OUTPUT.finale:
      return templateFinale(contextOf<FinaleContext>(req));
    case GM_OUTPUT.scene: {
      // GEN-145: one sentence for the place, one per NPC group member.
      const ctx = contextOf<SceneContext>(req);
      const npc = (list: { id: string }[], what: string) => list.map((n) => `{{n:${n.id}}} ${what}`);
      const lines = [`ช่วงเวลาใหม่มาเยือน${ctx.place.name}`, ...npc(ctx.npcs.arrived, 'เพิ่งมาถึง'), ...npc(ctx.npcs.left, 'เพิ่งจากไป'), ...npc(ctx.npcs.lingering, 'ยังอยู่ต่อ')];
      return { text: lines.join(' ').slice(0, 600) };
    }
    default:
      return undefined;
  }
}
