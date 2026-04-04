import { defineConfig } from '@playwright/test';

const databaseUrl = 'postgresql://involute:involute@127.0.0.1:5434/involute?schema=public';
const authToken = 'e2e-auth-token';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4201',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  globalTeardown: './e2e/global-teardown.mjs',
  webServer: [
    {
      command:
        `docker compose up -d db && ` +
        `for attempt in $(seq 1 20); do ` +
        `DATABASE_URL="${databaseUrl}" pnpm --filter @involute/server exec prisma db push --force-reset --skip-generate && break; ` +
        `if [ "$attempt" = "20" ]; then exit 1; fi; ` +
        `sleep 3; ` +
        `done && ` +
        `DATABASE_URL="${databaseUrl}" pnpm --filter @involute/server exec prisma db seed && ` +
        `DATABASE_URL="${databaseUrl}" AUTH_TOKEN="${authToken}" PORT=4200 pnpm --filter @involute/server exec tsx src/index.ts`,
      url: 'http://127.0.0.1:4200/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: `VITE_INVOLUTE_AUTH_TOKEN="${authToken}" VITE_INVOLUTE_GRAPHQL_URL="http://127.0.0.1:4200/graphql" pnpm --filter @involute/web exec vite --host 127.0.0.1 --port 4201`,
      url: 'http://127.0.0.1:4201',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
