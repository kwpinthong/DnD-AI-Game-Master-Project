import type { LootOption, LootView } from '@isekai/protocol';
import { useEffect, useState, type FormEvent } from 'react';
import { lootCall, type LootAction } from './game-api.ts';

const BUFF_LABEL: Record<LootOption['buffType'], string> = {
  Qualitative: 'เชิงคุณภาพ',
  Quantitative: 'เชิงปริมาณ',
};

/** "name · Common · เชิงปริมาณ" — no numbers: players see words, the engine keeps the values. */
const summary = (o: LootOption) => `${o.name} · ${o.tier} · ${BUFF_LABEL[o.buffType]}`;

function quotaText(loot: LootView): string {
  if (loot.rerollLimit === null) return 'สุ่มใหม่ได้ไม่จำกัด';
  const left = loot.rerollLimit - loot.rerollsUsed;
  return left > 0 ? `สุ่มใหม่ได้อีก ${left} ครั้ง` : `สุ่มใหม่ครบ ${loot.rerollLimit} ครั้งแล้ว`;
}

/**
 * Character creation step 2 "ของติดตัว" (GDD §4.1, GEN-048): the AI reads the personality and
 * offers a strength, a weakness and up to 3 Common skills / items; the player keeps one of each.
 * Rerolls are unlimited (Q-029); the button is disabled only while a request runs or when the
 * server says the quota is used up. A failed AI call keeps the shown set and offers a retry (C5).
 * The kept set can be changed until the game starts (Q-081).
 */
export function LootStep({ apiBaseUrl, token, onSessionLost }: { apiBaseUrl: string; token: string; onSessionLost: () => void }) {
  /** undefined while loading. */
  const [loot, setLoot] = useState<LootView>();
  const [skillId, setSkillId] = useState<string>();
  const [itemId, setItemId] = useState<string>();
  const [error, setError] = useState<string>();
  /** The call to repeat from the error's retry button. */
  const [retry, setRetry] = useState<LootAction>();
  const [busy, setBusy] = useState(false);

  async function run(action: LootAction) {
    setBusy(true);
    setError(undefined);
    setRetry(undefined);
    const result = await lootCall(apiBaseUrl, token, action);
    setBusy(false);
    if (result.kind === 'session_lost') return onSessionLost();
    if (result.kind === 'error') {
      setError(result.message);
      if (action.kind !== 'choose') setRetry(action);
      return;
    }
    if (action.kind !== 'choose') {
      setSkillId(undefined);
      setItemId(undefined);
    }
    setLoot(result.loot);
  }

  useEffect(() => {
    void run({ kind: 'get' });
    // Loaded once per token.
  }, [apiBaseUrl, token]);

  function confirm(event: FormEvent) {
    event.preventDefault();
    const missing = [!skillId && 'กรุณาเลือก skill 1 อย่าง', !itemId && 'กรุณาเลือกไอเท็ม 1 อย่าง'].filter(Boolean);
    if (missing.length > 0) {
      setRetry(undefined);
      return setError(missing.join(' / '));
    }
    void run({ kind: 'choose', body: { skillIds: [skillId!], itemIds: [itemId!] } });
  }

  const errorBox = error && (
    <div>
      <p className="setup-error" role="alert">
        {error}
      </p>
      {retry && (
        <button type="button" disabled={busy} onClick={() => void run(retry)}>
          ลองใหม่
        </button>
      )}
    </div>
  );

  if (!loot) {
    return (
      <section aria-label="ของติดตัว">
        <h3>ของติดตัว</h3>
        {errorBox ?? <p>กำลังโหลดของติดตัว…</p>}
      </section>
    );
  }

  const kept = loot.chosen && (
    <ul aria-label="ของติดตัวที่เลือก">
      <li>จุดแข็ง: {loot.chosen.strength.label}</li>
      <li>จุดอ่อน: {loot.chosen.weakness.label}</li>
      <li>skill: {summary(loot.chosen.skill)}</li>
      <li>ไอเท็ม: {summary(loot.chosen.item)}</li>
    </ul>
  );

  // Q-081: a kept set can be changed until the game starts (reroll, then choose again).
  if (loot.chosen && !loot.offer) {
    return (
      <section aria-label="ของติดตัว">
        <h3>ของติดตัว</h3>
        {kept}
        {loot.canReroll ? (
          <button type="button" disabled={busy} onClick={() => void run({ kind: 'roll' })}>
            เปลี่ยนของติดตัว
          </button>
        ) : (
          <p role="status">เกมเริ่มแล้ว เปลี่ยนของติดตัวไม่ได้</p>
        )}
        {busy && <p role="status">AI กำลังวิเคราะห์…</p>}
        {errorBox}
      </section>
    );
  }

  if (!loot.offer) {
    return (
      <section aria-label="ของติดตัว">
        <h3>ของติดตัว</h3>
        <p>AI จะอ่านบุคลิก (ไม่มีใครเห็น) แล้วเสนอจุดแข็ง จุดอ่อน skill และไอเท็ม ระดับ Common</p>
        {loot.canReroll ? (
          <button type="button" disabled={busy} onClick={() => void run({ kind: 'roll' })}>
            ให้ AI วิเคราะห์บุคลิก
          </button>
        ) : (
          <p role="status">ยังไม่ได้เลือกของติดตัว และเลือกไม่ได้แล้ว</p>
        )}
        {busy && <p role="status">AI กำลังวิเคราะห์…</p>}
        {errorBox}
      </section>
    );
  }

  const { offer } = loot;
  const group = (kind: 'skill' | 'item', label: string, options: LootOption[], value: string | undefined, set: (id: string) => void) => (
    <fieldset role="radiogroup" aria-label={label}>
      <legend>{label}</legend>
      {options.map((o) => (
        <div key={o.id}>
          <label>
            <input type="radio" name={`loot-${kind}`} value={o.id} checked={value === o.id} onChange={() => set(o.id)} />
            {summary(o)} — {o.description}
          </label>
        </div>
      ))}
    </fieldset>
  );

  return (
    <section aria-label="ของติดตัว">
      <h3>ของติดตัว</h3>
      {kept && (
        <>
          <p>ของติดตัวตอนนี้ (ใช้ชุดนี้ต่อจนกว่าจะยืนยันชุดใหม่)</p>
          {kept}
        </>
      )}
      <form onSubmit={confirm} noValidate>
        <p>
          จุดแข็ง: {offer.strength.label} — {offer.strength.description}
        </p>
        <p>
          จุดอ่อน: {offer.weakness.label} — {offer.weakness.description}
        </p>
        {group('skill', 'เลือก skill 1 อย่าง', offer.skills, skillId, setSkillId)}
        {group('item', 'เลือกไอเท็ม 1 อย่าง', offer.items, itemId, setItemId)}
        <button type="button" disabled={busy || !loot.canReroll} onClick={() => void run({ kind: 'roll' })}>
          สุ่มใหม่
        </button>{' '}
        <small>{quotaText(loot)}</small>{' '}
        <button type="submit" disabled={busy}>
          ยืนยันของติดตัว
        </button>
        {busy && <p role="status">กำลังส่ง…</p>}
        {errorBox}
      </form>
    </section>
  );
}
