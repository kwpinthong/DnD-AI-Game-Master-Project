import { formatInviteCode, type GameMember, type GameView } from '@isekai/protocol';
import { useEffect, useRef, useState } from 'react';
import { CharacterScreen } from './CharacterScreen.tsx';
import { GameClosedModal, type GameClosure } from './GameClosed.tsx';
import { GameSummaryPage } from './GameHistory.tsx';
import { getGame, readyCall } from './game-api.ts';
import { connectLobby } from './room-api.ts';
import { lobbyText, npcDialogueText, toneText } from './ui/strings.ts';
import { OriginCard } from './OriginCard.tsx';
import { PlayRoom } from './PlayRoom.tsx';
import { ScenarioViewer } from './ScenarioEditor.tsx';
import { FeedbackButton } from './ui/FeedbackDialog.tsx';
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

/** ISK-019: the lobby's status line. "ผู้เล่น" = members with role player (the GM never presses ready). */
function readyLine(game: GameView): string {
  const players = game.members.filter((m) => m.role === 'player');
  if (game.mode === 'single') return lobbyText.single;
  if (players.length < 2) return lobbyText.needPlayer;
  return lobbyText.waiting(players.filter((m) => m.ready).length, players.length);
}

const label = <T extends string>(list: readonly { value: T; label: string }[], value: T | undefined) => list.find((o) => o.value === value)?.label;

/**
 * Lobby v2 (GEN-090, Screens and Flows v2 §2c): invite code, members, your character. ISK-019: no host; every
 * player presses [พร้อม] and the server starts the game itself once everyone is ready. The settings are the ones
 * fixed at creation, read-only. The ready marks and a blocked start arrive on the lobby socket (ISK-017); the rest
 * (newcomers, characters, the start) by asking GET /api/game every `pollMs`, so it shows without a reload. If the
 * game starts while the character page is open, the page is swapped for the play room (C4).
 */
export function Lobby({
  apiBaseUrl,
  token,
  initial,
  onSessionLost,
  onPlayingChange,
  onGameList,
  onLeave,
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
  /** ISK-002: out of a closed game, to the home page's game list. */
  onLeave?: () => void;
  pollMs?: number;
}) {
  const [game, setGame] = useState<GameView | undefined>(initial);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  /** ISK-017: everyone was ready but the AI GM was not (503 / lobby_start_blocked): the reason. */
  const [blocked, setBlocked] = useState<string>();
  const sending = useRef(false);
  const [copied, setCopied] = useState(false);
  const [scenarioOpen, setScenarioOpen] = useState(false);
  /** Character creation opens over the lobby; going back reloads the lobby. */
  const [characterOpen, setCharacterOpen] = useState(false);
  /** The play room, after the start. */
  const [roomOpen, setRoomOpen] = useState(false);
  const [originOpen, setOriginOpen] = useState(false);
  /** ISK-002: the play room's socket said the server owner closed the game. */
  const [closedEvent, setClosedEvent] = useState<GameClosure | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  /** Counts the ready / reload calls and socket marks, so a poll answer that left before one of them is dropped. */
  const actions = useRef(0);
  // Q-387 A: outside the play room the close comes from GET /api/game (`closed`), inside it from the socket.
  const closed = closedEvent ?? game?.closed ?? null;
  const playing = roomOpen && !closed;

  useEffect(() => {
    onPlayingChange?.(playing);
    return () => onPlayingChange?.(false);
  }, [playing]);

  /** A reload, or the ready button (`ready`): not optimistic, the shown state is what the server answered. */
  async function run(ready?: boolean) {
    if (sending.current) return;
    sending.current = true;
    actions.current++;
    setBusy(true);
    const result = ready === undefined ? await getGame(apiBaseUrl, token) : await readyCall(apiBaseUrl, token, ready);
    sending.current = false;
    setBusy(false);
    if (result.kind === 'session_lost') return onSessionLost();
    if (result.kind === 'blocked') {
      setError(undefined);
      return setBlocked(result.message);
    }
    if (result.kind === 'error') return setError(result.message);
    setError(undefined);
    if (ready !== undefined) setBlocked(undefined);
    setGame(result.game);
  }

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    void getGame(apiBaseUrl, token).then((result) => {
      if (cancelled) return;
      if (result.kind === 'session_lost') onSessionLost();
      else if (result.kind !== 'ok') setError(result.message);
      else setGame(result.game);
    });
    return () => {
      cancelled = true;
    };
    // Loaded once per token; later loads come from the poll, [ รีเฟรช ] and [พร้อม].
  }, [apiBaseUrl, token]);

  // The lobby and the setup pages (character, loot) keep asking, so a start or a close shows without a reload.
  const asking = Boolean(game) && !roomOpen && !closed;
  useEffect(() => {
    if (!asking) return;
    let stopped = false;
    const timer = setInterval(() => {
      // A hidden tab does not ask; it catches up on the next tick after it shows again.
      if (document.hidden) return;
      const before = actions.current;
      void getGame(apiBaseUrl, token).then((result) => {
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
  }, [apiBaseUrl, token, asking, pollMs]);

  // ISK-017: the lobby socket, before the start only (after it the play room has its own).
  const inLobby = asking && game?.status === 'lobby';
  useEffect(() => {
    if (!inLobby) return;
    const socket = connectLobby(apiBaseUrl, token, {
      ready(memberId, ready) {
        actions.current++; // a poll already on its way left before this mark
        setGame((g) => g && { ...g, members: g.members.map((m) => (m.id === memberId ? { ...m, ready } : m)) });
      },
      startBlocked: setBlocked,
    });
    return () => socket.close();
  }, [apiBaseUrl, token, inLobby]);

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

  // ISK-002: a closed game shows only the modal (nothing behind it can be used), then its end page or home.
  if (closed) {
    if (summaryOpen) return <GameSummaryPage apiBaseUrl={apiBaseUrl} token={token} onBack={() => onLeave?.()} />;
    return <GameClosedModal closed={closed} onSummary={() => setSummaryOpen(true)} onHome={() => onLeave?.()} />;
  }

  if (characterOpen) {
    return (
      <CharacterScreen
        apiBaseUrl={apiBaseUrl}
        token={token}
        onSessionLost={onSessionLost}
        onGameStarted={() => {
          if (game) enterRoom({ ...game, status: 'started' });
          void run();
        }}
        onBack={() => {
          setCharacterOpen(false);
          void run();
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
          onClosed={setClosedEvent}
        />
      </>
    );
  }

  if (!game) {
    return error ? <p role="alert">โหลดห้องรอไม่ได้: {error}</p> : <Skeleton lines={4} label="กำลังโหลดห้องรอ…" />;
  }

  const lobby = game.status === 'lobby';
  // Only the Human GM reads the scenario (Q-028); it was set at creation, nobody edits it here.
  const gmOfGame = game.humanGm && game.you.role === 'gm';

  if (scenarioOpen) {
    return <ScenarioViewer apiBaseUrl={apiBaseUrl} token={token} onClose={() => setScenarioOpen(false)} onSessionLost={onSessionLost} />;
  }
  const you = game.members.find((m) => m.id === game.you.memberId);
  const code = formatInviteCode(game.inviteCode);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setError('คัดลอกไม่ได้ เลือกโค้ดแล้วคัดลอกเอง');
    }
  }

  return (
    <div className="pregame">
      <FeedbackButton apiBaseUrl={apiBaseUrl} token={token} page="lobby" />
      <Panel title="ห้องรอ" className="pregame__panel lobby">
        <h2 className="pregame__title">
          {game.name} · {modeLabel[game.mode]} · {game.humanGm ? 'GM คน' : 'AI GM'}
        </h2>

        <div className="invite">
          <span className="invite__label">โค้ดเกม</span>
          <strong className="invite__code">{code}</strong>
          <Button onClick={() => void copyCode()}>คัดลอก</Button>
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
        <ul className="lobby__settings" aria-label="ตั้งค่าเกม">
          <li>
            {npcDialogueText.group}: {label(npcDialogueText.levels, game.npcDialogue ?? 'normal')}
          </li>
          {game.tone && (
            <li>
              {toneText.group}: {label(toneText.tones, game.tone)}
            </li>
          )}
          {game.memory && (
            <li>ความทรงจำจากเกมก่อน: {game.memory.enabled ? `เปิด (${game.memory.sources.map((s) => s.name).join(', ')})` : 'ปิด'}</li>
          )}
        </ul>
        <small className="pregame__note">{lobbyText.settingsLocked}</small>
        {gmOfGame && (
          <p className="lobby__row">
            <span>Scenario</span>
            <Button onClick={() => setScenarioOpen(true)}>ดู scenario</Button>
            <small>เฉพาะ GM ผู้เล่นไม่เห็นเนื้อหา</small>
          </p>
        )}

        <div className="lobby__members">
          <p className="lobby__count">
            ผู้เล่น {game.players.count}/{game.players.max}
          </p>
          <ul aria-label="สมาชิก" className="members">
            {game.members.map((m) => (
              <li key={m.id} className="members__row">
                <span className="members__mark" aria-hidden="true">
                  {m.ready ? '●' : '○'}
                </span>
                <span className="members__name">{m.name}</span>
                <span className="members__status">{memberStatus(m)}</span>
                {m.ready && <span className="members__tag members__ready">{lobbyText.readyMark}</span>}
                {m.id === game.you.memberId && <span className="members__tag">(คุณ)</span>}
              </li>
            ))}
          </ul>
          {lobby && <small className="lobby__live">รายชื่ออัปเดตเองเมื่อมีคนเข้า สร้างตัวละครเสร็จ หรือกดพร้อม</small>}
        </div>

        {lobby && (
          <div className="lobby__start">
            <p role="status">{readyLine(game)}</p>
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
            {you?.role === 'player' && (
              <div className="pregame__actions">
                <Button variant={you.hasCharacter ? 'secondary' : 'primary'} onClick={() => setCharacterOpen(true)}>
                  {you.hasCharacter ? 'แก้ตัวละคร' : 'สร้างตัวละคร'}
                </Button>
                <Button
                  variant={you.ready ? 'secondary' : 'primary'}
                  className="lobby__ready"
                  aria-pressed={you.ready}
                  loading={busy}
                  loadingText={you.ready ? lobbyText.unready : lobbyText.ready}
                  onClick={() => void run(!you.ready)}
                >
                  {you.ready ? lobbyText.unready : lobbyText.ready}
                </Button>
              </div>
            )}
          </div>
        )}
        {lobby && blocked && (
          <div role="alert" className="lobby__blocked">
            <p>{blocked}</p>
            {you?.role === 'player' && (
              <Button variant="primary" disabled={busy} onClick={() => void run(true)}>
                {lobbyText.retry}
              </Button>
            )}
          </div>
        )}
        <div className="lobby__foot">
          <Button disabled={busy} onClick={() => void run()}>
            รีเฟรช
          </Button>
        </div>
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
      </Panel>
    </div>
  );
}
