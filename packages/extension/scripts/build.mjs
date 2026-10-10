// Build Involute Capture into dist/ (INV-1147): esbuild bundles each entry as
// a self-contained script (the service worker, the pages, and the two page
// scripts injected with chrome.scripting), and static/ is copied beside them.
//
// --e2e writes dist-e2e/ for the Playwright test: the same code, plus
// host_permissions <all_urls>. Playwright cannot click Chrome's native
// permission prompt, nor the toolbar button or a command shortcut that grant
// activeTab (captureVisibleTab needs activeTab or <all_urls>). The production
// dist asks for hosts at runtime and captures under activeTab.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const e2e = process.argv.includes('--e2e');
const outdir = join(root, e2e ? 'dist-e2e' : 'dist');

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: {
    background: 'src/background.ts',
    panel: 'src/pages/panel.ts',
    options: 'src/pages/options.ts',
    picker: 'src/content/picker.ts',
    recorder: 'src/content/recorder.ts',
  },
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  outdir,
  sourcemap: e2e ? 'inline' : false,
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
});

for (const file of ['sidepanel.html', 'options.html', 'panel.css']) cpSync(join(root, 'static', file), join(outdir, file));

const manifest = JSON.parse(readFileSync(join(root, 'static', 'manifest.json'), 'utf8'));
if (e2e) manifest.host_permissions = ['<all_urls>'];
writeFileSync(join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Involute Capture ${manifest.version} → ${outdir}`);
