import type { Phase, Scenario } from '@isekai/protocol';
import type { PromptBlock } from '../ai/provider.ts';
import type { DbOrTx } from '../db/client.ts';
import { getGameScenario } from '../scenario/store.ts';
import { getTimeline, inPlayOrder } from './store.ts';

/**
 * The timeline part of the AI GM context for one phase (GEN-053, ADR AI GM §6.1 "scenario: timeline
 * วันนี้"). Leak rules (GEN-043):
 * - only events active in this phase and outcomes of resolved ones; a pending event never appears,
 * - NPCs are `{{n:id}}` tokens and any real NPC name in the event text is replaced by its token (Q-045),
 * - no GM note.
 */
export interface ActiveEventContext {
  id: string;
  kind: 'event' | 'climax' | 'finale';
  title: string;
  description: string;
  /** ผลตั้งต้น if nobody steps in. */
  defaultOutcome: string;
  /** What the AI GM already set this phase, or null. */
  chosenOutcome: string | null;
  crisis: boolean;
  place: string | null;
  npcs: string[];
}

export interface PastEventContext {
  id: string;
  day: number;
  phase: Phase;
  title: string;
  outcome: string;
  intervened: boolean;
}

export interface EventContext {
  day: number;
  phase: Phase;
  active: ActiveEventContext[];
  past: PastEventContext[];
}

const npcToken = (id: string) => `{{n:${id}}}`;

function tokeniseNames(scenario: Scenario): (text: string) => string {
  // Longest name first so a name inside another name is not half-replaced.
  const npcs = [...scenario.npcs].filter((n) => n.name.length > 0).sort((a, b) => b.name.length - a.name.length);
  return (text) => npcs.reduce((out, n) => out.split(n.name).join(npcToken(n.id)), text);
}

export function buildEventContext(db: DbOrTx, gameId: string, day: number, phase: Phase): EventContext {
  const scenario = getGameScenario(db, gameId);
  const timeline = getTimeline(db, gameId);
  if (!scenario || !timeline) return { day, phase, active: [], past: [] };
  const clean = tokeniseNames(scenario);
  const state = new Map(timeline.events.map((e) => [e.id, e]));
  const places = new Map(scenario.locations.map((l) => [l.id, l.name]));
  const active: ActiveEventContext[] = [];
  const past: PastEventContext[] = [];

  for (const event of inPlayOrder(scenario.timeline)) {
    const s = state.get(event.id);
    if (s?.status === 'active' && event.day === day && event.phase === phase) {
      active.push({
        id: event.id,
        kind: event.kind,
        title: clean(event.title),
        description: clean(event.description),
        defaultOutcome: clean(event.outcome),
        chosenOutcome: s.outcome === null ? null : clean(s.outcome),
        crisis: event.crisis,
        place: event.locationId === null ? null : (places.get(event.locationId) ?? null),
        npcs: event.npcIds.map(npcToken),
      });
    } else if (s?.status === 'resolved') {
      past.push({
        id: event.id,
        day: event.day,
        phase: event.phase,
        title: clean(event.title),
        outcome: clean(s.outcome ?? ''),
        intervened: s.outcomeSource === 'ai',
      });
    }
  }
  return { day, phase, active, past };
}

/** The context as a prompt block (volatile, so not cached). */
export function eventContextBlock(context: EventContext): PromptBlock {
  const text = [
    `เหตุการณ์ตามเส้นเวลา วันที่ ${context.day} ช่วง ${context.phase}`,
    'active = เหตุการณ์ที่เกิดในช่วงนี้ (ผู้เล่นแทรกแซงได้ ถ้าเปลี่ยนผลให้ตอบใน eventOutcomes), past = ผลของเหตุการณ์ที่ผ่านมาแล้ว',
    JSON.stringify({ active: context.active, past: context.past }),
  ].join('\n');
  return { id: 'timeline', text, cache: false };
}
