import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminDashboard } from './AdminDashboard.tsx';
import { App } from './App.tsx';

// VITE_API_URL: the server's public URL when the web app is hosted elsewhere (Netlify, Q-031).
// Empty in dev: requests stay same-origin and the Vite proxy forwards them to the server.
const apiBaseUrl = import.meta.env.VITE_API_URL ?? '';

// <web>/admin: the server owner's AI usage dashboard (GEN-061); Netlify serves index.html for every path.
const isAdmin = window.location.pathname.replace(/\/+$/, '') === '/admin';

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isAdmin ? <AdminDashboard apiBaseUrl={apiBaseUrl} /> : <App apiBaseUrl={apiBaseUrl} />}</StrictMode>,
);
