# Acceptance scenarios

Reusable product scenarios for an acceptance pass of the web app. They come from the
manual-driven end-to-end acceptance (INV-1936, follow-ups INV-1937..1946) and the
PM UX audit (INV-2104..2122, INV-2136, INV-2137); each one failed at least once.
Walk them with the [user manual](manual/README.md) as the source of truth for what
each screen should do. Every scenario names the automated test that holds it, so a
pass only needs a person for what a test cannot see (layout, wording, flow).

Write a new scenario here when an acceptance finding is a pattern that can recur on
another screen, not a one-off defect.

## Journeys walked end to end

Each manual chapter's main flow, and the Playwright spec (`e2e/`) that walks it
through the real server and browser. A gap is walked by hand in an acceptance pass.

| Manual chapter | Journey | End-to-end test |
| --- | --- | --- |
| Getting started | New project → `C` → first issue under No milestone → found on Backlog and in Search | `e2e/manual-journeys.spec.ts` |
| Work items | Create, edit, comment, delete a comment, delete the issue on Board | `e2e/board-flow.spec.ts` |
| Views and search | Search by identifier | `e2e/manual-journeys.spec.ts` |
| Views and search | Save a Backlog view and reopen it from Views | Gap: the view is not stored in token sign-in mode (INV-2157) |
| Candidates | Commit a candidate and place it under a parent | `e2e/work-graph.spec.ts`, `e2e/mcp-ui-conformance.spec.ts` |
| In Review | Agent claims, reports and attaches evidence; person returns, then accepts | `e2e/mcp-ui-conformance.spec.ts` |
| Projects and delivery | Create a milestone; create work in a milestone; delivery drill-down | `e2e/work-graph.spec.ts`, `e2e/delivery.spec.ts` |
| Bugs and incidents | Report a bug, triage it with a priority, see its SLA | `e2e/work-graph.spec.ts` |
| Agents and settings | Agent credential scopes and Revoke on the Agents page; manage a webhook on Ops | `e2e/mcp-ui-conformance.spec.ts`, `e2e/work-graph.spec.ts` |
| Signed-out states | Session ends with an open form | `e2e/session-ended-notice.spec.ts` |
| Bug capture extension | Connect, record, annotate and file a bug | `e2e/capture-extension.spec.ts` |
| Needs you and Activity | Decide an item from Needs you; read Activity | Gap: unit tests only (`AttentionPage`, `InboxPage`) |
| Bugs and incidents | Declare and resolve an incident | Gap: unit tests only (`IncidentsPage`) |

The scenarios below are the per-screen checks, each held by a unit test.

## 1. Signed-out and expired sessions

| Given / When | Then | Held by |
| --- | --- | --- |
| Any page's request answers with an expired session (INV-2104) | The page leads to **Sign in**, not **Retry**, and removes signed-in controls | `packages/web/src/App.sign-in.test.tsx` |
| A form is open with unsaved text when a poll or tab return finds the session expired (INV-2136) | The form and its draft stay; one session notice is shown, inside a dialog when one is open | `packages/web/src/App.sign-in.test.tsx`, `e2e/session-ended-notice.spec.ts` |
| Sign-in completes after expiry | The person returns to the same path, filters and anchor | `packages/web/src/App.sign-in.test.tsx` |
| A drawer section fails with an auth error (INV-2137) | It shows the session message, never a raw `Not authenticated` | `packages/web/src/components/WorkLinks.test.tsx` |
| A request fails with a server error (500) | It stays a retryable error | `packages/web/src/App.sign-in.test.tsx` |

## 2. Failure, empty and no-match are three different states

| Given / When | Then | Held by |
| --- | --- | --- |
| A list request fails (My Issues, Projects, Activity) (INV-2114) | The page says it could not load and offers **Retry**; it never says "no data" or "no access" | `packages/web/src/routes/list-load-errors.test.tsx` |
| A page tells the person to retry (INV-2115) | A **Retry** control is on the page and keeps the current filters | `packages/web/src/routes/list-load-errors.test.tsx` |
| Filters match nothing (INV-2121) | The page says nothing matches and offers to clear the filters, not "nothing assigned" | `packages/web/src/routes/MyIssuesPage.test.tsx` |
| Metrics have no samples (INV-1939) | The page shows no samples, never a zero duration | `packages/web/src/routes/DeliveryPage.test.tsx`, `packages/server/src/incident-metrics.test.ts` |

## 3. Direct links and context

| Given / When | Then | Held by |
| --- | --- | --- |
| A signed-in person opens a deep link before visiting the board (INV-2119) | The page loads the accessible team instead of asking for one | `packages/web/src/routes/DeliveryPage.test.tsx` |
| The selected team is saved and the app reloads | The first board query already uses the saved team | `packages/web/src/App.team-selection.test.tsx` |
| A person cancels a flow started from a list (INV-2118) | They return to that list with its filters | `packages/web/src/routes/BugsPage.test.tsx` |
| A saved view opens its page (INV-1941) | The page applies the view's filters | `packages/web/src/routes/ViewsPage.test.tsx` |
| Search is IQL-only (INV-1946) | The page says so until a keyword is entered | `packages/web/src/App.search.test.tsx` |

## 4. Keyboard and focus

| Given / When | Then | Held by |
| --- | --- | --- |
| A drawer opens from a board card (INV-2116) | Tab stays in the drawer; Esc closes it and focus returns to the card | `packages/web/src/App.board-drawer.test.tsx` |
| A board column is collapsed with the keyboard (INV-2117) | It can be expanded with the keyboard, focus kept on the toggle | `packages/web/src/components/Column.test.tsx` |
| Two panes scroll and J/K selects (INV-2105) | Only the decision pane resets; each pane scrolls on its own | `packages/web/src/routes/AttentionPage.test.tsx` |
| A documented shortcut is pressed (INV-1945) | It does what the shortcuts list says | `packages/web/src/App.shortcuts.test.tsx`, `packages/web/src/App.palette.test.tsx` |

## 5. Created and changed work shows up where the person looks

| Given / When | Then | Held by |
| --- | --- | --- |
| A milestone is created on the Milestones page (INV-1937) | It is listed at once and after a reload | `e2e/work-graph.spec.ts` |
| Work is created under a project with no repository (INV-1943) | The new item shows that project on the first open | `e2e/board-flow.spec.ts` |
| Work is In Review (INV-2120) | My Issues groups it as In Review and can filter by it | `packages/web/src/routes/MyIssuesPage.test.tsx` |
| A bug was committed directly (INV-2113) | Activity does not link it to Needs you as pending | `packages/web/src/routes/InboxPage.test.tsx`, `packages/server/src/notification-resolution.test.ts` |
| A batch close is refused for one item (INV-1944) | Only the refused item stays selected, with its reason | `packages/web/src/App.batch-close.test.tsx` |
| Candidate and project counts are shown (INV-1942) | They count committed work only, across all repositories | `packages/server/src/issues-filter.test.ts`, `packages/web/src/App.project-progress.test.tsx` |

## 6. Guidance in text

| Given / When | Then | Held by |
| --- | --- | --- |
| A rule blocks an action (INV-2122) | The page says how to resolve it in plain English | `packages/web/src/App.hygiene.test.tsx` |
| The server refuses a change | The page shows the server's reason | `packages/web/src/routes/BugsPage.test.tsx` |

Words on screen follow [design system §3 rule 12](design-system.md); a scenario
checks that guidance exists, not its exact wording.

## Keeping the test suite lean

- One behavior, one test: before adding a test, search for its title and for the
  route or component it renders. Two files must not hold the same test.
- A test asserts what its title says. A test with no assertion, or a title that
  contradicts its body, is fixed or removed.
- A test that needs a database lives in a block gated on `DATABASE_URL`.
- A test for removed behavior is removed with the behavior.
