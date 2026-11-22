import type { LootOption, LootView } from '@isekai/protocol';
import { useEffect, useState, type FormEvent } from 'react';
import { lootCall, type LootAction } from './game-api.ts';
import { Button, Skeleton } from './ui/index.ts';
import './pregame.css';

/** The sheet's Trigger_Type in words. */
const TRIGGER_LABEL: Record<string, string> = {
  Active: 'กดใช้',
  Passive: 'ติดตัว',
  'Passive + Active': 'ติดตัว + กดใช้',
};

function useText(o: LootOption): string {
  const trigger = (o.triggerType && TRIGGER_LABEL[o.triggerType]) ?? o.triggerType ?? '';
  return o.dailyLimit > 0 ? `${trigger} (วันละ ${o.dailyLimit} ครั้ง)` : trigger;
}

/** "name · Rank B · กดใช้ (วันละ 3 ครั้ง)"; an old GEN-048 option (not in the sheet) says so. */
export const lootSummary = (o: LootOption) => (o.rank === null ? `${o.name} · ของเดิม (Common)` : `${o.name} · Rank ${o.rank} · ${useText(o)}`);

function quotaText(loot: LootView): string {
  if (loot.rerollLimit === null) return 'สุ่มใหม่ได้ไม่จำกัด';
  const left = loot.rerollLimit - loot.rerollsUsed;
  return left > 0 ? `สุ่มใหม่ได้อีก ${left} ครั้ง` : `สุ่มใหม่ครบ ${loot.rerollLimit} ครั้งแล้ว`;
}

const ANALYSING = 'AI กำลังอ่านบุคลิกของคุณ…';

/** While the AI works (C3): the words, plus placeholder cards where the offer will be. */
function Analysing() {
  return (
    <div className="loot-wait">
      <p role="status">{ANALYSING}</p>
      <div className="loot-wait__cards" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className="loot-wait__card skeleton__line" />
        ))}
      </div>
    </div>
  );
}

/**
 * Character creation step 2 "ของติดตัว" (GDD §4.1, GEN-048, GEN-073; v2 look GEN-090): the AI reads the
 * personality and offers a strength, a weakness and up to 3 Rank B skills / items from the Asset sheet; the
 * player keeps one of each. A kept set from before the sheet (Common) must be chosen again.
 * Rerolls are unlimited (Q-029). While a request runs the buttons are off and say so, so nothing is sent
 * twice (C3). A failed AI call keeps the shown set and offers a retry. The kept set can be changed until
 * the game starts (Q-081). `onLoot` tells the page around it what is kept now.
 */
export function LootStep({
  apiBaseUrl,
  token,
  onSessionLost,
  onLoot,
}: {
  apiBaseUrl: string;
  token: string;
  onSessionLost: () => void;
  onLoot?: (loot: LootView) => void;
}) {
  /** undefined while loading. */
  const [loot, setLoot] = useState<LootView>();
  const [skillId, setSkillId] = useState<string>();
  const [itemId, setItemId] = useState<string>();
  const [error, setError] = useState<string>();
  /** The call to repeat from the error's retry button. */
  const [retry, setRetry] = useState<LootAction>();
  /** The kind of call running now; undefined when idle. */
  const [running, setRunning] = useState<LootAction['kind']>();
  const busy = running !== undefined;
  const rolling = running === 'roll';

  async function run(action: LootAction) {
    if (busy) return;
    setRunning(action.kind);
    setError(undefined);
    setRetry(undefined);
    const result = await lootCall(apiBaseUrl, token, action);
    setRunning(undefined);
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
    onLoot?.(result.loot);
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
    <div className="loot__error">
      <p className="field-error" role="alert">
        {error}
      </p>
      {retry && (
        <Button disabled={busy} onClick={() => void run(retry)}>
          ลองใหม่
        </Button>
      )}
    </div>
  );

  if (!loot) {
    return (
      <section className="loot" aria-label="ของติดตัว">
        <h3>ของติดตัว</h3>
        {errorBox || <Skeleton lines={3} label="กำลังโหลดของติดตัว…" />}
      </section>
    );
  }

  const kept = loot.chosen && (
    <ul aria-label="ของติดตัวที่เลือก" className="loot__kept">
      <li>จุดแข็ง: {loot.chosen.strength.label}</li>
      <li>จุดอ่อน: {loot.chosen.weakness.label}</li>
      <li>skill: {lootSummary(loot.chosen.skill)}</li>
      <li>ไอเท็ม: {lootSummary(loot.chosen.item)}</li>
    </ul>
  );

  // Q-081: a kept set can be changed until the game starts (reroll, then choose again).
  if (loot.chosen && !loot.offer) {
    return (
      <section className="loot" aria-label="ของติดตัว">
        <h3>ของติดตัว</h3>
        {kept}
        {loot.canReroll ? (
          <Button loading={rolling} loadingText="กำลังวิเคราะห์…" disabled={busy} onClick={() => void run({ kind: 'roll' })}>
            เปลี่ยนของติดตัว
          </Button>
        ) : (
          <p role="status">เกมเริ่มแล้ว เปลี่ยนของติดตัวไม่ได้</p>
        )}
        {rolling && <Analysing />}
        {errorBox}
      </section>
    );
  }

  if (!loot.offer) {
    return (
      <section className="loot" aria-label="ของติดตัว">
        <h3>ของติดตัว</h3>
        {loot.needsNewChoice && (
          <p className="field-error" role="alert">
            ของติดตัวชุดเดิม (Common) ใช้ไม่ได้แล้ว กรุณาเลือกใหม่ก่อนเกมเริ่ม
          </p>
        )}
        <p>AI จะอ่านบุคลิก (ไม่มีใครเห็น) แล้วเสนอจุดแข็ง จุดอ่อน skill และไอเท็ม Rank B ที่เข้ากับบุคลิก</p>
        {loot.canReroll ? (
          <Button variant="primary" loading={rolling} loadingText="กำลังวิเคราะห์…" disabled={busy} onClick={() => void run({ kind: 'roll' })}>
            ให้ AI วิเคราะห์บุคลิก
          </Button>
        ) : (
          <p role="status">ยังไม่ได้เลือกของติดตัว และเลือกไม่ได้แล้ว</p>
        )}
        {rolling && <Analysing />}
        {errorBox}
      </section>
    );
  }

  const { offer } = loot;
  const group = (kind: 'skill' | 'item', label: string, options: LootOption[], value: string | undefined, set: (id: string) => void) => (
    <fieldset role="radiogroup" aria-label={label} className="loot__group">
      <legend>{label}</legend>
      {options.map((o) => (
        <label key={o.id} className="choice">
          <input type="radio" name={`loot-${kind}`} value={o.id} checked={value === o.id} onChange={() => set(o.id)} />
          <span className="choice__body">
            <span className="choice__title">{lootSummary(o)}</span>
            <span className="choice__text"> — {o.description}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );

  return (
    <section className="loot" aria-label="ของติดตัว">
      <h3>ของติดตัว</h3>
      {kept && (
        <>
          <p>ของติดตัวตอนนี้ (ใช้ชุดนี้ต่อจนกว่าจะยืนยันชุดใหม่)</p>
          {kept}
        </>
      )}
      <form onSubmit={confirm} noValidate>
        <div className="loot__traits">
          <p>
            จุดแข็ง: {offer.strength.label} — {offer.strength.description}
          </p>
          <p>
            จุดอ่อน: {offer.weakness.label} — {offer.weakness.description}
          </p>
        </div>
        {group('skill', 'เลือก skill 1 อย่าง', offer.skills, skillId, setSkillId)}
        {group('item', 'เลือกไอเท็ม 1 อย่าง', offer.items, itemId, setItemId)}
        <div className="loot__actions">
          <Button loading={rolling} loadingText="กำลังวิเคราะห์…" disabled={busy || !loot.canReroll} onClick={() => void run({ kind: 'roll' })}>
            สุ่มใหม่
          </Button>
          <small>{quotaText(loot)}</small>
          <Button type="submit" variant="primary" loading={running === 'choose'} loadingText="กำลังบันทึก…" disabled={busy}>
            ยืนยันของติดตัว
          </Button>
        </div>
        {rolling && <Analysing />}
        {errorBox}
      </form>
    </section>
  );
}
