import react from '@vitejs/plugin-react';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [react()],
  test: {
    name: '@isekai/web',
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
  },
});
