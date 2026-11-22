import { EventOutcomeSide, EventOutcomeText, type PhasePoint } from '@isekai/protocol';
import { z } from 'zod';
import type { AiService, AiServiceResult } from '../ai/core/service.ts';
import type { GameAssets } from '../assets/load.ts';
import type { Db } from '../db/client.ts';
import { buildEventContext, eventContextBlock } from './context.ts';
import { advanceTimeline, type AdvanceResult } from './store.ts';

/**
 * The event part of the AI GM's answer: outcome changes for active events. GEN-057 nests it in the
 * PhaseProposal and applies it with `applyEventOutcomes` together with the rest (all-or-nothing, Q-049).
 */
export const EventOutcomeProposal = z.object({
  eventOutcomes: z
    .array(
      z.object({
        eventId: z.string().min(1).max(64),
        outcome: EventOutcomeText,
        /** Q-243: the side of the event's interventionEffects the players took; null = none of them. Never a prefix of `outcome`. */
        side: EventOutcomeSide.nullable(),
      }),
    )
    .max(3),
});
export type EventOutcomeProposal = z.infer<typeof EventOutcomeProposal>;

export interface PhaseEventsResult {
  timeline: AdvanceResult;
  ai: AiServiceResult<EventOutcomeProposal>;
}

/**
 * Minimal phase trigger (GEN-053): enters the phase on the timeline, then asks the AI GM through the
 * AI service with the event context in the prompt. It does not apply the answer; the full phase loop
 * is GEN-057, which replaces this call with its own `gm_adjudicate` carrying the same block.
 */
export async function startPhaseEvents(
  deps: { db: Db; ai: Pick<AiService, 'call'>; assets?: Pick<GameAssets, 'day10Strategies'> },
  gameId: string,
  point: PhasePoint,
): Promise<PhaseEventsResult> {
  const timeline = advanceTimeline(deps.db, gameId, point);
  const context = buildEventContext(deps.db, gameId, point.day, point.phase, deps.assets);
  const ai = await deps.ai.call({
    gameId,
    purpose: 'gm_adjudicate',
    day: point.day,
    phase: point.phase,
    system: [eventContextBlock(context)],
    messages: [{ role: 'user', text: 'ช่วงเวลาใหม่เริ่มแล้ว ตอบ eventOutcomes เฉพาะเหตุการณ์ active ที่ผลเปลี่ยน (ไม่มีให้ตอบรายการว่าง)' }],
    output: { name: 'event_outcomes', schema: EventOutcomeProposal },
    maxOutputTokens: 1000,
  });
  return { timeline, ai };
}
