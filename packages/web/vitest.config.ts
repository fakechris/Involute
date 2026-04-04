import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    maxWorkers: 1,
    passWithNoTests: true,
    pool: 'threads',
    setupFiles: './src/test/setup.ts',
  },
});
