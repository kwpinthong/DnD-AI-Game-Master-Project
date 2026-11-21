import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@isekai/rules',
    include: ['test/**/*.test.ts'],
  },
});
