import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@isekai/protocol',
    include: ['test/**/*.test.ts'],
  },
});
