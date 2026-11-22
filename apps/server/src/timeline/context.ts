import type { EventOutcomeSide, Phase, Scenario } from '@isekai/protocol';
import type { PromptBlock } from '../ai/provider.ts';
import type { GameAssets } from '../assets/load.ts';
import type { DbOrTx } from '../db/client.ts';
import { getGameScenario } from '../scenario/store.ts';
import { getTimeline, inPlayOrder, isDuring } from './store.ts';

/**
 * The timeline part of the AI GM context for one period (GEN-053, ADR AI GM §6.1 "scenario: timeline
 * วันนี้"). Leak rules (GEN-043):
 * - only events active in this period and outcomes of resolved ones; a pending event never appears,
 *   except as its foreshadowing text on its Foreshadowing_Trigger morning (GEN-071),
 * - NPCs are `{{n:id}}` tokens and any real NPC name in the event text is replaced by its token (Q-045),
 * - no GM note.
 */
export interface ActiveEventContext {
  id: string;
  kind: 'event' | 'climax' | 'finale';
  title: string;
  description: string;
  /** What stepping in can change (Player_Intervention_Effects). */
  interventionEffects: string;
  /** ผลตั้งต้น if nobody steps in (World_Drift_If_Ignored). */
  defaultOutcome: string;
  /** What the AI GM already set this period, or null. */
  chosenOutcome: string | null;
  crisis: boolean;
  /** Names of the event's places (GEN-097); null = the whole town. */
  places: string[] | null;
  npcs: string[];
  /** The Day10_Strategies rows the event names that exist in the assets; none = the drift outcome stands (C7). */
  strategies: StrategyContext[];
}

/** One Day10_Strategies row the players may run against the event (GEN-072), as the AI reads it. */
export interface StrategyContext {
  id: string;
  name: string;
  karmaCondition: string;
  requiredSkills: string;
  requiredItems: string;
  requiredNpcs: string;
  location: string;
  actions: string;
  dc: string;
  successEffect: string;
  failureEffect: string;
}

export interface PastEventContext {
  id: string;
  day: number;
  phase: Phase;
  title: string;
  outcome: string;
  intervened: boolean;
  /** Q-243: the side of the outcome the players brought about; null = none. */
  side: EventOutcomeSide | null;
}

/** A hint of a coming event for the narration (Foreshadowing at its Foreshadowing_Trigger). */
export interface ForeshadowContext {
  eventId: string;
  text: string;
}

export interface EventContext {
  day: number;
  phase: Phase;
  active: ActiveEventContext[];
  past: PastEventContext[];
  foreshadowing: ForeshadowContext[];
}

const npcToken = (id: string) => `{{n:${id}}}`;

function tokeniseNames(scenario: Scenario): (text: string) => string {
  // Longest name first so a name inside another name is not half-replaced.
  const names = scenario.npcs
    .flatMap((n) => [n.name, ...n.otherNames].map((name) => ({ name, id: n.id })))
    .filter((n) => n.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  return (text) => names.reduce((out, n) => out.split(n.name).join(npcToken(n.id)), text);
}

/**
 * Foreshadowing due at day + period: events whose Foreshadowing_Trigger is that point (GEN-071 C2).
 * GEN-057 can put this in its own context; `buildEventContext` already includes it.
 */
export function foreshadowingFor(scenario: Scenario, day: number, phase: Phase): ForeshadowContext[] {
  const clean = tokeniseNames(scenario);
  return inPlayOrder(scenario.timeline)
    .filter((e) => e.foreshadowAt?.day === day && e.foreshadowAt.phase === phase && e.foreshadowing.length > 0)
    .map((e) => ({ eventId: e.id, text: clean(e.foreshadowing) }));
}

function strategiesOf(event: Scenario['timeline'][number], assets: Pick<GameAssets, 'day10Strategies'> | undefined): StrategyContext[] {
  const rows = assets?.day10Strategies ?? [];
  return event.strategyIds.flatMap((id) => {
    const s = rows.find((r) => r.id === id);
    if (!s) return [];
    return [
      {
        id: s.id,
        name: s.name,
        karmaCondition: s.karmaCondition,
        requiredSkills: s.requiredSkills,
        requiredItems: s.requiredItems,
        requiredNpcs: s.requiredNpcs,
        location: s.location,
        actions: s.night10Actions,
        dc: s.dc,
        successEffect: s.successEffect,
        failureEffect: s.failureEffect,
      },
    ];
  });
}

/** `assets` gives the Day10_Strategies rows; without them (or without the tab) a strategy event keeps its drift. */
export function buildEventContext(
  db: DbOrTx,
  gameId: string,
  day: number,
  phase: Phase,
  assets?: Pick<GameAssets, 'day10Strategies'>,
): EventContext {
  const scenario = getGameScenario(db, gameId);
  const timeline = getTimeline(db, gameId);
  if (!scenario || !timeline) return { day, phase, active: [], past: [], foreshadowing: [] };
  const clean = tokeniseNames(scenario);
  const state = new Map(timeline.events.map((e) => [e.id, e]));
  const places = new Map(scenario.locations.map((l) => [l.id, l.name]));
  const active: ActiveEventContext[] = [];
  const past: PastEventContext[] = [];

  for (const event of inPlayOrder(scenario.timeline)) {
    const s = state.get(event.id);
    if (s?.status === 'active' && isDuring(event, { day, phase })) {
      active.push({
        id: event.id,
        kind: event.kind,
        title: clean(event.title),
        description: clean(event.description),
        interventionEffects: clean(event.interventionEffects),
        defaultOutcome: clean(event.outcome),
        chosenOutcome: s.outcome === null ? null : clean(s.outcome),
        crisis: event.crisis,
        places: event.locationIds === null ? null : event.locationIds.flatMap((id) => places.get(id) ?? []),
        npcs: event.npcIds.map(npcToken),
        strategies: strategiesOf(event, assets).map((st) => ({ ...st, requiredNpcs: clean(st.requiredNpcs) })),
      });
    } else if (s?.status === 'resolved') {
      past.push({
        id: event.id,
        day: event.day,
        phase: event.phase,
        title: clean(event.title),
        outcome: clean(s.outcome ?? ''),
        intervened: s.outcomeSource === 'ai',
        side: s.outcomeSide,
      });
    }
  }
  return { day, phase, active, past, foreshadowing: foreshadowingFor(scenario, day, phase) };
}

/** The context as a prompt block (volatile, so not cached). */
export function eventContextBlock(context: EventContext): PromptBlock {
  const text = [
    `เหตุการณ์ตามเส้นเวลา วันที่ ${context.day} ช่วง ${context.phase}`,
    'active = เหตุการณ์ที่เกิดในช่วงนี้ (ผู้เล่นแทรกแซงได้ ถ้าเปลี่ยนผลให้ตอบใน eventOutcomes), past = ผลของเหตุการณ์ที่ผ่านมาแล้ว',
    'foreshadowing = ลางบอกเหตุของเหตุการณ์ที่กำลังจะมา ให้สอดแทรกในการบรรยายช่วงนี้ อย่าบอกตรง ๆ ว่าจะเกิดอะไร',
    JSON.stringify({ active: context.active, past: context.past, foreshadowing: context.foreshadowing }),
  ].join('\n');
  return { id: 'timeline', text, cache: false };
}
