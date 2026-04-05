import { defineConfig } from '@playwright/test';

const composeProject = process.env.E2E_COMPOSE_PROJECT ?? 'involute-e2e';
const databasePort = process.env.E2E_DB_PORT ?? '5544';
const serverPort = process.env.E2E_SERVER_PORT ?? '4300';
const webPort = process.env.E2E_WEB_PORT ?? '4301';
const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgresql://involute:involute@127.0.0.1:${databasePort}/involute?schema=public`;
const authToken = process.env.E2E_AUTH_TOKEN ?? 'e2e-auth-token';
const viewerAssertionSecret = process.env.E2E_VIEWER_ASSERTION_SECRET ?? 'e2e-viewer-assertion-secret';
const reuseCompose = process.env.E2E_REUSE_COMPOSE === 'true';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  globalTeardown: './e2e/global-teardown.mjs',
  webServer: [
    {
      command:
        `E2E_COMPOSE_PROJECT="${composeProject}" ` +
        `E2E_DB_PORT="${databasePort}" ` +
        `E2E_DATABASE_URL="${databaseUrl}" ` +
        `E2E_AUTH_TOKEN="${authToken}" ` +
        `E2E_VIEWER_ASSERTION_SECRET="${viewerAssertionSecret}" ` +
        `E2E_SERVER_PORT="${serverPort}" ` +
        `E2E_WEB_PORT="${webPort}" ` +
        `sh ./e2e/setup-backend.sh`,
      url: `http://127.0.0.1:${serverPort}/health`,
      reuseExistingServer: reuseCompose,
      timeout: 120_000,
    },
    {
      command:
        `E2E_AUTH_TOKEN="${authToken}" ` +
        `E2E_VIEWER_ASSERTION_SECRET="${viewerAssertionSecret}" ` +
        `E2E_SERVER_PORT="${serverPort}" ` +
        `E2E_WEB_PORT="${webPort}" ` +
        `sh ./e2e/setup-frontend.sh`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: reuseCompose,
      timeout: 120_000,
    },
  ],
});
