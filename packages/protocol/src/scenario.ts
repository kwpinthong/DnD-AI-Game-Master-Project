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

/**
 * The period of the day (ช่วงเวลา, System_Rules "Time System", GEN-063); each has 2 turns. Same values as
 * `PERIODS` in `@isekai/rules`. The key stays `phase` wherever a point in time is stored or sent.
 */
export const PHASES = ['EOSORIA', 'SOLARION', 'HESPERION', 'NOCTHERION'] as const;
export const Phase = z.enum(PHASES, {
  error: 'ช่วงต้องเป็น EOSORIA (เช้า), SOLARION (บ่าย), HESPERION (ค่ำ) หรือ NOCTHERION (ดึก)',
});
export type Phase = z.infer<typeof Phase>;

/** Thai label of each period, with its hours. */
export const PHASE_LABEL: Readonly<Record<Phase, string>> = {
  EOSORIA: 'EOSORIA (เช้า 06:00-11:59)',
  SOLARION: 'SOLARION (บ่าย 12:00-17:59)',
  HESPERION: 'HESPERION (ค่ำ 18:00-23:59)',
  NOCTHERION: 'NOCTHERION (ดึก 24:00-05:59)',
};

/** The 3 phases of GEN-045..GEN-062 and the period each became (GEN-063). Same as `LEGACY_PHASES` in `@isekai/rules`. */
export const LEGACY_PHASES = { MORNING: 'EOSORIA', AFTERNOON: 'SOLARION', NIGHT: 'HESPERION' } as const satisfies Record<string, Phase>;

/** A scenario event's period; a saved scenario from before GEN-063 (MORNING / AFTERNOON / NIGHT) is upgraded. */
const EventPhase = z.preprocess(
  (value) => (typeof value === 'string' && value in LEGACY_PHASES ? LEGACY_PHASES[value as keyof typeof LEGACY_PHASES] : value),
  Phase,
);

/**
 * Rest quality of a place, as the sheet's Location `Rest_Quality` (Q-161). The rest engine does not read it
 * yet (night rest is still inn / rough, GEN-052). A scenario saved before Q-161 is upgraded:
 * rough → poor, basic → normal, inn → good.
 */
export const LEGACY_REST_QUALITIES = { rough: 'poor', basic: 'normal', inn: 'good' } as const;
export const RestQuality = z.preprocess(
  (value) => (typeof value === 'string' && value in LEGACY_REST_QUALITIES ? LEGACY_REST_QUALITIES[value as keyof typeof LEGACY_REST_QUALITIES] : value),
  z.enum(['poor', 'normal', 'good', 'excellent'], { error: 'คุณภาพการพักต้องเป็น poor, normal, good หรือ excellent' }),
);
/**
 * Rescue weight of a place (Rules Spec §12.2): safe +4, normal 0, danger -4; restricted (Q-161, the sheet's
 * RESTRICTED) counts as normal until Nok gives it a number.
 */
export const Safety = z.enum(['safe', 'normal', 'danger', 'restricted'], { error: 'ความปลอดภัยต้องเป็น safe, normal, danger หรือ restricted' });

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
  /** Short forms of `name` the event text uses ("มัลคอล์ม"); the AI GM gets them as the NPC token too. */
  otherNames: z.array(text(60)).default([]),
  gmNote: GmNote,
});

const Day = z
  .number({ error: 'วันต้องเป็นตัวเลข' })
  .int('วันต้องเป็นจำนวนเต็ม')
  .min(1, `วันต้องอยู่ระหว่าง 1 ถึง ${SCENARIO_DAYS}`)
  .max(SCENARIO_DAYS, `วันต้องอยู่ระหว่าง 1 ถึง ${SCENARIO_DAYS}`);

/** A Day10_Strategies `Strategy_ID` of the asset sheet (GEN-072), e.g. `D10-S1`. */
const StrategyId = z
  .string({ error: 'ต้องเป็นรหัสแผน' })
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'รหัสแผนใช้ได้เฉพาะ A-Z, a-z, 0-9, _ และ -');

export const ScenarioEvent = z.object({
  id: Id,
  day: Day,
  /** The period the event starts in; it is active for both turns of each of its periods. */
  phase: EventPhase,
  /** Last period of the event on the same day (World_Timeline "HESPERION ถึง NOCTHERION"); null = only `phase`. */
  endPhase: EventPhase.nullable().default(null),
  kind: z.enum(['event', 'climax', 'finale']).default('event'),
  title: text(120),
  description: optionalText(1000),
  /** ผลตั้งต้น: what happens when no player steps in (GEN-046) = World_Drift_If_Ignored of the sheet. */
  outcome: optionalText(1000),
  /** Player_Intervention_Effects: what stepping in can change, for the AI GM. */
  interventionEffects: optionalText(1000),
  /** Foreshadowing text the AI GM weaves into the narration at `foreshadowAt`. */
  foreshadowing: optionalText(1000),
  /** Foreshadowing_Trigger: the day + period whose context carries `foreshadowing`; null = none. */
  foreshadowAt: z.object({ day: Day, phase: Phase }).nullable().default(null),
  /** Day10_Strategies the players may run against this event (GEN-072); a missing one = drift. */
  strategyIds: z.array(StrategyId).default([]),
  /** Crisis events are the ones that can raise an A-grade NPC to S (Rules Spec §8.3). */
  crisis: z.boolean().default(false),
  locationId: Id.nullable().default(null),
  npcIds: z.array(Id).default([]),
  gmNote: GmNote,
});

const OriginWeight = z.number().int('น้ำหนักต้องเป็นจำนวนเต็ม').min(0).max(100);

export const SpawnPoint = z.object({ id: Id, label: text(120), locationId: Id });

const spawnTier = <K extends 'standard' | 'special' | 'secret'>(kind: K) =>
  z.object({
    id: Id,
    kind: z.literal(kind),
    label: text(60),
    weight: OriginWeight,
    spawnPoints: z.array(SpawnPoint).min(1, 'ต้องมีจุดเกิดอย่างน้อย 1 จุด'),
  });

/**
 * One row of the d100 origin table (GDD §6.1, Rules Spec §11): standard 70 / special 29 / secret 1 (the
 * Astral Rift, sheet Start_Scenarios "รูทลับ 1%"). `pocket` is the GEN-045 Pocket Dimension, cut by Q-093 /
 * Q-101: still parsed so a stored scenario of an older game loads, never in the template, and a game rolls
 * it as the secret route (GEN-065).
 */
export const OriginTier = z.discriminatedUnion('kind', [
  spawnTier('standard'),
  spawnTier('special'),
  spawnTier('secret'),
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
    if (e.endPhase !== null && order(e.endPhase) < order(e.phase)) {
      ctx.addIssue({ code: 'custom', path: ['timeline', i, 'endPhase'], message: 'ช่วงสิ้นสุดต้องไม่อยู่ก่อนช่วงเริ่ม' });
    }
    if (e.foreshadowAt !== null && pointRank(e.foreshadowAt) >= pointRank(e)) {
      ctx.addIssue({ code: 'custom', path: ['timeline', i, 'foreshadowAt'], message: 'เวลาปูเรื่องต้องอยู่ก่อนเหตุการณ์เริ่ม' });
    }
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

const order = (p: Phase) => PHASES.indexOf(p);
const pointRank = (p: { day: number; phase: Phase }) => (p.day - 1) * PHASES.length + order(p.phase);

/** Turns in each period (System_Rules "Time System", GEN-063). */
export const TURNS_PER_PERIOD = 2;

/** The periods an event is active in, `phase` through `endPhase` on its day. */
export function eventPeriods(event: { phase: Phase; endPhase: Phase | null }): Phase[] {
  const end = event.endPhase ?? event.phase;
  return PHASES.filter((p) => order(p) >= order(event.phase) && order(p) <= order(end));
}

/** The timeline in play order: by day, then EOSORIA → SOLARION → HESPERION → NOCTHERION; ties keep their order. */
export function sortTimeline<T extends Pick<Scenario, 'timeline'>>(scenario: T): T {
  const timeline = scenario.timeline
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.day - b.event.day || order(a.event.phase) - order(b.event.phase) || a.index - b.index)
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
