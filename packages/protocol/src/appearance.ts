import { z } from 'zod';
import presets from './avatar-presets.json' with { type: 'json' };

/**
 * ISK-006: a character's look is a preset avatar (ISK-005) + one chip per category + a short free text. The server
 * builds the sentence once at creation (`composeAppearance`) and stores it; the chip list is the game data set
 * Appearance_Options (admin editable: ids stay, labels change, values are added or hidden).
 */
export const APPEARANCE_CATEGORIES = ['hairColor', 'hairStyle', 'eyes', 'build', 'outfit', 'feature'] as const;
export type AppearanceCategory = (typeof APPEARANCE_CATEGORIES)[number];
export const APPEARANCE_EXTRA_MAX_LENGTH = 80;

/** The preset avatars (packages/protocol/src/avatar-presets.json). */
export const AVATAR_IDS: readonly string[] = presets.map((p) => p.id);

/** The chips a character was made with (ids; `extra` already normalised). */
export const AppearanceTraits = z.strictObject({
  hairColor: z.string(),
  hairStyle: z.string(),
  eyes: z.string(),
  build: z.string(),
  outfit: z.string(),
  feature: z.string(),
  extra: z.string().optional(),
});
export type AppearanceTraits = z.infer<typeof AppearanceTraits>;

/** One chip value of the data set. `hidden`: not offered to new characters (never removed: old ones keep their sentence). */
export const AppearanceOption = z.strictObject({
  category: z.enum(APPEARANCE_CATEGORIES),
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'id เป็นตัวพิมพ์เล็ก a-z 0-9 -'),
  label: z.string().trim().min(1, 'label ต้องไม่ว่าง'),
  hidden: z.boolean().optional(),
});
export type AppearanceOption = z.infer<typeof AppearanceOption>;

/** The Appearance_Options data set: ids unique per category, every category with at least one value offered. */
export const AppearanceOptions = z.array(AppearanceOption).superRefine((options, ctx) => {
  const seen = new Set<string>();
  options.forEach((o, i) => {
    const key = `${o.category}:${o.id}`;
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `id ${o.id} ซ้ำในหมวด ${o.category}` });
    seen.add(key);
  });
  for (const category of APPEARANCE_CATEGORIES) {
    if (!options.some((o) => o.category === category && !o.hidden)) ctx.addIssue({ code: 'custom', path: [], message: `หมวด ${category} ต้องมีค่าที่ไม่ซ่อนอย่างน้อย 1 ค่า` });
  }
});

const Choice = z.strictObject({ id: z.string(), label: z.string() });
/** 200 from GET /api/appearance-options (no login): the values offered to a new character, per category. */
export const AppearanceOptionsResponse = z.strictObject({
  categories: z.strictObject(Object.fromEntries(APPEARANCE_CATEGORIES.map((c) => [c, z.array(Choice)])) as Record<AppearanceCategory, z.ZodArray<typeof Choice>>),
});
export type AppearanceOptionsResponse = z.infer<typeof AppearanceOptionsResponse>;
/** id + label per category, the shape of `AppearanceOptionsResponse.categories`. */
export type AppearanceLabels = AppearanceOptionsResponse['categories'];

/** The data set grouped per category in its order: the values offered now, or every value (`withHidden`, to build a sentence). */
export function appearanceLabels(options: readonly AppearanceOption[], withHidden = false): AppearanceLabels {
  const of = (category: AppearanceCategory) => options.filter((o) => o.category === category && (withHidden || !o.hidden)).map(({ id, label }) => ({ id, label }));
  return { hairColor: of('hairColor'), hairStyle: of('hairStyle'), eyes: of('eyes'), build: of('build'), outfit: of('outfit'), feature: of('feature') };
}

/** NFC, trimmed, every run of whitespace (line breaks included) one space. Plain text: tags are kept (escaped when shown). */
export const normalizeAppearanceExtra = (raw: string): string => raw.normalize('NFC').trim().replace(/\s+/gu, ' ');

/** The chip parts of the sentence: hair, eyes, build, outfit, feature (none = left out). ISK-008 matches each one alone. */
export function appearanceParts(traits: AppearanceTraits, labels: AppearanceLabels): string[] {
  const label = (c: AppearanceCategory) => labels[c].find((o) => o.id === traits[c])?.label ?? traits[c];
  return [
    traits.hairStyle === 'shaved' ? 'ศีรษะโกนเกลี้ยง' : `ผม${label('hairStyle')}สี${label('hairColor')}`,
    traits.eyes === 'heterochromia' ? 'ดวงตาสองสี' : `ดวงตาสี${label('eyes')}`,
    `รูปร่าง${label('build')}`,
    `สวม${label('outfit')}`,
    ...(traits.feature === 'none' ? [] : [`มี${label('feature')}`]),
  ];
}

/** The appearance sentence: the chip parts, then extra; one space between parts. */
export function composeAppearance(traits: AppearanceTraits, labels: AppearanceLabels): string {
  const extra = normalizeAppearanceExtra(traits.extra ?? '');
  return [...appearanceParts(traits, labels), ...(extra ? [extra] : [])].join(' ');
}
