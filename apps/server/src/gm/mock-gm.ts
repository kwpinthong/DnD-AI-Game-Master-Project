import type { AiCallRequest } from '../ai/provider.ts';
import type { DayContext, JournalContext, NarrationContext, TurnContext } from './context.ts';
import { templateFinale, type FinaleContext } from './finale.ts';
import { GM_OUTPUT, type GmAction, type GmJournal, type GmNarration, type GmTurnProposal } from './schema.ts';

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

/**
 * GEN-070 dev markers (no roll): `[mock:harm=<player ref>]` a lethal hit on that player, `[mock:execute=<player ref>]`
 * an EXECUTE on that player (out cold). The ref is the `{{p:ref}}` of the context (the presence ref).
 */
const TARGET_MARKER = /\[mock:(harm|execute)=([A-Za-z0-9_-]+)\]/;
const NO_PLAYER_EFFECTS = { damage: null, heal: null, takeItem: null, giveItem: null };

/** A plain general action at DC 11 for one action of the context. */
export function mockAction(ctx: TurnContext, actionId: string): GmAction {
  const action = ctx.actions.find((a) => a.actionId === actionId)!;
  const known = (tag: string | undefined) => (tag !== undefined && ctx.tagVocabulary.includes(tag) ? tag : undefined);
  const topic = known(INVESTIGATE_MARKER.exec(action.text)?.[1]);
  const verb = topic !== undefined ? known('INVESTIGATE') : (known(VERB_MARKER.exec(action.text)?.[1]) ?? ctx.tagVocabulary[0]);
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
    intentSummary: `{{p:${action.actor}}} ${action.text}`.slice(0, 200),
    reason: 'Mock GM',
  };
}

/** GEN-059 dev marker: `[mock:ending=good|evil|neutral]` in an action while the finale is active sets the ending path. */
const ENDING_MARKER = /\[mock:ending=(good|evil|neutral)\]/;

export function mockTurnProposal(ctx: TurnContext): GmTurnProposal {
  const finaleActive = ctx.events.active.some((e) => e.kind === 'finale');
  const marked = ctx.actions.map((a) => ENDING_MARKER.exec(a.text)?.[1]).find((p) => p !== undefined) as GmTurnProposal['endingPath'] | undefined;
  return {
    actions: ctx.order.map((id) => mockAction(ctx, id)),
    constraints: { add: [], release: [] },
    eventOutcomes: [],
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

export function mockNarration(ctx: NarrationContext): GmNarration {
  return {
    segments: ctx.beats.map((b) => ({
      actionId: b.actionId,
      text: [b.actor === null ? 'มีบางอย่างเกิดขึ้น' : `{{p:${b.actor}}}`, b.text, RESULT_WORD[b.result] ?? ''].filter((s) => s.length > 0).join(' ').slice(0, 800),
    })),
  };
}

export function mockDaySummary(ctx: DayContext): { recap: string; saga: string } {
  const recap = `วันที่ ${ctx.day}: ${ctx.log.join(' / ') || 'ไม่มีเหตุการณ์สำคัญ'}`.slice(0, 1800);
  const saga = [ctx.saga, recap].filter((s): s is string => s !== null).join('\n').slice(-4500);
  return { recap, saga };
}

export function mockJournal(ctx: JournalContext): GmJournal {
  const journal = `วันที่ ${ctx.day}: ${ctx.seen.join(' / ') || 'ไม่มีเรื่องที่ได้เห็น'}`.slice(0, 750);
  const saga = [ctx.saga, journal].filter((s): s is string => s !== null).join('\n').slice(-1800);
  return { journal, saga };
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
    case GM_OUTPUT.daySummary:
      return mockDaySummary(contextOf<DayContext>(req));
    case GM_OUTPUT.journal:
      return mockJournal(contextOf<JournalContext>(req));
    case GM_OUTPUT.finale:
      return templateFinale(contextOf<FinaleContext>(req));
    default:
      return undefined;
  }
}
