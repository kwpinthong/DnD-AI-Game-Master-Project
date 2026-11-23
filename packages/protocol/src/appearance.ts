import { z } from 'zod';

/** ISK-006: the chip categories of a character's appearance, in the order the sentence reads. */
export const APPEARANCE_CATEGORIES = ['hairColor', 'hairStyle', 'eyes', 'build', 'outfit', 'feature'] as const;
export type AppearanceCategory = (typeof APPEARANCE_CATEGORIES)[number];
export const APPEARANCE_EXTRA_MAX_LENGTH = 80;

export const AVATAR_IDS: readonly string[] = [];

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

export const AppearanceTraitsInput = z.object({});
export const AppearanceOption = z.strictObject({ category: z.enum(APPEARANCE_CATEGORIES), id: z.string(), label: z.string(), hidden: z.boolean().optional() });
export type AppearanceOption = z.infer<typeof AppearanceOption>;
export const AppearanceOptions = z.array(AppearanceOption);
export const AppearanceOptionsResponse = z.strictObject({});
export type AppearanceOptionsResponse = z.infer<typeof AppearanceOptionsResponse>;
export type AppearanceLabels = Record<AppearanceCategory, readonly { id: string; label: string }[]>;

export function normalizeAppearanceExtra(raw: string): string {
  return raw;
}

export function composeAppearance(traits: AppearanceTraits, labels: AppearanceLabels): string {
  void traits;
  void labels;
  return '';
}
