import { PHASE_LABEL, type RoomState } from '@isekai/protocol';
import { topBar, type TurnDot } from '../screen-models.ts';
import { Button, playText } from '../ui/index.ts';

const t = playText.top;

// Shapes, not colours: full = done, half = this turn, open = to come.
const DOT: Record<TurnDot, string> = { done: '●', current: '◐', todo: '○' };

/**
 * 4.1 the top bar (44 high): day, the four periods with their two turns, the weather as a word, "ส่งแล้ว n/N"
 * (Q-195: the count only) and who the GM is. The current period says "ตอนนี้" besides its colour.
 */
export function TopBar({ room, menuOpen, onMenu, onHistory }: { room: RoomState; menuOpen: boolean; onMenu: () => void; onHistory: () => void }) {
  const bar = topBar(room);
  const now = bar.periods.findIndex((p) => p.current);
  return (
    <div className="play-top" role="group" aria-label={t.label}>
      <span className="play-top__day">{bar.day}</span>
      <ol className="play-periods" aria-label={t.periods}>
        {bar.periods.map((p, i) => (
          <li key={p.phase} className={p.current ? 'play-period play-period--now' : 'play-period'} aria-current={p.current ? 'step' : undefined} title={PHASE_LABEL[p.phase]}>
            <span className="play-period__name">{p.phase}</span>
            <span className="play-period__dots" aria-hidden="true">
              {p.turns.map((dot) => DOT[dot]).join('')}
            </span>
            {p.current ? (
              <>
                <span className="play-period__turn">{t.turn(room.turn)}</span>
                <span className="play-period__now">{t.now}</span>
              </>
            ) : (
              <span className="sr-only">{i < now ? t.done : t.todo}</span>
            )}
          </li>
        ))}
      </ol>
      <span className="play-top__weather">
        <span className="sr-only">{t.weather} </span>
        <span>{bar.weather}</span>
      </span>
      {bar.submitted && <span className="play-top__sent">{bar.submitted}</span>}
      <span className="play-top__gm">{room.members.some((m) => m.role === 'gm') ? t.humanGm : t.aiGm}</span>
      <Button className="play-top__history" onClick={onHistory}>
        {t.history}
      </Button>
      <Button className="play-top__menu" aria-expanded={menuOpen} onClick={onMenu}>
        {t.menu}
      </Button>
    </div>
  );
}

/** The menu under [เมนู]: who is in the room (names + online, never who has sent: Q-195) and the way back. */
export function RoomMenu({ room, onBack, onGameList, onHistory }: { room: RoomState; onBack: () => void; onGameList: () => void; onHistory?: () => void }) {
  const gmView = room.you.role === 'gm';
  return (
    <div className="play-menu panel panel--ornament">
      <h3>{t.members}</h3>
      <ul className="play-list" aria-label={t.members}>
        {room.members.map((m) => (
          <li key={m.memberId}>
            {[
              m.name,
              m.memberId === room.you.memberId ? t.you : null,
              m.online ? t.online : t.offline,
              m.role === 'gm' ? t.gm : null,
              // Only the Human GM is told who has sent.
              gmView && m.role === 'player' && m.submitted !== undefined ? (m.submitted ? t.sent : t.notSent) : null,
            ]
              .filter((s): s is string => s !== null)
              .join(' ')}
          </li>
        ))}
      </ul>
      {onHistory && <Button onClick={onHistory}>{t.history}</Button>}
      <Button onClick={onBack}>{playText.back}</Button>
      <Button onClick={onGameList}>{t.gameList}</Button>
    </div>
  );
}
