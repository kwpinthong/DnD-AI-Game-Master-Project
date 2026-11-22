import { z } from 'zod';

/** Longest values, counted in Unicode code points after normalisation (Thai marks count). */
export const CHARACTER_NAME_MAX_LENGTH = 40;
export const APPEARANCE_MAX_LENGTH = 500;
export const PERSONALITY_MAX_LENGTH = 1000;

/**
 * NFC like action text (GEN-094, Q-108). Not NFKC: NFKC splits Thai sara am (ำ U+0E33) into nikhahit +
 * sara aa, so "คำแก้ว" would be stored and shown as a different string and count one character longer.
 * Free text keeps its line breaks; only the outer whitespace goes.
 */
const normalizeText = (raw: string) => raw.normalize('NFC').trim();

/** The character's real name: NFC, trimmed, runs of whitespace folded to one space. */
const normalizeCharacterName = (raw: string) => normalizeText(raw).replace(/\s+/gu, ' ');

function text(normalize: (raw: string) => string, max: number, empty: string, tooLong: string) {
  return z
    .string({ error: empty })
    .transform(normalize)
    .pipe(
      z
        .string()
        .min(1, empty)
        .refine((value) => [...value].length <= max, tooLong),
    );
}

/**
 * Body of POST (create) and PUT (edit) /api/game/character: the identity step of character
 * creation (GDD §2). Anything else the client sends (hp, stamina, karma, ...) is stripped:
 * the stats start at the server's values and only the engine changes them.
 */
export const CharacterRequest = z.object({
  name: text(
    normalizeCharacterName,
    CHARACTER_NAME_MAX_LENGTH,
    'กรุณาใส่ชื่อจริงของตัวละคร',
    `ชื่อจริงยาวได้ไม่เกิน ${CHARACTER_NAME_MAX_LENGTH} ตัวอักษร`,
  ),
  appearance: text(
    normalizeText,
    APPEARANCE_MAX_LENGTH,
    'กรุณาใส่ลักษณะภายนอก',
    `ลักษณะภายนอกยาวได้ไม่เกิน ${APPEARANCE_MAX_LENGTH} ตัวอักษร`,
  ),
  personality: text(
    normalizeText,
    PERSONALITY_MAX_LENGTH,
    'กรุณาใส่บุคลิก',
    `บุคลิกยาวได้ไม่เกิน ${PERSONALITY_MAX_LENGTH} ตัวอักษร`,
  ),
});
export type CharacterRequest = z.infer<typeof CharacterRequest>;
export type CharacterField = keyof z.input<typeof CharacterRequest>;

/** First message per wrong field; empty object when the input is valid. */
export function characterFieldErrors(input: unknown): Partial<Record<CharacterField, string>> {
  const result = CharacterRequest.safeParse(input ?? {});
  if (result.success) return {};
  const errors: Partial<Record<CharacterField, string>> = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0] as CharacterField | undefined;
    if (field && !errors[field]) errors[field] = issue.message;
  }
  return errors;
}

const Gauge = z.strictObject({ current: z.number().int(), max: z.number().int() });

/**
 * The player's own character as the player sees it. Strict on purpose: Karma and the Reputation
 * number are server-only (GM console), the player gets the Social Title instead.
 */
export const CharacterView = z.strictObject({
  name: z.string(),
  appearance: z.string(),
  personality: z.string(),
  hp: Gauge,
  stamina: Gauge,
  /** Coins the character holds (the start scenario's Start_Coins, GEN-065; 0 before the game starts). */
  coins: z.number().int(),
  /**
   * The title for the current Reputation (Rules Spec Social Title), e.g. "คนแปลกหน้า". From the start the
   * start scenario's Initial_Title stands while Reputation is still in the starting band (GEN-065).
   */
  socialTitle: z.string(),
  /**
   * The adjective for your own Karma band (GEN-067, sheet "Karma Tiers"), e.g. "เป็นกลางสุดๆ". Only the
   * owner gets it (Q-091); never the number, and never another player's.
   */
  conduct: z.string(),
  /** Name, appearance and personality can change until the game starts. */
  editable: z.boolean(),
});
export type CharacterView = z.infer<typeof CharacterView>;

/** 200 from GET, 201 from POST, 200 from PUT /api/game/character. `null` = not created yet. */
export const CharacterResponse = z.strictObject({ character: CharacterView.nullable() });
export type CharacterResponse = z.infer<typeof CharacterResponse>;
