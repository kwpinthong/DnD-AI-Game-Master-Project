import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev: the page calls /health and /api/* on its own origin and Vite forwards it to the server.
// Set API_PROXY_TARGET if the server is not on 127.0.0.1:3000.
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/health': apiTarget,
      '/api': apiTarget,
    },
  },
});
