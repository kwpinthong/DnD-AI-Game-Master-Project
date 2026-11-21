import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@isekai/server',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
