import {
  APPEARANCE_CATEGORIES,
  APPEARANCE_EXTRA_MAX_LENGTH,
  AVATAR_PRESETS,
  composeAppearance,
  type AppearanceCategory,
  type AppearanceLabels,
  type AppearanceTraits,
} from '@isekai/protocol';
import type { KeyboardEvent } from 'react';
import type { LooksField } from './game-api.ts';
import { Avatar } from './play/chat/Bubbles.tsx';
import { avatarArt } from './play/ring-art.ts';
import { Button, ErrorState, Field, Skeleton, VisibilityBadge } from './ui/index.ts';

/** ISK-007: what the player has picked so far (nothing yet = null / missing key). */
export interface Looks {
  avatarId: string | null;
  traits: Partial<Record<AppearanceCategory, string>>;
  extra: string;
}
export const NO_LOOKS: Looks = { avatarId: null, traits: {}, extra: '' };

/** The chip list of GET /api/appearance-options as the page holds it. */
export type LooksOptions = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; labels: AppearanceLabels };

export const CATEGORY_WORD: Record<AppearanceCategory, string> = { hairColor: 'สีผม', hairStyle: 'ทรงผม', eyes: 'ดวงตา', build: 'รูปร่าง', outfit: 'ชุด', feature: 'จุดเด่น' };
const AVATAR_WORD = 'รูป avatar';

/** Picking an avatar puts its default chip in every category (over what was there) and leaves the free text alone. */
export function withAvatar(looks: Looks, avatarId: string): Looks {
  const preset = AVATAR_PRESETS.find((p) => p.id === avatarId);
  if (!preset) return looks;
  return { ...looks, avatarId, traits: Object.fromEntries(APPEARANCE_CATEGORIES.map((c) => [c, preset[c]])) };
}

const pick = <T,>(list: readonly T[], random: () => number): T => list[Math.floor(random() * list.length)]!;

/** [สุ่ม]: any avatar and any offered chip per category; the free text stays. */
export function randomLooks(looks: Looks, labels: AppearanceLabels, random: () => number = Math.random): Looks {
  return {
    ...looks,
    avatarId: pick(AVATAR_PRESETS, random).id,
    traits: Object.fromEntries(APPEARANCE_CATEGORIES.map((c) => [c, pick(labels[c], random).id])),
  };
}

/** The words of every part not chosen yet; a chip that is not offered (any more) counts as not chosen once the list is in. */
export function missingLooks(looks: Looks, labels: AppearanceLabels | undefined): string[] {
  const missing = looks.avatarId && AVATAR_PRESETS.some((p) => p.id === looks.avatarId) ? [] : [AVATAR_WORD];
  for (const c of APPEARANCE_CATEGORIES) {
    const id = looks.traits[c];
    if (!id || (labels && !labels[c].some((o) => o.id === id))) missing.push(CATEGORY_WORD[c]);
  }
  return missing;
}

/** Every chip picked (and offered): the traits the server takes; otherwise null. */
export function completeTraits(looks: Looks, labels: AppearanceLabels | undefined): AppearanceTraits | null {
  if (missingLooks(looks, labels).some((w) => w !== AVATAR_WORD)) return null;
  const extra = looks.extra.trim();
  return { ...(looks.traits as Record<AppearanceCategory, string>), ...(extra ? { extra } : {}) };
}

/** The sentence the server will store for these looks (composeAppearance), or null while a chip is missing / the list loads. */
export function looksSentence(looks: Looks, labels: AppearanceLabels | undefined): string | null {
  const traits = completeTraits(looks, labels);
  return labels && traits ? composeAppearance(traits, labels) : null;
}

/** Code points, the unit the server counts. */
const clip = (value: string) => [...value].slice(0, APPEARANCE_EXTRA_MAX_LENGTH).join('');

/** Arrow keys move between the buttons of one group (Tab still goes through each; Enter / Space press the native button). */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
  if (step === 0) return;
  const buttons = [...event.currentTarget.querySelectorAll('button')];
  const at = buttons.indexOf(event.target as HTMLButtonElement);
  if (at < 0) return;
  event.preventDefault();
  buttons[(at + step + buttons.length) % buttons.length]!.focus();
}

/**
 * ISK-007: the looks part of the identity step. 12 preset avatars (pick one), the 6 chip categories of
 * GET /api/appearance-options (one each, aria-pressed), a short free text, [สุ่ม], and the sentence the server will
 * store (composeAppearance) shown live beside the chosen avatar in the player ring. `errors`: the server's 400s, at
 * the part they name.
 */
export function AppearancePicker({
  looks,
  options,
  errors,
  onChange,
  onRetry,
}: {
  looks: Looks;
  options: LooksOptions;
  errors: Partial<Record<LooksField, string>>;
  onChange: (next: Looks, field: LooksField) => void;
  onRetry: () => void;
}) {
  const labels = options.kind === 'ok' ? options.labels : undefined;
  const sentence = looksSentence(looks, labels);
  const error = (field: LooksField) =>
    errors[field] ? (
      <p className="field-error looks__error" role="alert">
        {errors[field]}
      </p>
    ) : null;

  return (
    <div className="looks">
      <div className="looks__head">
        <h3 className="looks__title">
          ลักษณะภายนอก <VisibilityBadge visibility="public" />
        </h3>
        <Button disabled={!labels} disabledReason="รอตัวเลือกหน้าตาโหลดก่อน" onClick={() => labels && onChange(randomLooks(looks, labels), 'avatar')}>
          สุ่ม
        </Button>
      </div>
      <p className="pregame__note">ทุกคนเห็น ใช้เรียกคุณแทนชื่อ เลือกรูปแล้วชิปทุกหมวดจะเป็นค่าของรูปนั้น แก้ต่อได้</p>

      <div role="group" aria-label="ตัวอย่างลักษณะภายนอก" className="looks__preview">
        <Avatar name="?" avatarId={looks.avatarId} own size="lg" />
        <p className="looks__sentence">{sentence ?? 'เลือกรูปและชิปให้ครบทุกหมวด แล้วประโยคที่คนอื่นเห็นจะขึ้นที่นี่'}</p>
      </div>

      <div role="group" aria-label="รูปตัวละคร" className="looks__group" onKeyDown={moveFocus}>
        <p className="looks__label">รูปตัวละคร</p>
        <div className="looks__avatars">
          {AVATAR_PRESETS.map((p) => {
            const art = avatarArt(p.id);
            return (
              <button key={p.id} type="button" className="looks__avatar" aria-pressed={looks.avatarId === p.id} onClick={() => onChange(withAvatar(looks, p.id), 'avatar')}>
                <img src={art?.src} srcSet={art?.srcSet} alt={p.alt} width={80} height={80} />
              </button>
            );
          })}
        </div>
        {error('avatar')}
      </div>

      {options.kind === 'loading' && <Skeleton lines={3} label="กำลังโหลดตัวเลือกหน้าตา…" />}
      {options.kind === 'error' && (
        <>
          <ErrorState message={`โหลดตัวเลือกหน้าตาไม่ได้: ${options.message}`} />
          <Button onClick={onRetry}>ลองใหม่</Button>
        </>
      )}
      {labels &&
        APPEARANCE_CATEGORIES.map((c) => (
          <div key={c} role="group" aria-label={CATEGORY_WORD[c]} className="looks__group" onKeyDown={moveFocus}>
            <p className="looks__label">{CATEGORY_WORD[c]}</p>
            <div className="looks__chips">
              {labels[c].map((o) => (
                <button key={o.id} type="button" className="looks__chip" aria-pressed={looks.traits[c] === o.id} onClick={() => onChange({ ...looks, traits: { ...looks.traits, [c]: o.id } }, c)}>
                  {o.label}
                </button>
              ))}
            </div>
            {error(c)}
          </div>
        ))}

      <Field id="character-extra" label="รายละเอียดเพิ่มเติม" hint="ไม่บังคับ เช่น ถือย่ามผ้า" note={`${[...looks.extra].length}/${APPEARANCE_EXTRA_MAX_LENGTH}`} error={errors.extra}>
        {(control) => <input {...control} name="extra" autoComplete="off" value={looks.extra} onChange={(e) => onChange({ ...looks, extra: clip(e.target.value) }, 'extra')} />}
      </Field>
    </div>
  );
}
