/**
 * Karma as words (GEN-067, sheet System_Rules "Karma Tiers"; the sheet wins over the GDD). Karma runs
 * -100..+100 and is never sent to a player: the owner sees only the adjective of their own band (Q-091),
 * other players see nothing of it, the Human GM sees the number. The bands come from the asset JSON, so
 * this module only looks a value up; the server parses and checks the bands at start (assets/karma.ts).
 */

export const KARMA_MIN = -100;
export const KARMA_MAX = 100;

/** One band, inclusive at both ends. */
export interface KarmaTier {
  readonly min: number;
  readonly max: number;
  readonly title: string;
}

/**
 * Problems with a band list: every integer -100..+100 must be in exactly one band, bands in order, and
 * every title non-empty. Empty list = usable.
 */
export function karmaTierProblems(tiers: readonly KarmaTier[]): string[] {
  const problems: string[] = [];
  let next = KARMA_MIN;
  for (const [i, t] of tiers.entries()) {
    if (!Number.isInteger(t.min) || !Number.isInteger(t.max) || t.min > t.max) problems.push(`band ${i} has an invalid range ${t.min}..${t.max}`);
    else if (t.min !== next) problems.push(`band ${i} starts at ${t.min}, expected ${next}`);
    if (t.title.trim() === '') problems.push(`band ${i} has no title`);
    next = t.max + 1;
  }
  if (next !== KARMA_MAX + 1) problems.push(`the bands end at ${next - 1}, expected ${KARMA_MAX}`);
  return problems;
}

/** The adjective for `karma` (clamped to -100..+100). `tiers` must pass `karmaTierProblems`. */
export function karmaTitle(karma: number, tiers: readonly KarmaTier[]): string {
  const value = Math.max(KARMA_MIN, Math.min(KARMA_MAX, Math.trunc(karma)));
  const tier = tiers.find((t) => value >= t.min && value <= t.max);
  if (!tier) throw new RangeError(`no karma band holds ${value}`);
  return tier.title;
}
