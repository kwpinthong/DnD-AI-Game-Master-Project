import { PHASE_LABEL, actionTextProblem, type RoomEntry, type RoomState } from '@isekai/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GameClosure } from './GameClosed.tsx';
import { GameSummaryPage } from './GameHistory.tsx';
import { GmConsole } from './GmConsole.tsx';
import { GmNarrating } from './play/GmNarrating.tsx';
import { ActionBar, EMPTY_DRAFT, type ActionDraft } from './play/chat/ActionBar.tsx';
import { ChatFeed } from './play/chat/ChatFeed.tsx';
import { DesktopLayout } from './play/chat/DesktopLayout.tsx';
import { HitPin } from './play/chat/HitPin.tsx';
import { CompactHudBar, HudBar } from './play/chat/Hud.tsx';
import { InfoPanel, InfoTabBody, type InfoData } from './play/chat/InfoPanel.tsx';
import { MobileLayout } from './play/chat/MobileLayout.tsx';
import { NpcChatBox, httpNpcChatApi } from './play/chat/NpcChat.tsx';
import { useCompact } from './play/chat/useCompact.ts';
import { useEntryVotes } from './play/chat/useEntryVotes.ts';
import { OmenBox, TravelSheet } from './play/PlaceColumn.tsx';
import { hitAcknowledged, rememberHitAcknowledged } from './play/hit-ack.ts';
import { changeCompanion, usePlayData } from './play/play-api.ts';
import { PrivateColumn } from './play/PrivateColumn.tsx';
import { RoomMenu } from './play/TopBar.tsx';
import { connectRoom, type RoomConnection, type RoomConnectionStatus } from './room-api.ts';
import { secretQuota } from './screen-models.ts';
import { FeedbackDialog } from './ui/FeedbackDialog.tsx';
import { Button, Skeleton, playText } from './ui/index.ts';
import './play/play.css';
import './play/chat/chat.css';
import './play/chat/art.css';

const t = playText;

/** For screen readers: "วันที่ 1 · EOSORIA (เช้า 06:00-11:59) · เทิร์น 1/2" (GEN-063: 4 periods x 2 turns). */
const timeLabel = (room: Pick<RoomEntry, 'day' | 'phase' | 'turn'>) => `วันที่ ${room.day} · ${PHASE_LABEL[room.phase]} · เทิร์น ${room.turn}/2`;

/**
 * The Play page v3 (GEN-122, docs/design/ui-v3-chat): a left-right chat. HUD on top, the chat feed in the middle,
 * the four-tab info panel on the right, the action bar at the bottom (`DesktopLayout` only places them). Real
 * data since GEN-101: the socket (GEN-056) reconnects by itself and fills in what it missed. The Human GM gets
 * the console and a read-only feed instead.
 */
export function PlayRoom({
  apiBaseUrl,
  token,
  onBack,
  onGameList,
  onNeedCharacter,
  onSessionLost,
  onClosed,
}: {
  apiBaseUrl: string;
  token: string;
  onBack: () => void;
  /** Q-265: Play is its own page, so it has its own way to the game list. */
  onGameList: () => void;
  /** The server says this player has no character yet (C2). */
  onNeedCharacter: () => void;
  onSessionLost: () => void;
  /** ISK-002: the server owner closed the game (the lobby shows the modal). */
  onClosed?: (closed: GameClosure) => void;
}) {
  const [connection, setConnection] = useState<RoomConnectionStatus>('connecting');
  const [room, setRoom] = useState<RoomState>();
  const [entries, setEntries] = useState<RoomEntry[]>([]);
  const [fatal, setFatal] = useState<string>();
  const [draft, setDraft] = useState<ActionDraft>(EMPTY_DRAFT);
  const [problem, setProblem] = useState<string>();
  const [waitingReply, setWaitingReply] = useState(false);
  const [whisperText, setWhisperText] = useState('');
  const [whisperProblem, setWhisperProblem] = useState<string>();
  const [omenProblem, setOmenProblem] = useState<string>();
  const [travelOpen, setTravelOpen] = useState(false);
  const [moveProblem, setMoveProblem] = useState<string>();
  const [moving, setMoving] = useState(false);
  const [moves, setMoves] = useState(0);
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<number>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** ISK-011: the report box, opened from the menu; mounted here so a draft outlives the menu and the layout. */
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [companionTick, setCompanionTick] = useState(0);
  const [companionProblem, setCompanionProblem] = useState<string>();
  /** GEN-149: the NPC whose chat box is open. */
  const [chatWith, setChatWith] = useState<{ ref: string; name: string } | null>(null);
  const chatApi = useMemo(() => httpNpcChatApi(apiBaseUrl, token), [apiBaseUrl, token]);
  const compact = useCompact();
  const votes = useEntryVotes(apiBaseUrl, token);
  const conn = useRef<RoomConnection | undefined>(undefined);
  const isOnline = useRef(false);
  const live = useRef(new Map<number, number>());

  useEffect(() => {
    const c = connectRoom(apiBaseUrl, token, {
      status: (status) => {
        isOnline.current = status === 'online';
        setConnection(status);
      },
      room: setRoom,
      entry: (entry) => {
        // GEN-148: what came after `ready` streams in; the history and a reconnect's catch-up appear whole.
        if (isOnline.current) live.current.set(entry.seq, Date.now());
        setEntries((list) => [...list, entry]);
      },
      actionReply: (reply) => {
        setWaitingReply(false);
        if (reply.ok) {
          setProblem(undefined);
          setDraft(EMPTY_DRAFT);
        } else setProblem(reply.message);
      },
      whisperReply: (reply) => {
        if (reply.ok) {
          setWhisperProblem(undefined);
          setWhisperText('');
        } else setWhisperProblem(reply.message);
      },
      moveReply: (reply) => {
        setMoving(false);
        if (reply.ok) {
          setMoveProblem(undefined);
          setTravelOpen(false);
          setMoves((n) => n + 1);
        } else setMoveProblem(reply.message);
      },
      omenReply: (reply) => setOmenProblem(reply.ok ? undefined : reply.message),
      gameClosed: (closed) => onClosed?.(closed),
      fatal: (code, message) => {
        if (code === 'no_character') onNeedCharacter();
        else if (code === 'unauthorized') onSessionLost();
        else setFatal(message);
      },
    });
    conn.current = c;
    return () => c.close();
    // One socket per token; the callbacks are stable enough for the life of the page.
  }, [apiBaseUrl, token]);

  const you = room?.you;
  const isPlayer = you?.role === 'player';
  const hits = entries.filter((e) => e.kind === 'hit').length;
  // GEN-155: your own `changes` entry (GEN-114) is the server saying your values / items moved, room snapshot or not.
  const changed = entries.filter((e) => e.kind === 'changes').length;
  // Your own numbers and who is around change with the turn, a move, a lock, a hit or a change log: load them again then.
  const refreshKey = room && isPlayer ? [room.day, room.phase, room.turn, room.status, you?.place?.id ?? '', you?.lock?.code ?? '', hits, changed, moves, companionTick].join('|') : null;
  const data = usePlayData(apiBaseUrl, token, refreshKey, onSessionLost);

  // Q-267: a hit acknowledged on this device stays acknowledged after a reload.
  const acked = new Set(acknowledged);
  if (room) for (const e of entries) if (e.kind === 'hit' && hitAcknowledged(room.gameId, room.you.memberId, e.seq)) acked.add(e.seq);
  function acknowledge(seq: number) {
    if (room) rememberHitAcknowledged(room.gameId, room.you.memberId, seq);
    setAcknowledged((set) => new Set(set).add(seq));
  }

  async function companion(action: { save: string } | { release: string }) {
    const result = await changeCompanion(apiBaseUrl, token, action);
    if (result.ok) {
      setCompanionProblem(undefined);
      setCompanionTick((n) => n + 1);
    } else if (result.sessionLost) onSessionLost();
    else setCompanionProblem(result.message);
  }

  function sendAction(next: ActionDraft) {
    // A chip or [พัก / นอน] alone is a whole action: its own words stand in for an empty box.
    const chip = room?.you.placeActions?.find((a) => a.id === next.placeAction);
    const text = next.text.trim() === '' ? (chip?.label ?? (next.rest ? t.action.rest : next.train ? t.action.trainText : '')) : next.text;
    const bad = actionTextProblem(text);
    if (bad) return setProblem(bad.message);
    if (!conn.current?.sendAction(text, next.visibility, next.rest, next.train, next.placeAction ?? undefined)) return setProblem(t.notConnected);
    setProblem(undefined);
    setWaitingReply(true);
  }

  function sendWhisper(to: string) {
    const bad = actionTextProblem(whisperText);
    if (bad) return setWhisperProblem(bad.code === 'empty' ? t.whisper.empty : bad.message);
    if (!conn.current?.sendWhisper(to, whisperText)) setWhisperProblem(t.notConnected);
  }

  function sendMove(to: string) {
    if (!conn.current?.sendMove(to)) return setMoveProblem(t.notConnected);
    setMoveProblem(undefined);
    setMoving(true);
  }


  const online = connection === 'online';
  const pinned = entries.filter((e) => e.kind === 'hit' && !acked.has(e.seq));
  // Votes only for a player (the server leaves `myVote` out for the Human GM, so the feed has none to show anyway).
  const voting = isPlayer
    ? {
        local: votes.local,
        busy: votes.busy,
        onVote: (entry: RoomEntry, next: Parameters<typeof votes.vote>[1]) => void votes.vote(entry, next),
        // GEN-168: the reason chips after a 👎.
        reasons: votes.reasons,
        onReasons: (entry: RoomEntry, next: Parameters<typeof votes.setReasons>[1]) => void votes.setReasons(entry, next),
      }
    : undefined;

  const notices = (
    <>
      {room && menuOpen && (
        <RoomMenu
          room={room}
          onBack={() => {
            setMenuOpen(false);
            onBack();
          }}
          onGameList={() => {
            setMenuOpen(false);
            onGameList();
          }}
          onFeedback={() => {
            setMenuOpen(false);
            setFeedbackOpen(true);
          }}
          {...(compact && isPlayer
            ? {
                onHistory: () => {
                  setMenuOpen(false);
                  setHistoryOpen(true);
                },
              }
            : {})}
        />
      )}
      <p role="status" aria-label={t.connectionLabel} data-connection={connection} className={online ? 'sr-only' : 'play-conn'}>
        {t.connection[connection]}
      </p>
      {room?.status === 'resolving' && !room.gmStatus && <GmNarrating key={`${room.day}-${room.phase}-${room.turn}`} />}
      {fatal && (
        <p role="alert" className="play-fatal">
          {fatal}
        </p>
      )}
      {votes.problem && <p role="alert">{votes.problem}</p>}
    </>
  );

  // Q-268a: the game log of this game over the page; the socket and the draft keep running underneath.
  const history = room && you && historyOpen && (
    <div className="play-history">
      <GameSummaryPage apiBaseUrl={apiBaseUrl} token={token} onBack={() => setHistoryOpen(false)} />
    </div>
  );

  return (
    <section className={you?.astral ? 'play play--astral' : 'play'} aria-label={t.room}>
      <h2 className="sr-only">
        {t.room}
        {room && ` · ${timeLabel(room)}`}
        {room?.mode === 'single' && ` · ${t.single}`}
      </h2>
      {!(room && you) && (
        <div className="play-frame">
          {notices}
          <div className="play-wait">
            {!fatal && <Skeleton lines={4} />}
            <Button onClick={onBack}>{t.back}</Button>
          </div>
        </div>
      )}

      {room && you && isPlayer && (() => {
        const feed = (
          <>
            <HitPin pinned={pinned} onAcknowledge={acknowledge} />
            <ChatFeed entries={entries} day={room.day} placeId={you.place?.id ?? null} placeName={you.place?.name} astral={Boolean(you.astral)} acknowledged={acked} ownAction={you.action} voting={voting} live={live.current} />
            {travelOpen && (
              <TravelSheet
                apiBaseUrl={apiBaseUrl}
                token={token}
                problem={moveProblem}
                busy={moving}
                onGo={sendMove}
                onClose={() => {
                  setTravelOpen(false);
                  setMoveProblem(undefined);
                }}
              />
            )}
            {/* C5: the NPC left (a new turn or a move reloads who is here): the box closes with it. */}
            {chatWith && data.npcs.some((n) => n.ref === chatWith.ref) && <NpcChatBox key={chatWith.ref} npc={chatWith} api={chatApi} onClose={() => setChatWith(null)} />}
          </>
        );
        const info: InfoData = {
          room,
          data,
          entries,
          secret: secretQuota(room).status,
          onTravel: you.astral ? null : () => setTravelOpen(true),
          onSave: you.astral ? null : (ref) => void companion({ save: ref }),
          onRelease: you.astral ? null : (ref) => void companion({ release: ref }),
          onUse: you.lock ? null : (name) => setDraft((d) => ({ ...d, text: `${t.inventory.insert(name)}${d.text}`, editing: d.editing || Boolean(you.action) })),
          companionProblem,
          whisper: { text: whisperText, setText: setWhisperText },
          whisperProblem,
          onWhisper: sendWhisper,
          onChat: you.astral ? null : setChatWith,
        };
        const actions = you.astral ? (
          <OmenBox
            room={room}
            problem={omenProblem}
            onSend={(to, text) => {
              if (!conn.current?.sendOmen(to, text)) setOmenProblem(t.notConnected);
            }}
          />
        ) : (
          <ActionBar room={room} seenBy={data.seenBy} draft={draft} setDraft={setDraft} problem={problem} sending={waitingReply} onSend={sendAction} onRetry={() => conn.current?.sendRetry()} compact={compact} />
        );
        return (
        <>
          <div className="play-frame" hidden={historyOpen}>
            {compact ? (
              <MobileLayout
                hud={<CompactHudBar room={room} character={data.character} menuOpen={menuOpen} onMenu={() => setMenuOpen((v) => !v)} />}
                notices={notices}
                feed={feed}
                panel={(tab) => <InfoTabBody tab={tab} {...info} />}
                actions={actions}
              />
            ) : (
              <DesktopLayout
                hud={<HudBar room={room} character={data.character} menuOpen={menuOpen} onMenu={() => setMenuOpen((v) => !v)} onHistory={() => setHistoryOpen(true)} />}
                notices={notices}
                feed={feed}
                side={<InfoPanel {...info} />}
                actions={actions}
              />
            )}
          </div>
          {history}
        </>
        );
      })()}

      {/* GEN-058: the Human GM has no character: the console (it reloads whenever the turn or the GM status moves), then the room's entries. */}
      {room && you && !isPlayer && (
        <div className="play-frame">
          <div className="v3-hud">
            <HudBar room={room} character={null} menuOpen={menuOpen} onMenu={() => setMenuOpen((v) => !v)} onHistory={() => setHistoryOpen(true)} />
          </div>
          {notices}
          {history}
          <div className="play-gm" hidden={historyOpen}>
            {room.gmStatus && (
              <div className="play-gm-status">
                <p role="alert">{room.gmStatus.message}</p>
                {room.gmStatus.canRetry && <Button onClick={() => conn.current?.sendRetry()}>{t.retry}</Button>}
              </div>
            )}
            <GmConsole apiBaseUrl={apiBaseUrl} token={token} refreshKey={`${room.day}-${room.phase}-${room.turn}-${room.status}-${room.gmStatus?.code ?? ''}`} gmStatus={room.gmStatus} />
            <ChatFeed entries={entries.filter((e) => e.kind === 'feed' || e.kind === 'time')} day={room.day} placeId={null} astral={false} />
            <PrivateColumn
              entries={entries}
              you={you}
              acknowledged={acked}
              onAcknowledge={acknowledge}
              whisper={{ text: whisperText, setText: setWhisperText }}
              whisperProblem={whisperProblem}
              onWhisper={sendWhisper}
            />
          </div>
        </div>
      )}
      <FeedbackDialog apiBaseUrl={apiBaseUrl} token={token} page="play" open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </section>
  );
}
