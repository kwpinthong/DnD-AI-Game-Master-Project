import type { ReactNode } from 'react';
import { playText } from '../../ui/index.ts';

/**
 * The desktop frame of the chat Play page (GEN-122, >= 1280): HUD on top, the feed in the middle (900 wide at most),
 * the info panel on the right (340), the action bar at the bottom. It only places the slots; every piece in them is a
 * reusable component, so the phone (GEN-123) makes its own frame from the same pieces.
 */
export function DesktopLayout({ hud, notices, feed, side, actions }: { hud: ReactNode; notices?: ReactNode; feed: ReactNode; side: ReactNode; actions: ReactNode }) {
  return (
    <div className="v3">
      <header className="v3-hud">{hud}</header>
      <div className="v3-notices">{notices}</div>
      <div className="v3-main">
        <main className="v3-feed" aria-label={playText.chat.feedMain}>
          {feed}
        </main>
        {side}
      </div>
      <footer className="v3-bar">{actions}</footer>
    </div>
  );
}
