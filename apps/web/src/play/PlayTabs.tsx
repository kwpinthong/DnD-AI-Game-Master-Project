import { playText } from '../ui/index.ts';
import { PLAY_TABS, type PlayTab } from './tabs.ts';

const t = playText.tabs;

/** The phone tab bar (< 768, GEN-089). Always rendered; play.css hides it from 768 up, where the three columns show everything. */
export function PlayTabs({ active, dots, onPick }: { active: PlayTab; dots: ReadonlySet<PlayTab>; onPick: (tab: PlayTab) => void }) {
  return (
    <nav className="play-mtabs" aria-label={t.nav}>
      {PLAY_TABS.map((tab) => (
        <button key={tab} type="button" className="play-mtabs__tab" aria-pressed={tab === active} onClick={() => onPick(tab)}>
          {t[tab]}
          {dots.has(tab) && <span className="play-mtabs__dot" role="img" aria-label={t.news} />}
        </button>
      ))}
    </nav>
  );
}
