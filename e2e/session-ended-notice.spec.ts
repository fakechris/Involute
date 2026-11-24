import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

test.use({ viewport: { width: 320, height: 640 } });

for (const floating of [false, true]) {
  test(`keeps the ${floating ? 'floating' : 'image viewer'} session notice and action inside a 320px viewport`, async ({ page }) => {
    const notice = `
      <div class="page-notice page-notice--session-ended${floating ? ' page-notice--floating' : ''}" role="alert">
        <p class="page-notice__text">Your session ended. Copy any unsaved text before you sign in.</p>
        <a class="ui-action ui-action--accent ui-action--sm" href="/auth/google/start">Sign in</a>
      </div>`;
    await page.setContent(floating ? notice : `
      <body style="overflow: hidden">
        <div class="image-viewer" role="dialog" aria-modal="true" aria-label="Image">
          <button class="image-viewer__backdrop" aria-label="Close image"></button>
          <div class="image-viewer__bar">
            ${notice}
            <button class="ui-action">Rotate left</button>
            <button class="ui-action">Zoom in</button>
            <button class="ui-action">Close</button>
          </div>
        </div>
      </body>`);
    for (const file of ['app.css', 'controls.css', 'layout.css', 'content.css']) {
      await page.addStyleTag({ path: resolve('packages/web/src/styles', file) });
    }

    const alert = page.getByRole('alert');
    const action = alert.getByRole('link', { name: 'Sign in' });
    await expect(alert).toBeInViewport({ ratio: 1 });
    await expect(action).toBeInViewport({ ratio: 1 });
    await action.click({ trial: true });
  });
}
