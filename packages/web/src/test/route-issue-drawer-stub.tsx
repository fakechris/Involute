/**
 * Stands in for RouteIssueDrawer in page tests (INV-1387), which mock only the
 * page's own queries: the drawer shows which issue it was asked for and
 * closes like the real one. Use with
 * `vi.mock('../components/RouteIssueDrawer', () => import('../test/route-issue-drawer-stub'))`.
 */
export function RouteIssueDrawer({ issueRef, onClose }: { issueRef: string; onClose: () => void }) {
  return (
    <aside role="dialog" aria-label="Issue detail drawer">
      <span data-testid="drawer-issue">{issueRef}</span>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </aside>
  );
}
