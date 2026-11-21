import { z } from 'zod';

/**
 * Scenario template (GEN-045): the starting world of a 12-day game from GDD §5-6 and the GEN-042
 * Rules Spec. Pure data + zod, no DB. Each game keeps its own copy (server `game_scenario`).
 *
 * Fields added after version 1 must carry `.default()` so older saved templates still load (C6);
 * bump SCENARIO_SCHEMA_VERSION only when an old document cannot be read that way.
 */
export const SCENARIO_SCHEMA_VERSION = 1;
export const SCENARIO_DAYS = 12;

/**
 * Reputation bands of GEN-042 (Rules Spec §5). The numbers are fixed; a scenario only renames the
 * title text. `mod` is the roll modifier of the band.
 */
export const SOCIAL_TITLE_BANDS = [
  { min: -100, max: -61, mod: -3 },
  { min: -60, max: -31, mod: -2 },
  { min: -30, max: -11, mod: -1 },
  { min: -10, max: 10, mod: 0 },
  { min: 11, max: 30, mod: 1 },
  { min: 31, max: 60, mod: 2 },
  { min: 61, max: 100, mod: 3 },
] as const;

const Id = z
  .string({ error: 'ต้องมี id' })
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'id ใช้ได้เฉพาะ a-z, 0-9 และ - (ไม่เกิน 64 ตัว)');
const text = (max: number) =>
  z.string({ error: 'ต้องเป็นข้อความ' }).trim().min(1, 'ห้ามว่าง').max(max, `ยาวได้ไม่เกิน ${max} ตัวอักษร`);
const optionalText = (max: number) => z.string().max(max, `ยาวได้ไม่เกิน ${max} ตัวอักษร`).default('');
/** GM-only note; never sent to players. */
const GmNote = optionalText(2000);

export const Phase = z.enum(['MORNING', 'AFTERNOON', 'NIGHT'], {
  error: 'ช่วงต้องเป็น เช้า (MORNING), บ่าย (AFTERNOON) หรือ ค่ำ (NIGHT)',
});
export type Phase = z.infer<typeof Phase>;

/** Rest recovery at night (Rules Spec §4.1): rough +15, basic +20, inn +25 Stamina. */
export const RestQuality = z.enum(['rough', 'basic', 'inn']);
/** Rescue weight of a place (Rules Spec §12.2): safe +4, normal 0, danger -4. */
export const Safety = z.enum(['safe', 'normal', 'danger']);

export const ScenarioLocation = z.object({
  id: Id,
  name: text(60),
  restQuality: RestQuality,
  safety: Safety.default('normal'),
  /** Places reachable from here in one move. */
  connects: z.array(Id).default([]),
  description: optionalText(1000),
  gmNote: GmNote,
});

/** Starting grades. SS never spawns; it only evolves from F during play (GDD §5). */
export const StartingNpcRank = z.enum(['F', 'B', 'A', 'S'], {
  error: (issue) =>
    issue.input === 'SS' ? 'เกรด SS เกิดเองไม่ได้ ต้องวิวัฒนาการจากเกรด F เท่านั้น' : 'เกรดต้องเป็น F, B, A หรือ S',
});

export const ScenarioNpc = z.object({
  id: Id,
  /** Real name; grade B keeps it hidden until affinity +9. */
  name: text(60),
  /** What players call the NPC before they learn the name. */
  alias: text(60),
  rank: StartingNpcRank,
  locationId: Id,
  personality: optionalText(500),
  /** `npcObsTrait` of Rules Spec §10.4. */
  obsTrait: z.number().int().min(-2).max(2).default(0),
  gmNote: GmNote,
});

export const ScenarioEvent = z.object({
  id: Id,
  day: z
    .number({ error: 'วันต้องเป็นตัวเลข' })
    .int('วันต้องเป็นจำนวนเต็ม')
    .min(1, `วันต้องอยู่ระหว่าง 1 ถึง ${SCENARIO_DAYS}`)
    .max(SCENARIO_DAYS, `วันต้องอยู่ระหว่าง 1 ถึง ${SCENARIO_DAYS}`),
  phase: Phase,
  kind: z.enum(['event', 'climax', 'finale']).default('event'),
  title: text(120),
  description: optionalText(1000),
  /** ผลตั้งต้น: what happens when no player steps in (GEN-046). */
  outcome: optionalText(1000),
  /** Crisis events are the ones that can raise an A-grade NPC to S (Rules Spec §8.3). */
  crisis: z.boolean().default(false),
  locationId: Id.nullable().default(null),
  npcIds: z.array(Id).default([]),
  gmNote: GmNote,
});

const OriginWeight = z.number().int('น้ำหนักต้องเป็นจำนวนเต็ม').min(0).max(100);

export const SpawnPoint = z.object({ id: Id, label: text(120), locationId: Id });

const spawnTier = <K extends 'standard' | 'special'>(kind: K) =>
  z.object({
    id: Id,
    kind: z.literal(kind),
    label: text(60),
    weight: OriginWeight,
    spawnPoints: z.array(SpawnPoint).min(1, 'ต้องมีจุดเกิดอย่างน้อย 1 จุด'),
  });

/** One row of the d100 origin table (GDD §6.1, Rules Spec §11). */
export const OriginTier = z.discriminatedUnion('kind', [
  spawnTier('standard'),
  spawnTier('special'),
  z.object({
    id: Id,
    kind: z.literal('pocket'),
    label: text(60),
    weight: OriginWeight,
    description: optionalText(1000),
    durationDays: z.literal(3),
    /** Constraint escape DC while trapped. */
    escapeDc: z.literal(20),
    /** Escaped within the days: one Legendary skill or item, then warp into town. */
    onSuccess: z.object({ legendaryRewards: z.literal(1), warpToLocationId: Id }),
    /** Not out in time: reputation set to -100, warp to the cult altar. */
    onFailure: z.object({ reputation: z.literal(-100), warpToLocationId: Id }),
  }),
]);
export type OriginTier = z.infer<typeof OriginTier>;

export const SocialTitle = z.object({ min: z.number().int(), max: z.number().int(), title: text(40) });

/** Secret Legendary set by the GM (GDD §4.2, Rules Spec §11). Players never see it. */
export const ScenarioLegendary = z.object({
  id: Id,
  name: text(60),
  type: z.enum(['skill', 'item']),
  condition: text(500),
  counter: z.enum(['streak_days', 'count']),
  target: z.number().int().min(1, 'เป้าต้องอยู่ระหว่าง 1 ถึง 12').max(SCENARIO_DAYS, 'เป้าต้องอยู่ระหว่าง 1 ถึง 12'),
  progress: z.number().int().min(0).default(0),
  unlocked: z.boolean().default(false),
});

const ScenarioShape = z.object({
  /** Older documents may omit it; parsing always yields the current version. */
  schemaVersion: z
    .number()
    .int()
    .min(1)
    .max(SCENARIO_SCHEMA_VERSION, `รุ่นของ scenario ใหม่กว่าที่ server รู้จัก (${SCENARIO_SCHEMA_VERSION})`)
    .default(SCENARIO_SCHEMA_VERSION)
    .transform((): number => SCENARIO_SCHEMA_VERSION),
  id: Id,
  name: text(80),
  town: z.object({
    name: text(60),
    mood: optionalText(500),
    /** Things the group does not want in the story. */
    taboos: z.array(text(200)).default([]),
  }),
  locations: z.array(ScenarioLocation).min(1, 'ต้องมีสถานที่อย่างน้อย 1 แห่ง'),
  npcs: z.array(ScenarioNpc),
  timeline: z.array(ScenarioEvent).min(1, 'ต้องมีเหตุการณ์อย่างน้อย 1 รายการ'),
  origins: z.array(OriginTier).min(1, 'ต้องมีตาราง origin'),
  socialTitles: z.array(SocialTitle).length(SOCIAL_TITLE_BANDS.length, `ต้องมีฉายา ${SOCIAL_TITLE_BANDS.length} ระดับ`),
  legendaries: z.array(ScenarioLegendary).default([]),
});

type Shape = z.output<typeof ScenarioShape>;
type Ctx = z.core.$RefinementCtx<Shape>;

function flagDuplicateIds(ctx: Ctx, items: readonly { id: string; path: (string | number)[] }[]) {
  const seen = new Set<string>();
  for (const { id, path } of items) {
    if (seen.has(id)) ctx.addIssue({ code: 'custom', path, message: `id ซ้ำ: "${id}"` });
    seen.add(id);
  }
}

function crossCheck(s: Shape, ctx: Ctx) {
  flagDuplicateIds(ctx, s.locations.map((l, i) => ({ id: l.id, path: ['locations', i, 'id'] })));
  flagDuplicateIds(ctx, s.npcs.map((n, i) => ({ id: n.id, path: ['npcs', i, 'id'] })));
  flagDuplicateIds(ctx, s.timeline.map((e, i) => ({ id: e.id, path: ['timeline', i, 'id'] })));
  flagDuplicateIds(ctx, s.origins.map((o, i) => ({ id: o.id, path: ['origins', i, 'id'] })));
  flagDuplicateIds(
    ctx,
    s.origins.flatMap((o, i) =>
      o.kind === 'pocket' ? [] : o.spawnPoints.map((p, j) => ({ id: p.id, path: ['origins', i, 'spawnPoints', j, 'id'] })),
    ),
  );
  flagDuplicateIds(ctx, s.legendaries.map((l, i) => ({ id: l.id, path: ['legendaries', i, 'id'] })));

  const locationIds = new Set(s.locations.map((l) => l.id));
  const npcIds = new Set(s.npcs.map((n) => n.id));
  const place = (id: string | null, path: (string | number)[]) => {
    if (id !== null && !locationIds.has(id)) ctx.addIssue({ code: 'custom', path, message: `ไม่มีสถานที่ id "${id}"` });
  };
  s.locations.forEach((l, i) => l.connects.forEach((id, j) => place(id, ['locations', i, 'connects', j])));
  s.npcs.forEach((n, i) => place(n.locationId, ['npcs', i, 'locationId']));
  s.timeline.forEach((e, i) => {
    place(e.locationId, ['timeline', i, 'locationId']);
    e.npcIds.forEach((id, j) => {
      if (!npcIds.has(id)) ctx.addIssue({ code: 'custom', path: ['timeline', i, 'npcIds', j], message: `ไม่มี NPC id "${id}"` });
    });
  });
  s.origins.forEach((o, i) => {
    if (o.kind === 'pocket') {
      place(o.onSuccess.warpToLocationId, ['origins', i, 'onSuccess', 'warpToLocationId']);
      place(o.onFailure.warpToLocationId, ['origins', i, 'onFailure', 'warpToLocationId']);
    } else {
      o.spawnPoints.forEach((p, j) => place(p.locationId, ['origins', i, 'spawnPoints', j, 'locationId']));
    }
  });

  const totalWeight = s.origins.reduce((sum, o) => sum + o.weight, 0);
  if (totalWeight !== 100) {
    ctx.addIssue({ code: 'custom', path: ['origins'], message: `น้ำหนัก origin รวมต้องเป็น 100 (ตอนนี้ ${totalWeight})` });
  }

  const finales = s.timeline.flatMap((e, i) => (e.kind === 'finale' ? [i] : []));
  if (finales.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['timeline'], message: `ต้องมีเหตุการณ์ฉากจบ (finale) ในวันที่ ${SCENARIO_DAYS}` });
  }
  for (const [n, i] of finales.entries()) {
    const event = s.timeline[i]!;
    if (n > 0) ctx.addIssue({ code: 'custom', path: ['timeline', i, 'kind'], message: 'มีฉากจบ (finale) ได้รายการเดียว' });
    else if (event.day !== SCENARIO_DAYS) {
      ctx.addIssue({ code: 'custom', path: ['timeline', i, 'kind'], message: `ฉากจบ (finale) ต้องอยู่วันที่ ${SCENARIO_DAYS}` });
    }
  }

  s.socialTitles.forEach((t, i) => {
    const band = SOCIAL_TITLE_BANDS[i]!;
    for (const key of ['min', 'max'] as const) {
      if (t[key] !== band[key]) {
        ctx.addIssue({
          code: 'custom',
          path: ['socialTitles', i, key],
          message: `ช่วงคะแนนของฉายาแก้ไม่ได้ ระดับนี้ต้องเป็น ${band.min}..${band.max}`,
        });
      }
    }
  });
}

/** Full scenario document. Parse with `parseScenario` to get field-named errors. */
export const Scenario = ScenarioShape.superRefine(crossCheck);
export type Scenario = z.output<typeof Scenario>;
export type ScenarioInput = z.input<typeof Scenario>;

/** One wrong field: `path` is dot-joined (`timeline.0.day`, `origins`; `''` for the whole document). */
export interface ScenarioIssue {
  path: string;
  message: string;
}

export type ScenarioParseResult = { ok: true; scenario: Scenario } | { ok: false; errors: ScenarioIssue[] };

/** Validates (and upgrades) a scenario from JSON. Reports every wrong field, not just the first. */
export function parseScenario(input: unknown): ScenarioParseResult {
  const result = Scenario.safeParse(input);
  if (result.success) return { ok: true, scenario: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
  };
}

const PHASE_ORDER: Record<Phase, number> = { MORNING: 0, AFTERNOON: 1, NIGHT: 2 };

/** The timeline in play order: by day, then MORNING → AFTERNOON → NIGHT; ties keep their order. */
export function sortTimeline<T extends Pick<Scenario, 'timeline'>>(scenario: T): T {
  const timeline = scenario.timeline
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.day - b.event.day || PHASE_ORDER[a.event.phase] - PHASE_ORDER[b.event.phase] || a.index - b.index)
    .map(({ event }) => event);
  return { ...scenario, timeline };
}

/**
 * 200 from GET / PUT /api/game/scenario and POST /api/game/scenario/reset (Human GM only, GEN-046).
 * `locked` once the game has started: the editor shows it read-only.
 */
export const GameScenarioResponse = z.object({ scenario: Scenario, locked: z.boolean() });
export type GameScenarioResponse = z.infer<typeof GameScenarioResponse>;

/** The Social Title text for a reputation score in this scenario. */
export function socialTitleFor(scenario: Pick<Scenario, 'socialTitles'>, reputation: number): string {
  const rep = Math.max(-100, Math.min(100, Math.trunc(reputation)));
  const index = SOCIAL_TITLE_BANDS.findIndex((b) => rep >= b.min && rep <= b.max);
  return scenario.socialTitles[index]!.title;
}
