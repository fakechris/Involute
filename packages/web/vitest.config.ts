import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    maxWorkers: 1,
    passWithNoTests: true,
    setupFiles: './src/test/setup.ts',
  },
});
