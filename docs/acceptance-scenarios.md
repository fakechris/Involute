# Acceptance scenarios

Reusable product scenarios for an acceptance pass of the web app. They come from the
manual-driven end-to-end acceptance (INV-1936, follow-ups INV-1937..1946) and the
PM UX audit (INV-2104..2122, INV-2136, INV-2137); each one failed at least once.
Walk them with the [user manual](manual/README.md) as the source of truth for what
each screen should do. Every scenario names the automated test that holds it, so a
pass only needs a person for what a test cannot see (layout, wording, flow).

Write a new scenario here when an acceptance finding is a pattern that can recur on
another screen, not a one-off defect.

## 1. Signed-out and expired sessions

| Given / When | Then | Held by |
| --- | --- | --- |
| Any page's request answers with an expired session (INV-2104) | The page leads to **Sign in**, not **Retry**, and removes signed-in controls | `web/src/App.sign-in.test.tsx` |
| A form is open with unsaved text when a poll or tab return finds the session expired (INV-2136) | The form and its draft stay; one session notice is shown, inside a dialog when one is open | `web/src/App.sign-in.test.tsx`, `e2e/session-ended-notice.spec.ts` |
| Sign-in completes after expiry | The person returns to the same path, filters and anchor | `web/src/App.sign-in.test.tsx` |
| A drawer section fails with an auth error (INV-2137) | It shows the session message, never a raw `Not authenticated` | `web/src/components/WorkLinks.test.tsx` |
| A request fails with a server error (500) | It stays a retryable error | `web/src/App.sign-in.test.tsx` |

## 2. Failure, empty and no-match are three different states

| Given / When | Then | Held by |
| --- | --- | --- |
| A list request fails (My Issues, Projects, Activity) (INV-2114) | The page says it could not load and offers **Retry**; it never says "no data" or "no access" | `web/src/routes/list-load-errors.test.tsx` |
| A page tells the person to retry (INV-2115) | A **Retry** control is on the page and keeps the current filters | `web/src/routes/list-load-errors.test.tsx` |
| Filters match nothing (INV-2121) | The page says nothing matches and offers to clear the filters, not "nothing assigned" | `web/src/routes/MyIssuesPage.test.tsx` |
| Metrics have no samples (INV-1939) | The page shows no samples, never a zero duration | `web/src/routes/DeliveryPage.test.tsx`, `server/src/incident-metrics.test.ts` |

## 3. Direct links and context

| Given / When | Then | Held by |
| --- | --- | --- |
| A signed-in person opens a deep link before visiting the board (INV-2119) | The page loads the accessible team instead of asking for one | `web/src/routes/DeliveryPage.test.tsx` |
| The selected team is saved and the app reloads | The first board query already uses the saved team | `web/src/App.team-selection.test.tsx` |
| A person cancels a flow started from a list (INV-2118) | They return to that list with its filters | `web/src/routes/BugsPage.test.tsx` |
| A saved view opens its page (INV-1941) | The page applies the view's filters | `web/src/routes/ViewsPage.test.tsx` |
| Search is IQL-only (INV-1946) | The page says so until a keyword is entered | `web/src/App.search.test.tsx` |

## 4. Keyboard and focus

| Given / When | Then | Held by |
| --- | --- | --- |
| A drawer opens from a board card (INV-2116) | Tab stays in the drawer; Esc closes it and focus returns to the card | `web/src/App.board-drawer.test.tsx` |
| A board column is collapsed with the keyboard (INV-2117) | It can be expanded with the keyboard, focus kept on the toggle | `web/src/components/Column.test.tsx` |
| Two panes scroll and J/K selects (INV-2105) | Only the decision pane resets; each pane scrolls on its own | `web/src/routes/AttentionPage.test.tsx` |
| A documented shortcut is pressed (INV-1945) | It does what the shortcuts list says | `web/src/App.shortcuts.test.tsx`, `web/src/App.palette.test.tsx` |

## 5. Created and changed work shows up where the person looks

| Given / When | Then | Held by |
| --- | --- | --- |
| A milestone is created on the Milestones page (INV-1937) | It is listed at once and after a reload | `e2e/work-graph.spec.ts` |
| Work is created under a project with no repository (INV-1943) | The new item shows that project on the first open | `e2e/board-flow.spec.ts` |
| Work is In Review (INV-2120) | My Issues groups it as In Review and can filter by it | `web/src/routes/MyIssuesPage.test.tsx` |
| A bug was committed directly (INV-2113) | Activity does not link it to Needs you as pending | `web/src/routes/InboxPage.test.tsx`, `server/src/notification-resolution.test.ts` |
| A batch close is refused for one item (INV-1944) | Only the refused item stays selected, with its reason | `web/src/App.batch-close.test.tsx` |
| Candidate and project counts are shown (INV-1942) | They count committed work only, across all repositories | `server/src/issues-filter.test.ts`, `web/src/App.project-progress.test.tsx` |

## 6. Guidance in text

| Given / When | Then | Held by |
| --- | --- | --- |
| A rule blocks an action (INV-2122) | The page says how to resolve it in plain English | `web/src/App.hygiene.test.tsx` |
| The server refuses a change | The page shows the server's reason | `web/src/routes/BugsPage.test.tsx` |

Words on screen follow [design system §3 rule 12](design-system.md); a scenario
checks that guidance exists, not its exact wording.

## Keeping the test suite lean

- One behavior, one test: before adding a test, search for its title and for the
  route or component it renders. Two files must not hold the same test.
- A test asserts what its title says. A test with no assertion, or a title that
  contradicts its body, is fixed or removed.
- A test that needs a database lives in a block gated on `DATABASE_URL`.
- A test for removed behavior is removed with the behavior.
