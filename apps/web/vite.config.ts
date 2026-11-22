import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { checkBuildEnv } from './build-env.ts';

// Dev: the page calls /health and /api/* on its own origin and Vite forwards it to the server.
// Set API_PROXY_TARGET if the server is not on 127.0.0.1:3000.
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig(({ command }) => {
  // Netlify: refuse to build a site that cannot reach the server (VITE_API_URL missing or not https).
  if (command === 'build') checkBuildEnv(process.env);
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/health': apiTarget,
        // ws: the play room's WebSocket (GEN-056) is under /api too.
        '/api': { target: apiTarget, ws: true },
      },
    },
  };
});
