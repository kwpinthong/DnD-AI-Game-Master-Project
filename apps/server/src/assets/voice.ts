/**
 * GEN-176 (from the GEN-166 style guide, Nok Q-330..Q-334): the Thai style guide, the forbidden phrases and each
 * NPC's speech profile, as one JSON object (apps/server/assets/voice.json, the Voice data set; edited from /admin
 * like the others, GEN-147). Profiles go into prompts that name NPCs by token only, so no text in `npcs` may hold an
 * NPC's real name (checked in buildGameAssets against the NPC set). Only "ทำการ" and emoji / markdown are `block`
 * rules (Q-334); every other rule is a flag.
 */
import { defaultScenario, GameTone } from '@isekai/protocol';
import { z } from 'zod';

export const VOICE_FILE = 'voice.json';

/** Flags every ForbiddenRule regex is compiled with (the emoji rule needs `u`; `^#` a line start). */
export const VOICE_REGEX_FLAGS = 'mu';

const Match = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('literal'), value: z.string().min(1).max(40) }),
  z.strictObject({
    type: z.literal('regex'),
    value: z
      .string()
      .min(1)
      .max(120)
      .refine((v) => {
        try {
          new RegExp(v, VOICE_REGEX_FLAGS);
          return true;
        } catch {
          return false;
        }
      }, 'regex นี้ compile ไม่ได้'),
  }),
  z.strictObject({ type: z.literal('density'), words: z.array(z.string().min(1)).min(1).max(8), max: z.number().int().min(1), perSentences: z.number().int().min(1) }),
]);

export const ForbiddenRule = z.strictObject({
  id: z.string().regex(/^[a-z0-9_]{1,32}$/),
  match: Match,
  scope: z.enum(['narration', 'dialogue', 'all']),
  /** flag = logged for the admin (GEN-169); block = the AI rewrites once. */
  severity: z.enum(['flag', 'block']),
  /** The hint a prompt shows for this rule. */
  fix: z.string().max(120),
});
export type ForbiddenRule = z.infer<typeof ForbiddenRule>;

const Register = z.enum(['child_polite', 'flat', 'polite', 'curt', 'street', 'merchant', 'formal', 'sweet_priest', 'scholarly', 'archaic_divine', 'whisper_mock', 'chronicle']);

const NpcVoiceBase = z.strictObject({
  register: Register,
  /** [] = drops the subject. */
  self: z.array(z.string().max(12)).max(3),
  /** friendly / wary by bond. */
  you: z.strictObject({ default: z.string().max(16), friendly: z.string().max(16).optional(), wary: z.string().max(16).optional() }),
  particles: z.array(z.string().max(12)).max(5),
  catchphrases: z.array(z.string().max(60)).max(3),
  never: z.array(z.string().max(60)).max(5),
  /** Words the checker can find for `never` and a mixed register. */
  neverWords: z.array(z.string().max(20)).max(10).default([]),
  note: z.string().max(160),
});

export const NpcVoice = NpcVoiceBase.extend({
  /** Q-333: the SS drafts, by 'ss' | 'ss_good' | 'ss_evil'; a field left out = the main profile's. */
  forms: z.record(z.string().regex(/^ss(_good|_evil)?$/), NpcVoiceBase.partial()).optional(),
});
export type NpcVoice = z.infer<typeof NpcVoice>;
export type NpcSpeech = z.infer<typeof NpcVoiceBase>;
export type VoiceForm = 'ss' | 'ss_good' | 'ss_evil';

/** GEN-193: the SS form an NPC's evolution for one player (its npc_bond row) puts it in; null = its normal form. */
export function voiceFormOf(bond: { evolvedGrade: 'S' | 'SS' | null; evolvedAlignment: 'Good' | 'Evil' | 'Neutral' | null } | undefined): VoiceForm | null {
  if (bond?.evolvedGrade !== 'SS') return null;
  return bond.evolvedAlignment === 'Good' ? 'ss_good' : bond.evolvedAlignment === 'Evil' ? 'ss_evil' : 'ss';
}

/** The profile an NPC speaks with in `form`: the form's fields over the main's (a missing ss_good / ss_evil = its plain ss). */
export function voiceProfile(voice: { npcs: Record<string, NpcVoice> }, npcId: string, form: VoiceForm | null): NpcSpeech | undefined {
  const profile = voice.npcs[npcId];
  if (!profile) return undefined;
  const { forms, ...main } = profile;
  const over = form === null ? undefined : (forms?.[form] ?? forms?.ss);
  return { ...main, ...Object.fromEntries(Object.entries(over ?? {}).filter(([, v]) => v !== undefined)) };
}

const npcIds = () => new Set(defaultScenario().npcs.map((n) => n.id));

/** GEN-177: one tone of the GEN-166 section 0 (the same scene told three ways). NPC profiles are the same in every tone. */
const ToneBlock = z.strictObject({ name: z.string().min(1).max(60), description: z.string().min(1).max(200), samples: z.array(z.string().min(1).max(300)).min(1).max(3) });
export type ToneBlock = z.infer<typeof ToneBlock>;

/** A Voice row saved before GEN-177 has no `tones`: these (= voice.json) fill it in, so the server still starts. */
const DEFAULT_TONES: Record<GameTone, ToneBlock> = {
  A: {
    name: 'นิยายแฟนตาซีร่วมสมัย',
    description: 'ภาษาเขียนกลางๆ กระชับ เห็นภาพ มีอารมณ์ขันได้นิดในบทพูด NPC',
    samples: ['แสงสุดท้ายของ HESPERION ทาบลงบนขอบน้ำพุ คุณยื่นขนมปังให้เด็กขอทาน มือผอมสั่นรับไว้ ก่อนแบ่งครึ่งคืนให้คุณอย่างลังเล'],
  },
  B: {
    name: 'ตำนานโบราณ ภาษาสูง',
    description: 'คำสูง ประโยคยาว จังหวะแบบพงศาวดาร',
    samples: ['ยามสนธยาแห่ง HESPERION ทอแสงทองลงเหนือธารน้ำพุ ท่านยื่นขนมปังแก่เด็กยากไร้ มือน้อยอันสั่นเทารับไว้ด้วยความเกรงใจยิ่ง'],
  },
  C: {
    name: 'ขี้เล่น เป็นกันเอง',
    description: 'ภาษาพูด มีมุก ประโยคสั้นมาก',
    samples: ['ฟ้าเริ่มส้มแล้ว คุณยื่นขนมปังให้เด็กขอทานตรงน้ำพุ เจ้าหนูรับไปงงๆ แล้วแบ่งคืนครึ่งนึง ใจดีเกินตัวไปไหมเนี่ย'],
  },
};

export const VoiceAsset = z.strictObject({
  version: z.number().int().min(1),
  /** The tone of a new game created without one (GEN-177: set from /admin). */
  tone: GameTone,
  tones: z.strictObject({ A: ToneBlock, B: ToneBlock, C: ToneBlock }).default(DEFAULT_TONES),
  guide: z.strictObject({ voice: z.string().max(400), register: z.string().max(300), length: z.string().max(200), use: z.array(z.string().max(80)).max(10) }),
  forbidden: z.array(ForbiddenRule).max(40),
  pairs: z.array(z.strictObject({ bad: z.string().max(120), good: z.string().max(120) })).max(15),
  /** Key = ScenarioNpc.id (prompts name NPCs by `{{n:id}}`). */
  npcs: z.record(z.string(), NpcVoice).superRefine((npcs, ctx) => {
    const ids = npcIds();
    for (const id of Object.keys(npcs)) if (!ids.has(id)) ctx.addIssue({ code: 'custom', path: [id], message: `ไม่มี NPC id ${id} ใน scenario` });
  }),
});
export type VoiceAsset = z.infer<typeof VoiceAsset>;

/** Every string in a profile, with its field path under `npcs.<id>` ("note", "forms.ss.self[0]"). */
function* stringsOf(value: unknown, path: string): Generator<[string, string]> {
  if (typeof value === 'string') yield [path, value];
  else if (Array.isArray(value)) for (const [i, v] of value.entries()) yield* stringsOf(v, `${path}[${i}]`);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) yield* stringsOf(v, path ? `${path}.${k}` : k);
}

/** Field path → problem for each profile text that holds one of `names` (the name itself is never echoed). */
export function realNamesInProfiles(voice: VoiceAsset, names: readonly string[]): Record<string, string> {
  const long = names.filter((n) => n.length > 2);
  const out: Record<string, string> = {};
  for (const [id, profile] of Object.entries(voice.npcs)) {
    for (const [path, text] of stringsOf(profile, '')) {
      if (long.some((n) => text.includes(n))) out[`npcs.${id}.${path}`] = 'มีชื่อจริงของ NPC (profile เข้า prompt ที่ใช้ token แทนชื่อ)';
    }
  }
  return out;
}
