/**
 * GEN-169: the server's style checker, no AI cost. Reads the forbidden rules and the NPC speech profiles of the Voice
 * data set (GEN-176) and checks each narration and NPC line before it is published. A hit is counted per NPC per
 * reason for the admin (GEN-178 style review) and the message always goes out. Only a `block` rule ("ทำการ", emoji /
 * markdown, Q-334) with the rewrite setting on asks the AI once to rewrite, within a time budget; a rewrite that
 * still hits a block rule, fails or runs out of time leaves the original.
 */
import { defaultScenario, StyleSettings, type StyleFlagStat } from '@isekai/protocol';
import { eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.ts';
import { appMeta } from '../db/schema.ts';
import { VOICE_REGEX_FLAGS, voiceProfile, type VoiceAsset, type VoiceForm } from '../assets/voice.ts';
import { wordCount } from './check.ts';

export type StyleScope = 'narration' | 'dialogue';

export interface StyleIssue {
  /** A ForbiddenRule id, `pronoun_mismatch` or `never_word`. */
  reason: string;
  severity: 'flag' | 'block';
  /** The NPC who spoke; null for narration. */
  npcId: string | null;
  /** The hint for a rewrite prompt. */
  fix: string;
}

/** First-person pronouns one NPC's line may not borrow from another, longest first (ข้าน้อย before ข้า). */
const SELF_PRONOUNS = ['ข้าน้อย', 'กระผม', 'ดิฉัน', 'ผม', 'ฉัน', 'ข้า'];

const sentencesOf = (text: string) => text.split(/\s+/).filter(Boolean);

function overDensity(text: string, words: readonly string[], max: number, per: number): boolean {
  const sentences = sentencesOf(text);
  const counts = sentences.map((s) => words.reduce((n, w) => n + wordCount(s, w), 0));
  for (let i = 0; i <= Math.max(0, counts.length - per); i++) {
    if (counts.slice(i, i + per).reduce((a, b) => a + b, 0) > max) return true;
  }
  return false;
}

/**
 * Every rule `text` breaks (one issue per reason). `npcId`: who speaks a dialogue line. `form` (GEN-193): the form it
 * speaks in (null = normal); undefined = not known (stored text, players who see different forms): any of its forms.
 */
export function styleIssues(voice: VoiceAsset, text: string, scope: StyleScope, npcId: string | null = null, form?: VoiceForm | null): StyleIssue[] {
  const issues: StyleIssue[] = [];
  const who = scope === 'dialogue' ? npcId : null;
  for (const rule of voice.forbidden) {
    if (rule.scope !== 'all' && rule.scope !== scope) continue;
    const m = rule.match;
    const hit =
      m.type === 'literal' ? text.includes(m.value) : m.type === 'regex' ? new RegExp(m.value, VOICE_REGEX_FLAGS).test(text) : overDensity(text, m.words, m.max, m.perSentences);
    if (hit) issues.push({ reason: rule.id, severity: rule.severity, npcId: who, fix: rule.fix });
  }
  const profile = who === null ? undefined : voiceProfile(voice, who, form ?? null);
  if (!profile) return issues;
  const own = new Set([...profile.self, ...(form === undefined ? Object.values(voice.npcs[who!]!.forms ?? {}).flatMap((f) => f.self ?? []) : [])]);
  let rest = text;
  let mismatch = false;
  for (const pronoun of SELF_PRONOUNS) {
    if (wordCount(rest, pronoun) === 0) continue;
    if (!own.has(pronoun)) mismatch = true;
    rest = rest.split(pronoun).join(' ');
  }
  const self = profile.self[0] ?? 'ละประธาน';
  if (mismatch) issues.push({ reason: 'pronoun_mismatch', severity: 'flag', npcId: who, fix: `เรียกตัวเองว่า ${self} เรียกผู้ฟังว่า ${profile.you.default}` });
  if (profile.neverWords.some((w) => wordCount(text, w) > 0)) {
    issues.push({ reason: 'never_word', severity: 'flag', npcId: who, fix: `ไม่พูดคำว่า ${profile.neverWords.join(' ')}` });
  }
  return issues;
}

// The settings and the counts are a few keys of app_meta (no table of their own).
const SETTINGS_KEY = 'style_settings';
const FLAGS_KEY = 'style_flags';

function readMeta(db: DbOrTx, key: string): unknown {
  const row = db.select().from(appMeta).where(eq(appMeta.key, key)).get();
  try {
    return row ? (JSON.parse(row.value) as unknown) : undefined;
  } catch {
    return undefined;
  }
}
const writeMeta = (db: DbOrTx, key: string, value: unknown) =>
  db.insert(appMeta).values({ key, value: JSON.stringify(value) }).onConflictDoUpdate({ target: appMeta.key, set: { value: JSON.stringify(value) } }).run();

/** The settings kept in app_meta (GEN-177's default tone lives in the Voice data set instead). */
type CheckerSettings = Pick<StyleSettings, 'rewrite'>;
const CheckerSettings = StyleSettings.pick({ rewrite: true });
const DEFAULT_SETTINGS: CheckerSettings = { rewrite: false };

export function getStyleSettings(db: Db): CheckerSettings {
  const raw = readMeta(db, SETTINGS_KEY);
  const saved = CheckerSettings.safeParse({ ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) });
  return saved.success ? saved.data : DEFAULT_SETTINGS;
}

export function setStyleSettings(db: Db, patch: Partial<CheckerSettings>): CheckerSettings {
  const next = { ...getStyleSettings(db), ...patch };
  writeMeta(db, SETTINGS_KEY, next);
  return next;
}

type Counts = Record<string, Record<string, number>>;
/** NPC id ('' = narration) → reason → count. */
const countsOf = (db: DbOrTx): Counts => {
  const raw = readMeta(db, FLAGS_KEY);
  return raw && typeof raw === 'object' ? (raw as Counts) : {};
};

export function recordStyleFlags(db: Db, issues: readonly StyleIssue[]): void {
  if (issues.length === 0) return;
  db.transaction((tx) => {
    const counts = countsOf(tx);
    for (const i of issues) {
      const npc = (counts[i.npcId ?? ''] ??= {});
      npc[i.reason] = (npc[i.reason] ?? 0) + 1;
    }
    writeMeta(tx, FLAGS_KEY, counts);
  });
}

/** Most flagged first; an NPC by its id and public alias (never its real name). */
export function styleFlagStats(db: Db): StyleFlagStat[] {
  const alias = new Map(defaultScenario().npcs.map((n) => [n.id, n.alias]));
  return Object.entries(countsOf(db))
    .flatMap(([npc, reasons]) => Object.entries(reasons).map(([reason, count]) => ({ npc: npc === '' ? null : { id: npc, alias: alias.get(npc) ?? npc }, reason, count })))
    .sort((a, b) => b.count - a.count || (a.npc?.id ?? '').localeCompare(b.npc?.id ?? '') || a.reason.localeCompare(b.reason));
}

/**
 * Checks `value`, counts what the AI wrote, and with the rewrite setting on asks `rewrite` once for a block hit
 * (aborted after `timeoutMs`). Returns what to publish: the rewrite only when it no longer hits a block rule.
 */
export async function gateStyle<T>(opts: {
  db: Db;
  value: T;
  issuesOf: (value: T) => StyleIssue[];
  rewrite: (issues: StyleIssue[], signal: AbortSignal) => Promise<T | undefined>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Metadata only (purpose, audience); the line never holds the text. */
  log?: (line: string) => void;
  label?: string;
}): Promise<{ value: T; rewritten: boolean; issues: StyleIssue[] }> {
  const issues = opts.issuesOf(opts.value);
  recordStyleFlags(opts.db, issues);
  if (issues.length === 0) return { value: opts.value, rewritten: false, issues };
  const isBlock = (i: StyleIssue) => i.severity === 'block';
  let outcome = 'off';
  let result = { value: opts.value, rewritten: false, issues };
  if (issues.some(isBlock) && getStyleSettings(opts.db).rewrite && !opts.signal?.aborted) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    opts.signal?.addEventListener('abort', stop, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => (stop(), resolve(undefined)), opts.timeoutMs);
    });
    const fixed = await Promise.race([opts.rewrite(issues, controller.signal).catch(() => undefined), late]);
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', stop);
    const again = fixed === undefined ? undefined : opts.issuesOf(fixed);
    if (fixed !== undefined && again && !again.some(isBlock)) {
      result = { value: fixed, rewritten: true, issues: again };
      outcome = 'ok';
    } else outcome = controller.signal.aborted ? 'timeout' : 'failed';
  }
  opts.log?.(`[style] ${opts.label ?? ''} flags=${[...new Set(issues.map((i) => (i.npcId ? `${i.npcId}:${i.reason}` : i.reason)))].join(',')} rewrite=${outcome}`);
  return result;
}
