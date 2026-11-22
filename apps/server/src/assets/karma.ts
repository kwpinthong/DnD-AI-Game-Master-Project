import { KARMA_MAX, KARMA_MIN, karmaTierProblems, type KarmaTier } from '@isekai/rules';
import type { SystemRuleRecord } from './model.ts';

/**
 * The karma bands of the sheet (GEN-067): the System_Rules rows with category "Karma Tiers". Their
 * `mechanics` cell lists ranges as "+14..+30: คนหัดทำดี | +31..+50: ..." (Good / Evil) or
 * "-13 ถึง +13: เป็นกลาง (หากอยู่ที่ 0 พอดีแสดงคำว่า 'เป็นกลางสุดๆ')" (Neutral, with its special word at 0).
 * Returns the bands in order or the problems found; the asset loader turns problems into an AssetLoadError.
 */
export const KARMA_TIERS_CATEGORY = 'Karma Tiers';

const RANGE = /([+-]?\d+)\s*(?:\.\.|ถึง)\s*([+-]?\d+)\s*:\s*([^|(]+)/g;
const AT_ZERO = /0\s*พอดี[^'"‘’“”]*['"‘’“”]([^'"‘’“”]+)['"‘’“”]/;

export type KarmaTiersResult = { ok: true; tiers: KarmaTier[] } | { ok: false; problems: string[] };

export function karmaTiersFrom(rules: readonly SystemRuleRecord[]): KarmaTiersResult {
  const ranges: KarmaTier[] = [];
  let zeroTitle: string | null = null;
  for (const rule of rules.filter((r) => r.category.trim() === KARMA_TIERS_CATEGORY)) {
    for (const m of rule.mechanics.matchAll(RANGE)) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      ranges.push({ min: Math.min(a, b), max: Math.max(a, b), title: m[3]!.trim() });
    }
    const zero = AT_ZERO.exec(rule.mechanics);
    if (zero) zeroTitle = zero[1]!.trim();
  }
  if (ranges.length === 0) return { ok: false, problems: [`no "${KARMA_TIERS_CATEGORY}" row lists a range such as "+14..+30: <word>"`] };

  ranges.sort((x, y) => x.min - y.min);
  // The special word at 0 splits the band that holds 0.
  const tiers = ranges.flatMap((t): KarmaTier[] =>
    zeroTitle !== null && t.min <= 0 && t.max >= 0
      ? [
          ...(t.min < 0 ? [{ min: t.min, max: -1, title: t.title }] : []),
          { min: 0, max: 0, title: zeroTitle },
          ...(t.max > 0 ? [{ min: 1, max: t.max, title: t.title }] : []),
        ]
      : [t],
  );
  const problems = karmaTierProblems(tiers);
  return problems.length === 0 ? { ok: true, tiers } : { ok: false, problems: problems.map((p) => `${p} (karma ${KARMA_MIN}..${KARMA_MAX})`) };
}
