import { runOperation } from './api/client';
import { isOperationName } from './api/operations';
import { CaptureQueue } from './lib/capture-queue';
import { decideConnect, normalizeOrigin, recorderPatterns, originPattern } from './lib/connect';
import type { CaptureResult, PanelRequest, Reply } from './lib/messages';
import { connectionStatus, loadSettings, saveSettings } from './lib/settings';
import type { PageInfo, RecorderSnapshot } from './lib/types';

/**
 * The background service worker of Involute Capture (INV-1147): it alone holds
 * the extension token and talks to Involute; it takes every screenshot through
 * one queue; it registers the context recorder for the origins the person
 * chose; and it accepts a token only from the configured server's own page.
 */
const RECORDER_ID = 'involute-recorder';
const queue = new CaptureQueue();
/** Captures started from the toolbar or shortcut, for the panel that opens with them. */
const pending = new Map<number, Promise<CaptureResult>>();

const fail = (error: unknown): Reply<never> => ({ ok: false, error: error instanceof Error ? error.message : String(error) });

// ---- Opening the panel and starting a capture -------------------------------

function openFor(tab: chrome.tabs.Tab | undefined): void {
  if (!tab?.id) return;
  const tabId = tab.id;
  // sidePanel.open must run inside the user gesture: no await before it.
  void chrome.sidePanel.setOptions({ tabId, path: `sidepanel.html?tab=${tabId}`, enabled: true });
  void chrome.sidePanel.open({ tabId }).catch(() => undefined);
  const capture = takeCapture(tabId);
  capture.catch(() => undefined);
  pending.set(tabId, capture);
}

chrome.action.onClicked.addListener((tab) => openFor(tab));
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'capture-bug') openFor(tab);
});

// ---- Capture ----------------------------------------------------------------

/** Runs in the page (ISOLATED world): hide the extension's overlays, wait two frames, describe the page. */
async function prepareInPage(): Promise<PageInfo> {
  for (const element of document.querySelectorAll<HTMLElement>('[data-involute-capture]')) {
    element.dataset.involuteCaptureHidden = element.style.visibility || 'visible';
    element.style.visibility = 'hidden';
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 250);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    }));
  });
  const meta = document.querySelector<HTMLMetaElement>('meta[name="involute-version"]');
  return {
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    userAgent: navigator.userAgent,
    colorScheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    appVersion: meta?.content?.trim() || null,
  };
}

/** Runs in the page: put the overlays back. */
function restoreInPage(): void {
  for (const element of document.querySelectorAll<HTMLElement>('[data-involute-capture-hidden]')) {
    element.style.visibility = element.dataset.involuteCaptureHidden === 'visible' ? '' : element.dataset.involuteCaptureHidden ?? '';
    delete element.dataset.involuteCaptureHidden;
  }
}

/** Runs in the page's MAIN world: the recorder's buffer, if the recorder runs here. */
function readRecorder(): RecorderSnapshot | null {
  const recorder = (window as unknown as Record<string, { snapshot?: () => RecorderSnapshot } | undefined>).__involuteCaptureRecorder;
  try {
    return recorder && typeof recorder.snapshot === 'function' ? JSON.parse(JSON.stringify(recorder.snapshot())) as RecorderSnapshot : null;
  } catch {
    return null;
  }
}

async function activeTab(tabId: number): Promise<chrome.tabs.Tab> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error('The tab this report is for was closed.');
  }
  if (!tab.active) throw new Error('Switch back to the tab you are reporting on: only the visible tab can be captured.');
  return tab;
}

function takeCapture(tabId: number): Promise<CaptureResult> {
  return queue.run(async () => {
    const tab = await activeTab(tabId);
    let page: PageInfo;
    try {
      const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: prepareInPage });
      page = injection!.result as PageInfo;
    } catch {
      throw new Error('Involute Capture cannot read this page. Click the Involute Capture button on the page itself (browser pages and the Web Store cannot be captured).');
    }
    let screenshot: string;
    try {
      screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } catch (error) {
      throw new Error(`The screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await chrome.scripting.executeScript({ target: { tabId }, func: restoreInPage }).catch(() => undefined);
    }
    // The capture is of the window's visible tab: make sure that was still ours.
    const after = await chrome.tabs.get(tabId).catch(() => null);
    if (!after?.active || after.windowId !== tab.windowId) {
      throw new Error('The tab changed while the screenshot was taken. Stay on the page and retake it.');
    }
    const settings = await loadSettings();
    const origin = normalizeOrigin(page.url);
    let recorder: RecorderSnapshot | null = null;
    if (origin && settings.managedOrigins.includes(origin)) {
      const [injection] = await chrome.scripting
        .executeScript({ target: { tabId }, world: 'MAIN', func: readRecorder })
        .catch(() => [] as chrome.scripting.InjectionResult<RecorderSnapshot | null>[]);
      recorder = (injection?.result as RecorderSnapshot | null | undefined) ?? null;
    }
    return { tabId, screenshot, page, recorder, takenAt: Date.now() };
  });
}

// ---- Context recorder registration ------------------------------------------

async function syncRecorder(): Promise<string[]> {
  const settings = await loadSettings();
  const granted: string[] = [];
  for (const origin of settings.managedOrigins) {
    if (await chrome.permissions.contains({ origins: [originPattern(origin)] })) granted.push(origin);
  }
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [RECORDER_ID] }).catch(() => []);
  if (registered.length > 0) await chrome.scripting.unregisterContentScripts({ ids: [RECORDER_ID] });
  if (granted.length > 0) {
    await chrome.scripting.registerContentScripts([
      {
        id: RECORDER_ID,
        js: ['recorder.js'],
        matches: recorderPatterns(granted),
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false,
        persistAcrossSessions: true,
      },
    ]);
  }
  return granted;
}

chrome.runtime.onInstalled.addListener(() => void syncRecorder().catch(() => undefined));
chrome.runtime.onStartup.addListener(() => void syncRecorder().catch(() => undefined));
// A host permission removed in chrome://extensions stops the recorder there too.
chrome.permissions.onRemoved.addListener(() => void syncRecorder().catch(() => undefined));

// ---- Messages from the extension's pages ------------------------------------

async function handle(request: PanelRequest): Promise<unknown> {
  switch (request.type) {
    case 'capture.take':
      return takeCapture(request.tabId);
    case 'capture.get': {
      const started = pending.get(request.tabId);
      if (!started) return null;
      pending.delete(request.tabId);
      return started;
    }
    case 'picker.start':
      await activeTab(request.tabId);
      try {
        await chrome.scripting.executeScript({ target: { tabId: request.tabId }, files: ['picker.js'] });
      } catch {
        throw new Error('The picker cannot run on this page. Click the Involute Capture button on the page itself first.');
      }
      return true;
    case 'graphql': {
      if (!isOperationName(request.name)) throw new Error('Unknown operation.');
      const settings = await loadSettings();
      if (!settings.connection) throw new Error('Connect the extension to Involute first (Options → Connect).');
      return runOperation(fetch, settings.connection, request.name, request.variables ?? {});
    }
    case 'connection.get':
      return connectionStatus(await loadSettings());
    case 'connection.clear':
      await saveSettings({ connection: null });
      return connectionStatus(await loadSettings());
    case 'recorder.sync':
      return syncRecorder();
    default:
      throw new Error('Unknown request.');
  }
}

chrome.runtime.onMessage.addListener((request: PanelRequest, sender, sendResponse) => {
  // Only the extension's own pages (panel, editor tab, options); the picker in a page talks to the panel.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  if (!request || typeof request !== 'object' || typeof request.type !== 'string') return false;
  handle(request).then((value) => sendResponse({ ok: true, value }), (error) => sendResponse(fail(error)));
  return true;
});

// ---- The token from /extension/connect --------------------------------------

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  void (async () => {
    try {
      const settings = await loadSettings();
      const decision = decideConnect(message, sender.origin, settings.server);
      if (!decision.accept) {
        sendResponse({ ok: false });
        return;
      }
      await saveSettings({ connection: decision.connection });
      sendResponse({ ok: true });
    } catch {
      sendResponse({ ok: false });
    }
  })();
  return true;
});
