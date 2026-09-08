# INV-11: Graded auto-accept

## Goal

After `run_report` / `evidence_attach` move work to **In Review**, some work can
move to **Done** without a full manual review when the evidence is *objectively*
verifiable (checks green, PR merged, test exit 0, etc.).

This must not weaken the human-only Done path for ambiguous work, and agents
must remain unable to freely mark Done (no MCP accept tool).

## Tiers

| Tier | Meaning | Auto-Done? |
|---|---|---|
| `CLEAR` | Completed run + at least one objective pass signal, and no fail signals | Yes |
| `LIKELY` | Completed run + PR/TEST evidence without parseable objective signals | No |
| `AMBIGUOUS` | Completed run + only soft evidence (log / screenshot / artifact / decision) | No |
| `INSUFFICIENT` | Missing completed run and/or missing evidence | No |

Only **`CLEAR`** is eligible for auto-Done. The surface stays intentionally
narrow; widen tiers only with new tests and an explicit design revision.

## Objective signals

Parsed from evidence `summary` as case-insensitive `key: value` tokens
(whitespace / punctuation tolerant):

| Signal | Pass | Fail |
|---|---|---|
| `merged` | `true` / `merged` / `yes` | `false` / `no` / `open` |
| `checks` | `green` / `pass` / `passed` / `success` | `red` / `fail` / `failed` / `pending` |
| `exit` | `0` | any non-zero integer |
| `status` / `result` | `pass` / `passed` / `success` / `ok` / `green` | `fail` / `failed` / `error` / `red` |

Kind rules:

- **PR** — CLEAR needs `merged=pass` **or** (`checks=pass` **and** `merged=pass`).
  A PR with only `checks=green` and no merge signal is LIKELY, not CLEAR.
- **TEST** — CLEAR needs `exit=0` or `status`/`result` pass.
- **LOG / SCREENSHOT / ARTIFACT / DECISION** — never raise the tier to CLEAR by
  themselves (soft evidence).

Any fail signal on the evaluated evidence set forces the tier below CLEAR
(typically AMBIGUOUS).

## Gate runner

`evaluateAutoAcceptGrade(input)` is pure and side-effect free.

`tryAutoAccept(prisma, workId, …)`:

1. Loads work, workflow state, latest completed run, run-bound evidence.
2. Grades the bundle.
3. **Always** writes a `WorkAutoAcceptEvaluation` row (audit trail for both
   ACCEPTED and SKIPPED).
4. Emits `work.auto_accept_evaluated`.
5. If tier is `CLEAR` **and** work is still `REVIEW`, applies Done via the
   internal SERVICE path (creates `WorkReviewDecision` with reason
   `auto-accept:CLEAR`, audit, and `work.accepted`).

Triggers (same DB transaction as the primary mutation when possible):

- after a run reaches `COMPLETED` and work moves to In Review
- after evidence is attached while work is already In Review

Failures in the gate must not hide primary `run_report` / `evidence_attach`
errors; evaluation errors are recorded as SKIPPED with reasons when feasible.

## Audit trail

Every gate pass leaves:

- `WorkAutoAcceptEvaluation` — tier, outcome, reasons[], signals JSON, optional
  `decisionId`, run id
- `WorkAudit` — when Accepted (state transition)
- outbox events — `work.auto_accept_evaluated`, and `work.accepted` when applied

## Failure modes

| Mode | Behavior |
|---|---|
| Ambiguous / insufficient evidence | SKIPPED; stays In Review for humans |
| Concurrent human accept/reject | revision / state guard; gate no-ops |
| Agent calls accept | still FORBIDDEN (`Agents cannot accept…`); no MCP tool |
| Contradictory fail signal | never CLEAR |
| Gate exception | primary mutation still commits; evaluation may be absent or SKIPPED |

## Explicit non-goals (this PR)

- No MCP `work_review` / Done tool for agents
- No auto-Done for LIKELY / AMBIGUOUS
- No remote GitHub API polling; agents declare objective signals in evidence
  summaries they attach
- No Ops / runtime infra changes beyond schema migration + server code
