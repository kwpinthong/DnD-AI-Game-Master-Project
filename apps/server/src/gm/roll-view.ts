import { difficultyWord, type GmCheckView, type HitChange, type HitView, type RollFactor, type RollFactorKind, type RollOutcome, type RollView } from '@isekai/protocol';
import type { ActionOutcome, Degree, ResolutionLog } from '@isekai/rules';

/**
 * What a player may see of the dice (Q-229, Q-198): the d20 face, the difficulty as a word, the outcome and an arrow
 * per factor. Never the DC, the total, the modifiers' numbers or the Karma / Reputation / affinity behind them.
 * The Human GM gets every number (`checkViewOf`).
 */

const OUTCOME: Record<Degree, RollOutcome> = { crit: 'critical_success', success: 'success', fail: 'failure', fumble: 'critical_failure' };

/** Factors that are not an owned skill / item; the label says where it came from, never how much. */
const SOURCE: Record<string, { kind: RollFactorKind; label: string }> = {
  stat: { kind: 'trait', label: 'ความถนัดของตัวละคร' },
  rep: { kind: 'title', label: 'ชื่อเสียงของคุณ' },
  karma: { kind: 'fate', label: 'โชคชะตา' },
  affinity: { kind: 'other', label: 'ความสัมพันธ์กับ NPC' },
  weather: { kind: 'weather', label: 'สภาพอากาศ' },
  location: { kind: 'place', label: 'สถานที่' },
  start_passive: { kind: 'origin', label: 'พื้นเพของคุณ' },
  status: { kind: 'status', label: 'สถานะที่ติดตัว' },
};

type Check = NonNullable<ResolutionLog['check']>;
type Modifier = Check['modifiers'][number];
type NameOf = (ref: string) => string | undefined;

/** Where a modifier comes from; an owned skill / item by its name. */
function sourceOf(m: Modifier, nameOf: NameOf): { kind: RollFactorKind; label: string } {
  if (m.source === 'skill' || m.source === 'item') return { kind: m.source, label: (m.ref === undefined ? undefined : nameOf(m.ref)) ?? (m.source === 'skill' ? 'ทักษะ' : 'ไอเทม') };
  return SOURCE[m.source] ?? { kind: 'other', label: 'ปัจจัยอื่น' };
}

/** The roll of one resolved action for its own actor; null when the action had no roll. `nameOf`: an owned skill / item id → its name. */
export function rollViewOf(log: ResolutionLog, nameOf: NameOf): RollView | null {
  if (log.check === null) return null;
  const factors = log.check.modifiers.flatMap((m): RollFactor[] => {
    // Karma is the hidden part of fate: the arrow is always a question mark.
    if (m.source === 'karma') return [{ ...sourceOf(m, nameOf), dir: 'unknown' }];
    if (m.value === 0) return [];
    return [{ ...sourceOf(m, nameOf), dir: m.value > 0 ? 'up' : 'down' }];
  });
  return { d20: log.check.d20, difficulty: difficultyWord(log.check.dc), outcome: OUTCOME[log.degree], factors };
}

/** The Human GM's view of one roll of the held turn: tags, DC, each modifier with its number, d20, total (Screens and Flows v2 §5). */
export function checkViewOf(outcome: ActionOutcome, action: { text: string; visibility: 'public' | 'secret' } | undefined, nameOf: NameOf): GmCheckView | null {
  if (outcome.status !== 'resolved' || outcome.log.check === null || !action) return null;
  const { check, tagging, degree } = outcome.log;
  return {
    memberId: outcome.actorId,
    text: action.text,
    visibility: action.visibility,
    tags: [...new Set([...(tagging?.verbTags ?? []), ...(tagging?.targetTags ?? [])])],
    dc: check.dc,
    modifiers: check.modifiers.filter((m) => m.value !== 0).map((m) => ({ label: sourceOf(m, nameOf).label, value: m.value })),
    d20: check.d20,
    total: check.total,
    outcome: OUTCOME[degree],
  };
}

/**
 * The "เกิดกับคุณ" card for the player another player acted on: null unless it cost them (HP lost, an item taken, a
 * curse put on them). `actor` is how the target knows the actor (a name or how they look), null = not seen.
 * `curses`: labels of the timed statuses this action put on the target.
 */
export function hitOf(outcome: ActionOutcome, actor: string | null, itemName: (id: string) => string, curses: readonly string[]): { memberId: string; hit: HitView } | null {
  if (outcome.status !== 'resolved' || outcome.target === null || outcome.target.playerId === outcome.actorId) return null;
  const t = outcome.target;
  if (t.hp.damage === 0 && t.itemsLost.length === 0 && curses.length === 0) return null;
  const changes: HitChange[] = [
    ...(t.hp.after !== t.hp.before ? [{ stat: 'hp' as const, delta: t.hp.after - t.hp.before }] : []),
    ...t.itemsLost.map((id) => ({ stat: 'item_lost' as const, name: itemName(id) })),
    ...curses.map((name) => ({ stat: 'status' as const, name })),
  ];
  return { memberId: t.playerId, hit: { actor: t.knowsActor ? actor : null, changes } };
}
