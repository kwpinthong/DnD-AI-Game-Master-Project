import { formatInviteCode, type GameMember, type GameView } from '@isekai/protocol';
import { useEffect, useState } from 'react';
import { gameCall, type GameAction } from './game-api.ts';

const modeLabel = { online: 'Online', single: 'เล่นคนเดียว' } as const;

function memberStatus(m: GameMember): string {
  if (m.role === 'gm') return 'GM (ไม่มีตัวละคร)';
  return m.hasCharacter ? 'สร้างตัวละครแล้ว' : 'ยังไม่สร้างตัวละคร';
}

/**
 * Lobby (GEN-044 wireframe 2c): invite code, members, and the owner's kick / new code / start.
 * No realtime yet (GEN-056): the list reloads on [ รีเฟรช ] and after every owner action.
 */
export function Lobby({
  apiBaseUrl,
  token,
  initial,
  onSessionLost,
}: {
  apiBaseUrl: string;
  token: string;
  initial?: GameView;
  onSessionLost: () => void;
}) {
  const [game, setGame] = useState<GameView | undefined>(initial);
  const [error, setError] = useState<{ message: string; reasons?: string[] }>();
  const [busy, setBusy] = useState(false);

  async function run(action: GameAction) {
    setBusy(true);
    const result = await gameCall(apiBaseUrl, token, action);
    setBusy(false);
    if (result.kind === 'session_lost') return onSessionLost();
    if (result.kind === 'error') return setError({ message: result.message, ...(result.reasons ? { reasons: result.reasons } : {}) });
    setError(undefined);
    setGame(result.game);
  }

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    void gameCall(apiBaseUrl, token, { method: 'GET', path: '/api/game' }).then((result) => {
      if (cancelled) return;
      if (result.kind === 'session_lost') onSessionLost();
      else if (result.kind === 'error') setError({ message: result.message });
      else setGame(result.game);
    });
    return () => {
      cancelled = true;
    };
    // Loaded once per token; later loads come from [ รีเฟรช ] and the owner actions.
  }, [apiBaseUrl, token]);

  if (!game) {
    return error ? (
      <p role="alert">โหลดห้องรอไม่ได้: {error.message}</p>
    ) : (
      <p>กำลังโหลดห้องรอ…</p>
    );
  }

  const owner = game.you.isOwner;
  const lobby = game.status === 'lobby';

  return (
    <section className="lobby" aria-label="ห้องรอ">
      <h2>
        {game.name} · {modeLabel[game.mode]} · {game.humanGm ? 'GM คน' : 'AI GM'}
      </h2>
      <p>
        โค้ดเกม <strong>{formatInviteCode(game.inviteCode)}</strong>
        {owner && lobby && (
          <>
            {' '}
            <button type="button" disabled={busy} onClick={() => run({ method: 'POST', path: '/api/game/invite-code' })}>
              ออกโค้ดใหม่
            </button>{' '}
            <small>(โค้ดเก่าใช้ไม่ได้ทันที สมาชิกเดิมเข้าด้วยโค้ดใหม่ + ชื่อ + PIN เดิม)</small>
          </>
        )}
      </p>
      {!lobby && <p role="status">เกมเริ่มแล้ว โหมดและสมาชิกล็อกแล้ว</p>}
      <p>
        ผู้เล่น {game.players.count}/{game.players.max}
      </p>
      <ul aria-label="สมาชิก">
        {game.members.map((m) => (
          <li key={m.id}>
            {m.name} — {memberStatus(m)}
            {m.isOwner && ' (เจ้าของเกม)'}
            {m.id === game.you.memberId && ' (คุณ)'}
            {owner && lobby && m.id !== game.you.memberId && (
              <>
                {' '}
                <button
                  type="button"
                  aria-label={`เตะ ${m.name}`}
                  disabled={busy}
                  onClick={() => run({ method: 'DELETE', path: `/api/game/members/${encodeURIComponent(m.id)}` })}
                >
                  เตะ
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {owner && lobby && (
        <>
          {game.startBlockers.length > 0 && (
            <div>
              <p>ยังเริ่มเกมไม่ได้:</p>
              <ul aria-label="เหตุผลที่ยังเริ่มไม่ได้">
                {game.startBlockers.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
          <button
            type="button"
            disabled={busy || game.startBlockers.length > 0}
            onClick={() => run({ method: 'POST', path: '/api/game/start' })}
          >
            เริ่มเกม
          </button>
        </>
      )}{' '}
      <button type="button" disabled={busy} onClick={() => run({ method: 'GET', path: '/api/game' })}>
        รีเฟรช
      </button>
      {error && (
        <div role="alert">
          <p>{error.message}</p>
          {error.reasons && (
            <ul>
              {error.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
