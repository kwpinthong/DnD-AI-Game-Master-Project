import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@dnd/rules',
    include: ['test/**/*.test.ts'],
  },
});
