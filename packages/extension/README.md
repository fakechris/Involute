# Involute Capture

A Chrome (Manifest V3) extension that files an Involute bug from the page you
are looking at: a screenshot you can annotate, the element you point at, and —
on origins you choose — the page's recent console errors and failed requests.
It is not published to the Chrome Web Store; you load it unpacked (INV-1147).

## Install

```sh
pnpm install
pnpm --filter @turnkeyai/involute-extension build   # writes packages/extension/dist
```

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → choose `packages/extension/dist`.
3. The extension ID must be `gggpgjhcjmonhaipcmeeaejlncgihbge`. The manifest
   carries a fixed public key, so every unpacked install has this ID, and
   Involute's connect page only hands a token to it.
4. Optional: pin it, and check the shortcut at `chrome://extensions/shortcuts`
   (suggested **Alt+Shift+B**).

After pulling changes, run the build again and press the reload button on the
extension's card.

## Connect

1. Right-click the toolbar button → **Options** (or the extension's card →
   Details → Extension options).
2. **Server URL**: `https://involute.lumenopen.com` by default; for local
   development the web app's address (for example `http://127.0.0.1:4201`).
3. **Connect**: Chrome asks for access to that server, then Involute's
   `/extension/connect` page opens. Sign in if needed and press **Connect
   extension**. Options then shows who it is connected as and when the
   connection expires (90 days).
4. **Disconnect** removes the token from the extension. A token cannot revoke
   itself: to revoke it, open Involute → **Settings → Extensions**.

The extension accepts a token only from a page on the configured server's
origin (Chrome tells it the sender's origin). Only the background service
worker holds the token and talks to Involute, with `Authorization: Bearer`.
The token can only report bugs, upload their screenshots and read where a bug
can go (INV-1145).

Local development: the dev web server and the API run on different ports, so
start Vite with `INVOLUTE_DEV_API_PROXY=http://127.0.0.1:<server port>` to
serve `/graphql` from the web app's origin (the e2e setup does this).

## Report a bug

Click the toolbar button (or the shortcut) on the page. The side panel opens
and takes a screenshot of the visible tab.

- **Annotate**: Box, Arrow, Text (type the text, then click where it goes),
  Blur (pixelates a region), Undo / Redo (also ⌘/Ctrl+Z, ⇧⌘/Ctrl+Shift+Z).
  **Open larger** opens the same editor in a tab. The PNG is exported at full
  resolution.
- **Pick element**: hover the page, click the element (Esc cancels). Its
  selector, text, box and a few computed styles go with the report, and its box
  is drawn on the screenshot.
- **Form**: title (open bugs with similar titles are listed while you type),
  steps to reproduce (prefilled with the page and the picked element),
  description, priority (required), severity (optional), and where it belongs:
  the project whose *web origins* include this page is preselected (set them
  on Involute's Projects page), then No milestone / a milestone / an epic, or
  **Not sure — send to triage**.
- **Report bug** uploads the screenshot, files the bug and links to it.

## Managed origins

In Options, add the origins of the apps you report on (for example
`https://app.example.com`). Chrome asks for access to each. On those origins
only, a small recorder runs in the page from the moment it starts loading and
keeps the last 50 of:

- `console.error` / `console.warn` messages, uncaught errors and unhandled
  promise rejections;
- failed `fetch` / `XMLHttpRequest` requests: method, URL, status and duration.

The recorder calls the page's own functions first and never lets an error of
its own reach the page. Removing an origin stops it there and gives back the
access.

## What is collected — and what never is

Sent with a report: the screenshot (as you annotated it), page URL and title,
viewport size and pixel ratio, user agent, light/dark preference, the page's
`<meta name="involute-version">`, the picked element (selector, visible text up
to 200 characters, box, these computed styles: font-family, font-size,
font-weight, line-height, color, background-color, padding, margin, width,
height, display, position, z-index, overflow) and, on managed origins only, the
recorder's console errors and failed requests (the newest 20 of each).

Redacted in the browser before anything is sent: values of query, fragment and
field names that look like credentials (token, key, secret, password, session,
auth, cookie…), `Authorization`/`Bearer`-style credentials, emails, JWTs, long
hex or base64 strings, and `sk_…`/`cus_…`-style ids — in URLs, console
messages, element text and selectors.

Never read or sent: cookies, request or response bodies, request or response
headers, form field values, other tabs, browsing history. The extension does
not use `chrome.debugger` or `webRequest`, asks for no host access up front
(`activeTab` covers the page you clicked it on), and records nothing on
origins you did not add.

## Develop

```sh
pnpm --filter @turnkeyai/involute-extension test --run   # unit tests (vitest, jsdom)
pnpm --filter @turnkeyai/involute-extension lint         # tsc
pnpm --filter @turnkeyai/involute-extension build        # dist/
pnpm e2e e2e/capture-extension.spec.ts                   # Playwright against the local stack
```

Every GraphQL document the extension sends is in `src/api/operations.ts`; the
server test `packages/server/src/extension-operations.test.ts` runs each one
through the extension-token gate and the server, so the two cannot drift.

The e2e test loads `dist-e2e` (`build:e2e`), which differs from `dist` only by
`host_permissions: ["<all_urls>"]`: Playwright cannot click Chrome's permission
prompt or the toolbar button that grants `activeTab`. It opens the panel page in
its own window with the tab's id, as the background does for the side panel.
