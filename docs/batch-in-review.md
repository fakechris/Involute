# INV-12: Batch In Review UI

Human-initiated bulk accept / reject-return for committed work in **In Review**.
Complements INV-11 graded auto-accept - does **not** replace human judgment for a
selected set. Agents still cannot silently move work to Done.

## Surfaces

1. **`/in-review`** - dedicated queue
   - Default filter: committed + state name `In Review`, plus IQL `state:"In Review"`
   - Multi-select checkboxes
   - **Bulk accept** and **Bulk reject / return** call `workReview` (audited)
2. **Board** - existing multi-select bulk bar
   - **Filter In Review** quick action (IQL + state filter)
   - When selection includes In Review cards: bulk accept / return via `workReview`

## Audit

Each decision goes through GraphQL `workReview` -> server `reviewWork`, which:

- Requires a **HUMAN** actor
- Writes `WorkReviewDecision` + work audit
- Emits `work.accepted` / `work.review_rejected`
- Accept -> `COMPLETED` (Done); Reject -> `UNSTARTED` (return)

## Verify

1. Open `/in-review` (nav **In Review** or `G N`).
2. Confirm the IQL filter defaults to `state:"In Review"`.
3. Select two or more cards -> **Bulk accept** / **Bulk reject / return**.
4. On each item's work context page, confirm a review decision + audit appear.
5. On the board: **Filter In Review**, multi-select, use bulk accept/return.
