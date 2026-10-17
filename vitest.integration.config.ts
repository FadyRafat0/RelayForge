import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/*.test.ts'],
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
