import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminDashboard } from '../AdminDashboard.tsx';
import { App } from '../App.tsx';
import { ChatColours } from '../dev/ChatColours.tsx';
import { GALLERY_PATH, Gallery, MockBar } from '../dev/Gallery.tsx';
import { rememberToken, saveToken } from '../session.ts';
import { MOCK_TOKEN, installMock, mockBaseUrl } from './install.ts';
import { scenarioById } from './scenarios.ts';

/**
 * Mock mode (GEN-100): `VITE_MOCK=1 pnpm --filter @isekai/web dev`. main.tsx imports this only when
 * `import.meta.env.DEV && VITE_MOCK === '1'`, so a production build never holds it. HTTP and the play-room
 * socket answer from the GEN-099 fixtures; no server is needed.
 *   /dev/gallery                       every contract screen × every scenario
 *   /dev/gallery?screen=…&scenario=…   one frame (screenshots)
 *   /?scenario=exhausted, /admin       the app itself on that scenario
 */
export function bootMock(root: HTMLElement): void {
  installMock();
  const path = window.location.pathname.replace(/\/+$/, '');
  const search = window.location.search;

  if (path === GALLERY_PATH) {
    // Frames get their token as a prop; the home frames start signed out.
    saveToken(null);
    rememberToken(MOCK_TOKEN);
    createRoot(root).render(
      <StrictMode>
        <Gallery search={search} />
      </StrictMode>,
    );
    return;
  }

  if (path === '/dev/chat-colours') {
    createRoot(root).render(
      <StrictMode>
        <ChatColours />
      </StrictMode>,
    );
    return;
  }

  const scenario = scenarioById(new URLSearchParams(search).get('scenario') ?? 'normal');
  const baseUrl = mockBaseUrl(scenario.id);
  if (scenario.session === 'guest') saveToken(null);
  else {
    saveToken(MOCK_TOKEN);
    rememberToken(MOCK_TOKEN);
  }
  createRoot(root).render(
    <StrictMode>
      {path === '/admin' ? <AdminDashboard apiBaseUrl={baseUrl} /> : <App apiBaseUrl={baseUrl} />}
      <details className="mock-bar--app" aria-label="mock">
        <summary>mock: {scenario.title}</summary>
        <a href={GALLERY_PATH}>เปิด gallery</a>
        <MockBar baseUrl={baseUrl} />
      </details>
    </StrictMode>,
  );
}
