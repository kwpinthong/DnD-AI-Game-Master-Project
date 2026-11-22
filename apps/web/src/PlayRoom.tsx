import { PHASE_LABEL, actionTextProblem, type RoomEntry, type RoomState } from '@isekai/protocol';
import { useEffect, useRef, useState } from 'react';
import { GameSummaryPage } from './GameHistory.tsx';
import { GmConsole } from './GmConsole.tsx';
import { GmNarrating } from './play/GmNarrating.tsx';
import { ActionBox, EMPTY_DRAFT, Feed, OmenBox, PlaceHead, TravelSheet, type ActionDraft } from './play/PlaceColumn.tsx';
import { hitAcknowledged, rememberHitAcknowledged } from './play/hit-ack.ts';
import { changeCompanion, usePlayData } from './play/play-api.ts';
import { PlayTabs } from './play/PlayTabs.tsx';
import { PrivateColumn } from './play/PrivateColumn.tsx';
import { SelfColumn } from './play/SelfColumn.tsx';
import { dotTabs, tabCounts, type PlayTab } from './play/tabs.ts';
import { RoomMenu, TopBar } from './play/TopBar.tsx';
import { connectRoom, type RoomConnection, type RoomConnectionStatus } from './room-api.ts';
import { secretQuota } from './screen-models.ts';
import { Button, Skeleton, playText } from './ui/index.ts';
import './play/play.css';

const t = playText;

/** For screen readers: "วันที่ 1 · EOSORIA (เช้า 06:00-11:59) · เทิร์น 1/2" (GEN-063: 4 periods x 2 turns). */
const timeLabel = (room: Pick<RoomEntry, 'day' | 'phase' | 'turn'>) => `วันที่ ${room.day} · ${PHASE_LABEL[room.phase]} · เทิร์น ${room.turn}/2`;

/**
 * The Play screen v2 (GEN-088, Screens and Flows v2 §4, layout P1 Q-199): a top bar and three columns by who
 * sees what. Left 272 = you (status, companions, skills + items), centre = your place and everything public
 * there (who is here, travel, the feed, the action box), right 340 = yours alone (the pinned hit card, your
 * story, Whisper). At 1366×620 all of it is in view; only the lists scroll. The socket (GEN-056) reconnects by
 * itself and fills in what it missed. The Human GM gets the console instead of the columns.
 */
export function PlayRoom({
  apiBaseUrl,
  token,
  onBack,
  onGameList,
  onNeedCharacter,
  onSessionLost,
}: {
  apiBaseUrl: string;
  token: string;
  onBack: () => void;
  /** Q-265: Play is its own page, so it has its own way to the game list. */
  onGameList: () => void;
  /** The server says this player has no character yet (C2). */
  onNeedCharacter: () => void;
  onSessionLost: () => void;
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
  const [companionTick, setCompanionTick] = useState(0);
  const [companionProblem, setCompanionProblem] = useState<string>();
  const [tab, setTab] = useState<PlayTab>('place');
  const [seen, setSeen] = useState<Record<PlayTab, number>>({ place: 0, private: 0, self: 0, action: 0 });
  const conn = useRef<RoomConnection | undefined>(undefined);

  useEffect(() => {
    const c = connectRoom(apiBaseUrl, token, {
      status: setConnection,
      room: setRoom,
      entry: (entry) => setEntries((list) => [...list, entry]),
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
  // Your own numbers and who is around change with the turn, a move, a lock or a hit: load them again then.
  const refreshKey = room && isPlayer ? [room.day, room.phase, room.turn, room.status, you?.place?.id ?? '', you?.lock?.code ?? '', hits, moves, companionTick].join('|') : null;
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

  const counts = tabCounts(entries);
  // What the tab you leave and the tab you open have shown so far is "seen"; the dot is for what came after.
  const pickTab = (next: PlayTab) => {
    setSeen((s) => ({ ...s, [tab]: counts[tab], [next]: counts[next] }));
    setTab(next);
  };

  const feed = entries.filter((e) => e.kind === 'feed');
  const online = connection === 'online';

  return (
    <section className={you?.astral ? 'play play--astral' : 'play'} aria-label={t.room}>
      <h2 className="sr-only">
        {t.room}
        {room && ` · ${timeLabel(room)}`}
        {room?.mode === 'single' && ` · ${t.single}`}
      </h2>
      <div className="play-frame">
        {room && you && <TopBar room={room} menuOpen={menuOpen} onMenu={() => setMenuOpen((v) => !v)} onHistory={() => setHistoryOpen(true)} />}
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
        {!(room && you) && (
          <div className="play-wait">
            {!fatal && <Skeleton lines={4} />}
            <Button onClick={onBack}>{t.back}</Button>
          </div>
        )}

        {/* Q-268a: the game log of this game over the columns; the socket and the draft keep running underneath. */}
        {room && you && historyOpen && (
          <div className="play-history">
            <GameSummaryPage apiBaseUrl={apiBaseUrl} token={token} onBack={() => setHistoryOpen(false)} />
          </div>
        )}

        {room && you && isPlayer && (
          <div className="play-body" data-tab={tab} hidden={historyOpen}>
            <SelfColumn
              data={data}
              secret={secretQuota(room).status}
              drowsy={you.drowsy}
              onUse={you.lock ? null : (name) => setDraft((d) => ({ ...d, text: `${t.inventory.insert(name)}${d.text}`, editing: d.editing || Boolean(you.action) }))}
              onRelease={you.astral ? null : (ref) => void companion({ release: ref })}
              companionProblem={companionProblem}
            />

            <div className="play-place">
              <PlaceHead room={room} data={data} onTravel={you.astral ? null : () => setTravelOpen(true)} onSave={you.astral ? null : (ref) => void companion({ save: ref })} />
              <div className="play-place__main">
                <Feed entries={feed} placeId={you.place?.id ?? null} placeName={you.place?.name} astral={Boolean(you.astral)} />
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
              </div>
              {you.astral ? (
                <OmenBox
                  room={room}
                  problem={omenProblem}
                  onSend={(to, text) => {
                    if (!conn.current?.sendOmen(to, text)) setOmenProblem(t.notConnected);
                  }}
                />
              ) : (
                <ActionBox room={room} seenBy={data.seenBy} draft={draft} setDraft={setDraft} problem={problem} sending={waitingReply} onSend={sendAction} onRetry={() => conn.current?.sendRetry()} />
              )}
            </div>

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
        )}
        {room && you && isPlayer && !historyOpen && <PlayTabs active={tab} dots={dotTabs(counts, seen, tab)} onPick={pickTab} />}

        {/* GEN-058: the Human GM has no character: the console (it reloads whenever the turn or the GM status moves), then the room's entries. */}
        {room && you && !isPlayer && (
          <div className="play-gm">
            {room.gmStatus && (
              <div className="play-gm-status">
                <p role="alert">{room.gmStatus.message}</p>
                {room.gmStatus.canRetry && <Button onClick={() => conn.current?.sendRetry()}>{t.retry}</Button>}
              </div>
            )}
            <GmConsole apiBaseUrl={apiBaseUrl} token={token} refreshKey={`${room.day}-${room.phase}-${room.turn}-${room.status}-${room.gmStatus?.code ?? ''}`} gmStatus={room.gmStatus} />
            <Feed entries={feed} placeId={null} astral={false} />
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
        )}
      </div>
    </section>
  );
}
