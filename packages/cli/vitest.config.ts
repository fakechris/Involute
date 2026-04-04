import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    passWithNoTests: true,
    exclude: ['**/node_modules/**', '**/dist/**'],
    isolate: true,
    // Multiple test files (verify, issues, import) hit the same shared
    // PostgreSQL database.  Running them in parallel causes cross-test
    // contamination (stale mappings / FK violations).  Serialise files
    // so each suite has exclusive DB access.
    fileParallelism: false,
    pool: 'forks',
  },
});
