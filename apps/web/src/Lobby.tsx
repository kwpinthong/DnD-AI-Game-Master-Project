import { formatInviteCode, type GameMember, type GameView } from '@isekai/protocol';
import { useEffect, useRef, useState } from 'react';
import { CharacterScreen } from './CharacterScreen.tsx';
import { deleteGameCall, gameCall, type GameAction } from './game-api.ts';
import { NpcDialoguePicker } from './NpcDialoguePicker.tsx';
import { npcDialogueText } from './ui/strings.ts';
import { OriginCard } from './OriginCard.tsx';
import { PlayRoom } from './PlayRoom.tsx';
import { ScenarioEditor } from './ScenarioEditor.tsx';
import { Button, Panel, Skeleton, Toast } from './ui/index.ts';
import './pregame.css';

const modeLabel = { online: 'Online', single: 'เล่นคนเดียว' } as const;

function memberStatus(m: GameMember): string {
  if (m.role === 'gm') return 'GM (ไม่มีตัวละคร)';
  return m.hasCharacter ? 'สร้างตัวละครแล้ว' : 'ยังไม่สร้างตัวละคร';
}

/** Whether this member has closed their origin card on this device (shown once, on the way into Play). */
const originSeenKey = (game: GameView) => `isekai.originSeen.${game.id}.${game.you.memberId}`;
function originSeen(game: GameView): boolean {
  try {
    return localStorage.getItem(originSeenKey(game)) === '1';
  } catch {
    return true;
  }
}
function rememberOriginSeen(game: GameView): void {
  try {
    localStorage.setItem(originSeenKey(game), '1');
  } catch {
    // no storage: the card shows again next time, nothing else breaks
  }
}

/** GEN-112: the owner deletes the game for everyone, apart from "leave"; the game name must be typed first. */
function DeleteGame({ apiBaseUrl, token, gameName, onDeleted }: { apiBaseUrl: string; token: string; gameName: string; onDeleted: () => void }) {
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  if (!asking) {
    return (
      <Button variant="danger" onClick={() => setAsking(true)}>
        ลบเกม
      </Button>
    );
  }
  async function confirm() {
    setBusy(true);
    const result = await deleteGameCall(apiBaseUrl, token, typed);
    setBusy(false);
    if (result.ok) onDeleted();
    else setProblem(result.message);
  }
  return (
    <div role="group" aria-label="ยืนยันลบเกม">
      <p>ลบเกมนี้ถาวร ทุกคนในเกมจะเข้าไม่ได้ และกู้คืนไม่ได้ (ถ้าแค่พักเล่น ให้กด "ออกจากเกม")</p>
      <label>
        พิมพ์ชื่อเกมเพื่อยืนยัน
        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={gameName} />
      </label>
      <Button variant="danger" disabled={busy || typed !== gameName} onClick={() => void confirm()}>
        ยืนยันลบเกม
      </Button>
      <Button disabled={busy} onClick={() => setAsking(false)}>
        ยกเลิก
      </Button>
      {problem && <p role="alert">{problem}</p>}
    </div>
  );
}

/**
 * Lobby v2 (GEN-090, Screens and Flows v2 §2c): invite code, members, your character, and the owner's
 * kick / new code / start. While the game has not started the member list keeps itself current by asking
 * GET /api/game every `pollMs` (C6; the contract has no lobby socket event), so a newcomer, a finished
 * character or the start shows without a reload. If the game starts while the character page is open,
 * the page is swapped for the play room (C4).
 */
export function Lobby({
  apiBaseUrl,
  token,
  initial,
  onSessionLost,
  onPlayingChange,
  onGameList,
  pollMs = 3000,
}: {
  apiBaseUrl: string;
  token: string;
  initial?: GameView;
  onSessionLost: () => void;
  /** Q-265: tells the app when the play room opens / closes, so the app header can step aside. */
  onPlayingChange?: (playing: boolean) => void;
  /** Q-265: Play's own way to the game list. */
  onGameList?: () => void;
  pollMs?: number;
}) {
  const [game, setGame] = useState<GameView | undefined>(initial);
  const [error, setError] = useState<{ message: string; reasons?: string[] }>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [scenarioOpen, setScenarioOpen] = useState(false);
  /** Character creation opens over the lobby; going back reloads the lobby. */
  const [characterOpen, setCharacterOpen] = useState(false);
  /** The play room, after the start. */
  const [roomOpen, setRoomOpen] = useState(false);
  const [originOpen, setOriginOpen] = useState(false);
  /** Counts the owner / reload calls, so a poll answer that left before one of them is dropped. */
  const actions = useRef(0);

  useEffect(() => {
    onPlayingChange?.(roomOpen);
    return () => onPlayingChange?.(false);
  }, [roomOpen]);

  async function run(action: GameAction) {
    actions.current++;
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
    // Loaded once per token; later loads come from the poll, [ รีเฟรช ] and the owner actions.
  }, [apiBaseUrl, token]);

  const waiting = game?.status === 'lobby';
  useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    const timer = setInterval(() => {
      // A hidden tab does not ask; it catches up on the next tick after it shows again.
      if (document.hidden) return;
      const before = actions.current;
      void gameCall(apiBaseUrl, token, { method: 'GET', path: '/api/game' }).then((result) => {
        if (stopped || before !== actions.current) return;
        if (result.kind === 'session_lost') onSessionLost();
        // A failed poll keeps what is shown; the next one tries again.
        else if (result.kind === 'ok') setGame(result.game);
      });
    }, pollMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [apiBaseUrl, token, waiting, pollMs]);

  function enterRoom(of: GameView) {
    setCharacterOpen(false);
    setOriginOpen(of.you.role === 'player' && !originSeen(of));
    setRoomOpen(true);
  }

  // C4: the game went from lobby to started while the character page was open. Nothing can be edited any
  // more: go to Play. (A started game whose player has no character yet still opens the page, GEN-056 C2.)
  const status = game?.status;
  const lastStatus = useRef(status);
  useEffect(() => {
    const was = lastStatus.current;
    lastStatus.current = status;
    if (was === 'lobby' && status === 'started' && characterOpen && game) enterRoom(game);
  }, [status]);

  if (characterOpen) {
    return (
      <CharacterScreen
        apiBaseUrl={apiBaseUrl}
        token={token}
        onSessionLost={onSessionLost}
        onGameStarted={() => {
          if (game) enterRoom({ ...game, status: 'started' });
          void run({ method: 'GET', path: '/api/game' });
        }}
        onBack={() => {
          setCharacterOpen(false);
          void run({ method: 'GET', path: '/api/game' });
        }}
      />
    );
  }

  if (roomOpen) {
    return (
      <>
        {originOpen && game && (
          <OriginCard
            apiBaseUrl={apiBaseUrl}
            token={token}
            onClose={() => {
              rememberOriginSeen(game);
              setOriginOpen(false);
            }}
            // Not read this time (server unreachable, story not ready): it is offered again on the next entry.
            onUnavailable={() => setOriginOpen(false)}
          />
        )}
        <PlayRoom
          apiBaseUrl={apiBaseUrl}
          token={token}
          onSessionLost={onSessionLost}
          onBack={() => setRoomOpen(false)}
          onGameList={() => {
            setRoomOpen(false);
            onGameList?.();
          }}
          onNeedCharacter={() => {
            setRoomOpen(false);
            setCharacterOpen(true);
          }}
        />
      </>
    );
  }

  if (!game) {
    return error ? <p role="alert">โหลดห้องรอไม่ได้: {error.message}</p> : <Skeleton lines={4} label="กำลังโหลดห้องรอ…" />;
  }

  const owner = game.you.isOwner;
  const lobby = game.status === 'lobby';
  // The Human GM edits before the start (canEditScenario) and can still read it after; nobody else (Q-028).
  const gmOfGame = game.humanGm && game.you.role === 'gm';

  if (scenarioOpen) {
    return (
      <ScenarioEditor apiBaseUrl={apiBaseUrl} token={token} onClose={() => setScenarioOpen(false)} onSessionLost={onSessionLost} />
    );
  }
  const you = game.members.find((m) => m.id === game.you.memberId);
  const code = formatInviteCode(game.inviteCode);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setError({ message: 'คัดลอกไม่ได้ เลือกโค้ดแล้วคัดลอกเอง' });
    }
  }

  return (
    <div className="pregame">
      <Panel title="ห้องรอ" className="pregame__panel lobby">
        <h2 className="pregame__title">
          {game.name} · {modeLabel[game.mode]} · {game.humanGm ? 'GM คน' : 'AI GM'}
        </h2>

        <div className="invite">
          <span className="invite__label">โค้ดเกม</span>
          <strong className="invite__code">{code}</strong>
          <Button onClick={() => void copyCode()}>คัดลอก</Button>
          {owner && lobby && (
            <Button disabled={busy} onClick={() => void run({ method: 'POST', path: '/api/game/invite-code' })}>
              ออกโค้ดใหม่
            </Button>
          )}
          {owner && lobby && <small className="invite__note">ออกโค้ดใหม่แล้วโค้ดเก่าใช้ไม่ได้ทันที สมาชิกเดิมเข้าด้วยโค้ดใหม่ + ชื่อ + PIN เดิม</small>}
        </div>
        {copied && (
          <Toast tone="success" onClose={() => setCopied(false)}>
            คัดลอกโค้ด {code} แล้ว ส่งให้เพื่อนได้เลย
          </Toast>
        )}

        {!lobby && <p role="status">เกมเริ่มแล้ว โหมดและสมาชิกล็อกแล้ว</p>}
        {!lobby && you && (
          <div className="pregame__actions">
            <Button
              variant="primary"
              // A player needs a character to play; the Human GM watches without one.
              onClick={() => (you.role === 'player' && !you.hasCharacter ? setCharacterOpen(true) : enterRoom(game))}
            >
              เข้าห้องเล่น
            </Button>
          </div>
        )}
        <NpcDialoguePicker
          value={game.npcDialogue ?? 'normal'}
          disabled={!owner || !lobby || busy}
          note={!lobby ? npcDialogueText.locked : owner ? undefined : npcDialogueText.ownerOnly}
          onChange={(npcDialogue) => void run({ method: 'PATCH', path: '/api/game', body: { npcDialogue } })}
        />
        {(game.canEditScenario || gmOfGame) && (
          <p className="lobby__row">
            <span>Scenario</span>
            <Button onClick={() => setScenarioOpen(true)}>{game.canEditScenario ? 'แก้ scenario' : 'ดู scenario'}</Button>
            <small>เฉพาะ GM ผู้เล่นไม่เห็นเนื้อหา</small>
          </p>
        )}

        <div className="lobby__members">
          <p className="lobby__count">
            ผู้เล่น {game.players.count}/{game.players.max}
          </p>
          <ul aria-label="สมาชิก" className="members">
            {game.members.map((m) => {
              const ready = m.role === 'gm' || m.hasCharacter;
              return (
                <li key={m.id} className="members__row">
                  <span className="members__mark" aria-hidden="true">
                    {ready ? '●' : '○'}
                  </span>
                  <span className="members__name">{m.name}</span>
                  <span className="members__status">{memberStatus(m)}</span>
                  {m.isOwner && <span className="members__tag">(เจ้าของเกม)</span>}
                  {m.id === game.you.memberId && <span className="members__tag">(คุณ)</span>}
                  {owner && lobby && m.id !== game.you.memberId && (
                    <Button
                      variant="danger"
                      className="members__kick"
                      aria-label={`เตะ ${m.name}`}
                      disabled={busy}
                      onClick={() => void run({ method: 'DELETE', path: `/api/game/members/${encodeURIComponent(m.id)}` })}
                    >
                      เตะ
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {lobby && <small className="lobby__live">รายชื่ออัปเดตเองเมื่อมีคนเข้าหรือสร้างตัวละครเสร็จ</small>}
        </div>

        {lobby && you?.role === 'player' && (
          <div className="pregame__actions">
            <Button variant={you.hasCharacter ? 'secondary' : 'primary'} onClick={() => setCharacterOpen(true)}>
              {you.hasCharacter ? 'แก้ตัวละคร' : 'สร้างตัวละคร'}
            </Button>
          </div>
        )}

        {owner && lobby && (
          <div className="lobby__start">
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
            <Button
              variant={you?.role === 'gm' || you?.hasCharacter ? 'primary' : 'secondary'}
              disabled={busy || game.startBlockers.length > 0}
              onClick={() => void run({ method: 'POST', path: '/api/game/start' })}
            >
              เริ่มเกม
            </Button>
          </div>
        )}
        {game.memory && (
          <p className="lobby__memory">
            {game.memory.enabled ? `ความทรงจำจากเกมก่อน: เปิด (${game.memory.sources.map((s) => s.name).join(', ')})` : 'ความทรงจำจากเกมก่อน: ปิด'}
          </p>
        )}
        <div className="lobby__foot">
          <Button disabled={busy} onClick={() => void run({ method: 'GET', path: '/api/game' })}>
            รีเฟรช
          </Button>
        </div>
        {owner && <DeleteGame apiBaseUrl={apiBaseUrl} token={token} gameName={game.name} onDeleted={onSessionLost} />}
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
      </Panel>
    </div>
  );
}
