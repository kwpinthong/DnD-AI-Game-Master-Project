import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@dnd/protocol',
    include: ['test/**/*.test.ts'],
  },
});
