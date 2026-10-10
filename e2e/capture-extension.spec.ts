import { chromium, expect, test, type APIRequestContext, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Involute Capture end to end (INV-1147): the unpacked extension in Chromium
 * against the local stack. It connects through /extension/connect, adds the
 * web app as a managed origin, picks an element, draws a box and files the
 * bug; then the bug is read back with the static token.
 *
 * Two differences from a person's run, both outside the extension's code:
 * - Playwright cannot click Chrome's native permission prompt, so the e2e
 *   build (dist-e2e) lists the local hosts in host_permissions; the options
 *   page still calls chrome.permissions.request, which then resolves at once.
 * - Playwright cannot open or drive the side panel, so the panel page is
 *   opened in its own window with the same ?tab=<id> the background gives it.
 *   The toolbar button and shortcut (sidePanel.open) are not exercised.
 */
const EXTENSION_ID = 'gggpgjhcjmonhaipcmeeaejlncgihbge';
const serverPort = process.env.E2E_SERVER_PORT ?? '4300';
const webPort = process.env.E2E_WEB_PORT ?? '4301';
const webOrigin = `http://127.0.0.1:${webPort}`;
const graphqlUrl = `http://127.0.0.1:${serverPort}/graphql`;
const authToken = process.env.E2E_AUTH_TOKEN ?? 'e2e-auth-token';
const assertionSecret = process.env.E2E_VIEWER_ASSERTION_SECRET ?? 'e2e-viewer-assertion-secret';
const root = resolve(__dirname, '..');
const extensionDir = join(root, 'packages', 'extension', 'dist-e2e');

/** The static operator token, acting for the seeded admin. */
function adminAssertion(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600, sub: 'admin@involute.local', subType: 'email' })).toString('base64url');
  return `${payload}.${createHmac('sha256', assertionSecret).update(payload).digest('base64url')}`;
}

async function gql<T>(request: APIRequestContext, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await request.post(graphqlUrl, {
    data: { query, variables },
    headers: { authorization: `Bearer ${authToken}`, 'x-involute-viewer-assertion': adminAssertion() },
  });
  const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) throw new Error(body.errors.map((error) => error.message).join('; '));
  return body.data as T;
}

/** A browser session for the seeded admin, written straight into the e2e database (as the server's createSession does). */
function createAdminSession(): string {
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'db', 'psql', '-U', 'involute', '-d', 'involute', '-v', 'ON_ERROR_STOP=1', '-c',
      `INSERT INTO "Session" (id, "tokenHash", "expiresAt", "userId") SELECT gen_random_uuid(), '${hash}', now() + interval '1 day', id FROM "User" WHERE email = 'admin@involute.local'`],
    { cwd: root, env: { ...process.env, COMPOSE_PROJECT_NAME: process.env.E2E_COMPOSE_PROJECT ?? 'involute-e2e', DB_PORT: process.env.E2E_DB_PORT ?? '5544' }, stdio: 'pipe' },
  );
  return token;
}

test.describe('Involute Capture extension', () => {
  let context: BrowserContext;
  let worker: Worker;
  let userDataDir: string;

  test.beforeAll(async () => {
    execFileSync('pnpm', ['--filter', '@turnkeyai/involute-extension', 'build:e2e'], { cwd: root, stdio: 'inherit' });
    userDataDir = mkdtempSync(join(tmpdir(), 'involute-capture-'));
    // channel 'chromium' is Chromium's new headless mode, which loads extensions.
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: process.env.E2E_HEADED !== 'true',
      viewport: { width: 1280, height: 800 },
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
    });
    worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  });

  test.afterAll(async () => {
    await context?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  test('connects, records, picks, annotates and files a bug placed by the page origin', async ({ request }) => {
    test.setTimeout(120_000);
    // The fixed key gives the unpacked build the ID the connect page trusts.
    expect(new URL(worker.url()).host).toBe(EXTENSION_ID);

    // A project that says the web app is served from this origin.
    const repository = `e2e/capture-${Date.now().toString(36)}`;
    const teams = await gql<{ teams: { nodes: Array<{ id: string; key: string }> } }>(request, '{ teams { nodes { id key } } }');
    const team = teams.teams.nodes.find((candidate) => candidate.key === 'INV') ?? teams.teams.nodes[0]!;
    const previous = await gql<{ projectForOrigin: { id: string } | null }>(request, 'query($o: String!) { projectForOrigin(origin: $o) { id } }', { o: webOrigin });
    if (previous.projectForOrigin) {
      await gql(request, 'mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id: previous.projectForOrigin.id, input: { webOrigins: [] } });
    }
    const project = (await gql<{ issueCreate: { issue: { id: string; identifier: string } } }>(
      request,
      'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier } } }',
      { input: { teamId: team.id, title: 'Capture e2e app', kind: 'PROJECT', repository } },
    )).issueCreate.issue;
    const updated = await gql<{ issueUpdate: { success: boolean; message: string | null } }>(
      request,
      'mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success message } }',
      { id: project.id, input: { webOrigins: [webOrigin] } },
    );
    expect(updated.issueUpdate).toMatchObject({ success: true });

    // A person may hold 10 live connections; earlier runs used some.
    const tokens = await gql<{ extensionTokens: Array<{ id: string; revokedAt: string | null }> }>(request, '{ extensionTokens { id revokedAt } }');
    for (const token of tokens.extensionTokens.filter((entry) => !entry.revokedAt)) {
      await gql(request, 'mutation($id: String!) { extensionTokenRevoke(id: $id) { success } }', { id: token.id });
    }

    // Signed in to Involute in this browser.
    await context.addCookies([{ name: 'involute_session', value: createAdminSession(), domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }]);

    // Options: point it at the local Involute and connect.
    const options = await context.newPage();
    await options.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
    await options.getByLabel('Server URL').fill(webOrigin);
    const connectTab = context.waitForEvent('page');
    await options.getByRole('button', { name: 'Connect', exact: true }).click();
    const connect = await connectTab;
    await connect.waitForLoadState();
    expect(connect.url()).toBe(`${webOrigin}/extension/connect?extension=${EXTENSION_ID}`);
    await expect(connect.getByText('Signed in as')).toBeVisible();
    await connect.getByRole('button', { name: 'Connect extension' }).click();
    await expect(connect.getByText('Connected. You can close this tab')).toBeVisible();
    await connect.close();
    await expect(options.getByText(`Connected to ${webOrigin} as Admin`)).toBeVisible();

    // Another origin that externally_connectable lets message the extension cannot plant a token.
    const stranger = await context.newPage();
    await stranger.goto(`http://localhost:${webPort}/`);
    const reply = await stranger.evaluate((id) => new Promise((done) => {
      const runtime = (globalThis as unknown as { chrome: { runtime: { sendMessage: (id: string, message: unknown, callback: (response: unknown) => void) => void } } }).chrome.runtime;
      runtime.sendMessage(id, { type: 'involute.connect', token: 'inv_ext_planted', server: location.origin, person: { id: 'x', name: 'X', email: null }, expiresAt: '2099-01-01T00:00:00Z' }, done);
    }), EXTENSION_ID);
    expect(reply).toEqual({ ok: false });
    await stranger.close();
    await expect(options.getByText(`Connected to ${webOrigin} as Admin`)).toBeVisible();

    // Managed origin: the recorder runs on the web app from now on.
    await options.getByRole('textbox', { name: 'Origin' }).fill(webOrigin);
    await options.getByRole('button', { name: 'Add' }).click();
    await expect(options.getByRole('button', { name: `Remove ${webOrigin}` })).toBeVisible();
    await options.close();

    // The page with a bug: a console error carrying a secret, and a failed request.
    const target = await context.newPage();
    await target.goto(`${webOrigin}/?capture-e2e=1`);
    await expect(target.getByRole('heading', { name: 'All issues', exact: true })).toBeVisible();
    await target.evaluate(async () => {
      console.error('capture e2e boom token=s3cr3t-e2e-token for jane@example.com');
      // Not signed in on this request: the server answers 401.
      await fetch('/uploads/capture-e2e-missing.png?api_key=k3y-e2e', { method: 'POST', body: 'password=hunter2' }).catch(() => undefined);
    });

    // The side panel page, for that tab, in its own window so the tab stays visible.
    const tabId = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((tab) => tab.url?.includes('capture-e2e=1'))?.id ?? null;
    });
    expect(tabId).not.toBeNull();
    const panelOpened = context.waitForEvent('page');
    await worker.evaluate(async (id) => {
      await chrome.windows.create({ url: chrome.runtime.getURL(`sidepanel.html?tab=${id}`), type: 'normal', width: 420, height: 900 });
    }, tabId);
    const panel: Page = await panelOpened;
    // As narrow as a side panel.
    await panel.setViewportSize({ width: 400, height: 900 });
    const panelErrors: string[] = [];
    panel.on('pageerror', (error) => panelErrors.push(error.message));
    await panel.waitForLoadState();
    await expect(panel.locator('#connection')).toHaveText('Admin');
    await expect(panel.locator('#canvas')).toBeVisible({ timeout: 15_000 });
    // Placed by the page's origin (projectForOrigin → webOrigins), No milestone.
    await expect(panel.locator('#project')).toHaveValue(project.identifier);
    await expect(panel.locator('#location')).toHaveValue(project.identifier);
    await expect(panel.getByLabel('Steps to reproduce')).toHaveValue(new RegExp(`^1\\. Open ${webOrigin}/\\?capture-e2e=1`));

    // Pick the page heading.
    await panel.getByRole('button', { name: 'Pick element' }).click();
    await expect(panel.locator('#notice')).toContainText('Click the element on the page');
    const heading = target.getByRole('heading', { name: 'All issues', exact: true });
    const box = (await heading.boundingBox())!;
    await target.mouse.move(box.x + 5, box.y + box.height / 2);
    await target.mouse.move(box.x + 10, box.y + box.height / 2);
    await target.mouse.click(box.x + 10, box.y + box.height / 2);
    await expect(panel.locator('#picked')).toContainText('Element: ');
    await expect(panel.locator('#picked')).toContainText('All issues');
    const pickedText = (await panel.locator('#picked').textContent())!;
    const selector = pickedText.replace(/^Element: /, '').replace(/ — “.*$/, '');
    expect(await target.evaluate((css) => document.querySelectorAll(css).length, selector)).toBe(1);
    await expect(panel.getByLabel('Steps to reproduce')).toHaveValue(/2\. Click .+All issues/);

    // Draw a box on the screenshot; undo and redo it.
    await expect(panel.locator('#shot-status')).toBeHidden();
    await panel.locator('#canvas').scrollIntoViewIfNeeded();
    const canvas = (await panel.locator('#canvas').boundingBox())!;
    await panel.mouse.move(canvas.x + 20, canvas.y + 20);
    await panel.mouse.down();
    await panel.mouse.move(canvas.x + 120, canvas.y + 80, { steps: 5 });
    await panel.mouse.up();
    await expect(panel.getByRole('button', { name: 'Undo' })).toBeEnabled();
    await panel.getByRole('button', { name: 'Undo' }).click();
    await expect(panel.getByRole('button', { name: 'Redo' })).toBeEnabled();
    await panel.getByRole('button', { name: 'Redo' }).click();

    // "Open larger" opens the same draft in a tab: the screenshot, the annotations, the steps.
    await panel.getByLabel('Description').fill('The heading sits too close to the toolbar.');
    await panel.getByLabel('Description').blur();
    const largerOpened = context.waitForEvent('page');
    await panel.getByRole('button', { name: 'Open larger' }).click();
    const larger = await largerOpened;
    await larger.waitForLoadState();
    expect(larger.url()).toBe(`chrome-extension://${EXTENSION_ID}/sidepanel.html?tab=${tabId}&wide=1`);
    await expect(larger.locator('#canvas')).toBeVisible();
    await expect(larger.getByRole('button', { name: 'Undo' })).toBeEnabled();
    await expect(larger.getByLabel('Description')).toHaveValue('The heading sits too close to the toolbar.');
    await expect(larger.locator('#picked')).toContainText('All issues');
    await larger.close();

    // Fill in and submit.
    const title = `Heading misaligned ${Date.now().toString(36)}`;
    await panel.getByLabel('Title').fill(title);
    await panel.getByRole('button', { name: 'Report bug' }).click();
    await expect(panel.locator('#form-error')).toHaveText('Choose a priority (1 Urgent – 4 Low).');
    await panel.getByLabel('Priority').selectOption('2');
    await panel.getByRole('button', { name: 'Report bug' }).click();
    await expect(panel.locator('#result')).toContainText('Reported ', { timeout: 20_000 });
    const link = panel.locator('#result a');
    const identifier = (await link.textContent())!;
    await expect(link).toHaveAttribute('href', `${webOrigin}/issue/${identifier}`);

    // Read it back as the operator.
    const { issue } = await gql<{
      issue: {
        title: string; description: string; priority: number; capture: Record<string, any>;
        parent: { identifier: string } | null; attachments: Array<{ id: string; mimeType: string; size: number; url: string }>;
        labels: { nodes: Array<{ name: string }> };
      };
    }>(request, 'query($id: String!) { issue(id: $id) { title description priority capture parent { identifier } attachments { id mimeType size url } labels { nodes { name } } } }', { id: identifier });
    expect(issue.title).toBe(title);
    expect(issue.priority).toBe(2);
    expect(issue.parent?.identifier).toBe(project.identifier);
    expect(issue.labels.nodes.map((label) => label.name)).toContain('Bug');
    expect(issue.attachments).toHaveLength(1);
    expect(issue.attachments[0]).toMatchObject({ mimeType: 'image/png' });
    expect(issue.attachments[0]!.size).toBeGreaterThan(1000);
    expect(issue.capture.screenshotAttachmentId).toBe(issue.attachments[0]!.id);
    // Exported at full resolution: the PNG is as wide as the captured viewport in device pixels.
    const png = await request.get(`http://127.0.0.1:${serverPort}${issue.attachments[0]!.url}`, {
      headers: { authorization: `Bearer ${authToken}`, 'x-involute-viewer-assertion': adminAssertion() },
    });
    expect(png.ok()).toBe(true);
    const bytes = await png.body();
    expect(bytes.readUInt32BE(16)).toBe(issue.capture.viewport.width * issue.capture.viewport.dpr);
    expect(issue.capture.element.selector).toBe(selector);
    expect(issue.capture.element.text).toContain('All issues');
    expect(issue.capture.element.box.width).toBeGreaterThan(0);
    expect(issue.capture.viewport).toMatchObject({ width: 1280, height: 800 });
    expect(issue.capture.url).toBe(`${webOrigin}/?capture-e2e=1`);
    expect(issue.description).toContain('### Environment');
    expect(issue.description).toContain(selector.replace(/`/g, "'"));
    // The recorder's buffer, redacted in the browser.
    const consoleMessages = (issue.capture.consoleErrors ?? []).map((entry: { message: string }) => entry.message).join('\n');
    expect(consoleMessages).toContain('capture e2e boom token=[redacted]');
    expect(issue.capture.failedRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'POST', url: `${webOrigin}/uploads/capture-e2e-missing.png?api_key=%5Bredacted%5D`, status: expect.any(Number) }),
    ]));
    expect(panelErrors).toEqual([]);
    const stored = JSON.stringify(issue);
    expect(stored).not.toContain('s3cr3t-e2e-token');
    expect(stored).not.toContain('jane@example.com');
    expect(stored).not.toContain('k3y-e2e');
    expect(stored).not.toContain('hunter2');
  });
});
