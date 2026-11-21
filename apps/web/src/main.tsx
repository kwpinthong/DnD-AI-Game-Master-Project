import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

// VITE_API_URL: the server's public URL when the web app is hosted elsewhere (Netlify, Q-031).
// Empty in dev: requests stay same-origin and the Vite proxy forwards them to the server.
const apiBaseUrl = import.meta.env.VITE_API_URL ?? '';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App apiBaseUrl={apiBaseUrl} />
  </StrictMode>,
);
