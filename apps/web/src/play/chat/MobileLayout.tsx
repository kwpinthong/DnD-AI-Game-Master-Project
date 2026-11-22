import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { playText } from '../../ui/index.ts';
import { INFO_TABS, InfoTabs, type InfoTab } from './InfoPanel.tsx';
import { useInfoSheet } from './useInfoSheet.ts';

const t = playText.chat.panel;

/**
 * Keeps the frame the size of what the person can see: on a phone the keyboard shrinks `visualViewport` (iOS does not
 * resize the layout viewport), so the text box and [ส่ง] stay in view. `data-keyboard` lets the CSS drop the tab bar then.
 */
function useVisibleHeight(frame: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const vv = window.visualViewport;
    const play = frame.current?.closest<HTMLElement>('.play');
    if (!vv || !play || !frame.current) return;
    const fit = () => {
      if (!frame.current) return;
      play.style.height = `${vv.height}px`;
      frame.current.toggleAttribute('data-keyboard', vv.height < window.innerHeight * 0.75);
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    fit();
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    return () => {
      vv.removeEventListener('resize', fit);
      vv.removeEventListener('scroll', fit);
      play.style.height = '';
    };
  }, [frame]);
}

/**
 * The phone frame of the chat Play page (GEN-123, < 768): the two-line top bar, the feed full width, the action bar,
 * and the four info tabs as a bottom bar that opens a slide-up sheet. The sheet closes with [ปิด] and with the device
 * back button (`useInfoSheet`). It only places the slots, like `DesktopLayout`: the pieces in them are the same components.
 */
export function MobileLayout({ hud, notices, feed, actions, panel }: { hud: ReactNode; notices?: ReactNode; feed: ReactNode; actions: ReactNode; panel: (tab: InfoTab) => ReactNode }) {
  const sheet = useInfoSheet();
  const frame = useRef<HTMLDivElement>(null);
  useVisibleHeight(frame);

  return (
    <div className="v3m" ref={frame}>
      <header className="v3m-hud">{hud}</header>
      <div className="v3-notices">{notices}</div>
      <main className="v3-feed v3m-feed" aria-label={playText.chat.feedMain}>
        {feed}
      </main>
      <footer className="v3m-bar">
        {actions}
        <nav className="v3m-nav" aria-label={t.label}>
          {INFO_TABS.map((id) => (
            <button key={id} type="button" className="v3m-nav__btn" aria-haspopup="dialog" onClick={() => sheet.show(id)}>
              {id === 'place' ? t.scene : t[id]}
            </button>
          ))}
        </nav>
      </footer>
      {sheet.tab && (
        <div className="v3m-sheet" role="dialog" aria-modal="true" aria-label={t.label}>
          <div className="v3m-sheet__head">
            <button type="button" className="v3m-sheet__close" onClick={sheet.close}>
              {playText.chat.bar.close}
            </button>
          </div>
          <InfoTabs tab={sheet.tab} onPick={sheet.show}>
            {panel(sheet.tab)}
          </InfoTabs>
        </div>
      )}
    </div>
  );
}
