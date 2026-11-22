import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminDashboard } from './AdminDashboard.tsx';
import { App } from './App.tsx';
// Theme v2 (GEN-087): tokens.css is the only place colours and fonts are defined; theme.css uses them.
import './tokens.css';
import './theme.css';

// VITE_API_URL: the server's public URL when the web app is hosted elsewhere (Netlify, Q-031).
// Empty in dev: requests stay same-origin and the Vite proxy forwards them to the server.
const apiBaseUrl = import.meta.env.VITE_API_URL ?? '';

// <web>/admin: the server owner's AI usage dashboard (GEN-061); Netlify serves index.html for every path.
const isAdmin = window.location.pathname.replace(/\/+$/, '') === '/admin';

const root = document.getElementById('root')!;

// GEN-100 mock mode (VITE_MOCK=1, dev only): `import.meta.env.DEV` is false in a build, so this branch and
// the mock / gallery chunk are dropped from it (scripts/check-bundle.ts checks).
if (import.meta.env.DEV && import.meta.env.VITE_MOCK === '1') {
  void import('./mock/boot.tsx').then((m) => m.bootMock(root));
} else {
  createRoot(root).render(<StrictMode>{isAdmin ? <AdminDashboard apiBaseUrl={apiBaseUrl} /> : <App apiBaseUrl={apiBaseUrl} />}</StrictMode>);
}
