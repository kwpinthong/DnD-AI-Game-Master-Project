import type { AiCallRequest } from '../ai/provider.ts';
import type { DayContext, NarrationContext, TurnContext } from './context.ts';
import { GM_OUTPUT, type GmAction, type GmNarration, type GmTurnProposal } from './schema.ts';

/**
 * The Mock GM (AI_PROVIDER=mock without a script, plugged into the Mock provider by `ai/registry.ts`; tests
 * patch its answers): a valid answer built
 * from the request's own context, so a game runs offline end to end (GEN-057). Dev-only markers in an
 * action's text: `[mock:repair]` makes the first turn answer leave the last action out (forces a repair),
 * `[mock:slow]` makes narration wait 3 s (time to stop the server mid-resolve).
 */

export const MOCK_REPAIR_MARKER = '[mock:repair]';
export const MOCK_SLOW_MARKER = '[mock:slow]';

/** The request's context: the first user message is always the context JSON. */
export function contextOf<T>(req: AiCallRequest): T {
  return JSON.parse(req.messages[0]!.text) as T;
}

const NO_EFFECTS = { repDelta: 0, karmaDelta: 0, affinity: [], damage: null, selfDamage: null, heal: null, addStatus: [], removeStatus: [] };

/** A plain general action at DC 11 for one action of the context. */
export function mockAction(ctx: TurnContext, actionId: string): GmAction {
  const action = ctx.actions.find((a) => a.actionId === actionId)!;
  const verb = ctx.tagVocabulary[0];
  return {
    actionId,
    actor: action.actor,
    kind: 'general',
    tags: [],
    opposed: false,
    staminaCost: 3,
    check: { type: 'dc', dc: 11 },
    modifiers: [{ source: 'stat' }],
    targetNpc: null,
    targetPlayer: null,
    witnessNpcIds: [],
    repDeltaIfCaught: 0,
    onSuccess: NO_EFFECTS,
    onFail: NO_EFFECTS,
    tagging: { verbTags: verb === undefined ? [] : [verb], targetTags: [], activate: [] },
    moveTo: null,
    awareness: 'normal',
    investigate: false,
    intentSummary: `{{p:${action.actor}}} ${action.text}`.slice(0, 200),
    reason: 'Mock GM',
  };
}

export function mockTurnProposal(ctx: TurnContext): GmTurnProposal {
  return { actions: ctx.order.map((id) => mockAction(ctx, id)), constraints: { add: [], release: [] }, eventOutcomes: [], remember: [] };
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
      return mockNarration(ctx);
    }
    case GM_OUTPUT.daySummary:
      return mockDaySummary(contextOf<DayContext>(req));
    default:
      return undefined;
  }
}
