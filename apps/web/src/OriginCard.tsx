import type { CharacterView, OriginKind, OriginView } from '@isekai/protocol';
import { useEffect, useId, useRef, useState } from 'react';
import { characterCall, originCall } from './game-api.ts';
import { FeedbackButton } from './ui/FeedbackDialog.tsx';
import { Button, Skeleton, VisibilityBadge } from './ui/index.ts';
import './pregame.css';

/** Rare starts say so in a word (never the odds); a standard start has no tag. */
const RARITY: Record<OriginKind, string | null> = { standard: null, special: 'หายาก', secret: 'ลับมาก' };

/**
 * The origin card (GEN-090, Screens and Flows v2 §4k): the start scenario the server rolled when the game
 * started (GEN-065), shown once on the way into Play, over the play room. Only its owner ever gets it.
 * It shows where you woke up, the private story of the crossing, what you start with and what the start
 * gives; Karma is a word, never a number. Nothing to show (before the start, or the Human GM) closes it.
 */
export function OriginCard({
  apiBaseUrl,
  token,
  onClose,
  onUnavailable = onClose,
}: {
  apiBaseUrl: string;
  token: string;
  /** The player read the card and pressed เริ่มเล่น. */
  onClose: () => void;
  /** There is no card to show now (not started, the Human GM, or the server did not answer): get out of the way of Play. */
  onUnavailable?: () => void;
}) {
  const titleId = useId();
  const [origin, setOrigin] = useState<OriginView>();
  const [character, setCharacter] = useState<CharacterView | null>(null);
  const actions = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([originCall(apiBaseUrl, token), characterCall(apiBaseUrl, token, 'GET')]).then(([o, c]) => {
      if (cancelled) return;
      // The card is an extra on the way in: it never stands between the player and the play room.
      if (o.kind !== 'ok' || !o.origin) return onUnavailable();
      setOrigin(o.origin);
      if (c.kind === 'ok') setCharacter(c.character);
    });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, token]);

  useEffect(() => {
    // Keyboard and screen-reader users land on the card's one action, not behind the veil.
    actions.current?.querySelector('button')?.focus();
  }, [origin]);

  const rarity = origin ? RARITY[origin.kind] : null;

  return (
    <div className="origin-veil">
      <FeedbackButton apiBaseUrl={apiBaseUrl} token={token} page="spawn" />
      <div
        className="origin-card panel--ornament"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <header className="origin-card__head">
          <span className="origin-card__private">
            <VisibilityBadge visibility="secret" /> เห็นคนเดียว
          </span>
          <h2 id={titleId} className="origin-card__title">
            จุดเกิดของคุณ
          </h2>
        </header>

        {!origin && <Skeleton lines={5} label="กำลังเปิดการ์ดจุดเกิด…" />}

        {origin && (
          <>
            <p className="origin-card__spawn">
              <span className="display">{origin.spawnLabel}</span>
              {rarity && <span className="origin-card__rarity">{rarity}</span>}
            </p>
            <p className="origin-card__place">
              {origin.location.name} · {origin.tierLabel}
            </p>
            <div className="origin-card__story">
              {origin.narration ? <p>{origin.narration}</p> : <p role="status">AI กำลังเขียนเรื่องการข้ามโลกของคุณ เปิดอ่านได้อีกครั้งในหน้าเล่น</p>}
            </div>
            <dl className="origin-card__facts">
              <div>
                <dt>ฉายาแรก</dt>
                <dd>{origin.initialTitle}</dd>
              </div>
              {character && (
                <div>
                  <dt>เริ่มด้วย</dt>
                  <dd>
                    HP {character.hp.current}/{character.hp.max} · แรง {character.stamina.current}/{character.stamina.max} · เหรียญ {character.coins}
                  </dd>
                </div>
              )}
              <div>
                <dt>ติดตัวจากจุดเกิด</dt>
                <dd>{origin.passive}</dd>
              </div>
              {origin.illness && (
                <div>
                  <dt>โรคเรื้อรัง</dt>
                  <dd>{origin.illness.treatmentsLeft > 0 ? `ต้องรักษาสำเร็จอีก ${origin.illness.treatmentsLeft} ครั้ง` : 'หายแล้ว'}</dd>
                </div>
              )}
              {character && (
                <div>
                  <dt>ความประพฤติตอนนี้</dt>
                  <dd>{character.conduct}</dd>
                </div>
              )}
            </dl>
          </>
        )}

        <div className="origin-card__actions" ref={actions}>
          <Button variant="primary" onClick={onClose}>
            เริ่มเล่น
          </Button>
        </div>
      </div>
    </div>
  );
}
