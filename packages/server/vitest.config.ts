import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    passWithNoTests: true,
    setupFiles: ['./src/test-setup.ts'],
    // These are integration tests against a real Postgres, and a reset hook
    // takes ACCESS EXCLUSIVE locks on every table. The work itself is fast
    // (~0.5s), but under load it waits, and the 5s/10s defaults turn that wait
    // into a spurious failure rather than a slower pass.
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
