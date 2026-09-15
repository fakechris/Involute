# Evidence verification

Evidence submitted by a client remains a declaration. A service-owned GitHub App verifier appends observations separately, checking the repository, PR head, workflow run attempt and mapped jobs through the official API. It never fetches a submitted URL directly or follows redirects.

Acceptance is **shadow-only** in this version. Completed runs, attached evidence and GitHub merges stop at Review. Even a CLEAR grade records a SKIPPED evaluation; only human review changes work to Done. GitHub merge evidence is appended without overwriting the original declaration. Existing terminal work remains terminal.

## Define a machine-verifiable contract

The existing acceptance string can contain versioned JSON:

```json
{
  "version": 1,
  "criteria": [
    { "id": "api-tests", "required": true, "workflowId": 123456, "job": "verify" },
    { "id": "browser-tests", "required": true, "workflowId": 123456, "job": "e2e" }
  ]
}
```

Use stable, unique criterion IDs and actual numeric workflow IDs. A criterion maps to an exact job name in that workflow. All matching jobs must have completed successfully; skipped/neutral jobs do not cover a criterion. A successful workflow without a required job does not satisfy the contract. A PR observation alone provides no test coverage. Free-text acceptance remains valid for human review but cannot establish machine coverage.

On run creation the server freezes the contract snapshot and two SHA-256 hashes: the semantic `contractRevision` (scope, acceptance, constraints and repository) and `acceptanceDigest`. Workflow state, priority and general audit revision changes do not change this version. Changing a semantic field requires a new run; restoring identical semantic content restores the same content-addressed version.

Bind the execution before completing it:

```text
run_report(work_id, run_id, commit_sha=<40 lowercase hex>, pr_number=<positive integer>)
```

GraphQL uses `commitSha` / `pullRequestNumber`; CLI uses `--commit-sha` / `--pr-number`. These fields are declarations. The verifier independently checks the PR's base repository and current head, requires it to be merged, and verifies Actions runs against the declared head SHA. A merge commit SHA or a synthetic PR test merge SHA does not substitute for the PR head SHA. Attach an Actions run that actually ran on that head; mismatches remain unverified.

For Actions evidence, the verifier also requires GitHub’s commit-to-merged-PR association from the commit pull-requests API. This verifies checks on the associated commit; it does not attest which PR triggered the workflow or cryptographically prove the checkout performed by workflow steps. Push runs can qualify for the same associated head commit. Missing or incomplete association remains UNAVAILABLE.

A run keeps its original claim identity after normal claim cleanup. A newer attempt, replacement lease, changed execution target or human rejection disqualifies old observations. Targets may change while a run is open, invalidating old results; completed run targets remain frozen.

## Configure the operator

Apply the additive migration before starting upgraded writers. The migration leaves historical run snapshots empty and historical evidence unrequested; it does not backfill VERIFIED records.

Configure these server environment variables using the deployment's secret storage:

- `GITHUB_VERIFICATION_REPOSITORIES`: exact, comma-separated `owner/repo` allowlist.
- `GITHUB_VERIFICATION_APP_ID` and `GITHUB_VERIFICATION_INSTALLATION_ID`.
- `GITHUB_VERIFICATION_PRIVATE_KEY_PATH`: mounted private-key file, never a repository file.
- `EVIDENCE_VERIFIER_ENABLED=true`: opt in to background observation. Default is disabled.

The App installation needs read access to Actions, pull requests and contents. The service mints short-lived installation tokens restricted to the requested repository; it does not reuse a client token or the general sync token. Credentials, raw HTTP errors and response bodies are excluded from observation/error logs.

For a single requested evidence record, a trusted database operator can run:

```bash
pnpm --filter @turnkeyai/involute-server evidence:verify <evidence-uuid>
```

This operator command is not an MCP/GraphQL mutation. It appends observations and cannot accept work. Exit 0 means the source observation is VERIFIED, **not** that the whole work contract is satisfied. Exit 2 means another observation status; exit 1 means invocation or execution failed.

## Read results and recover

MCP `work_get_context` and GraphQL `WorkEvidenceRecord.verifications` expose the observation history. PENDING is followed by a separate VERIFIED, FAILED, UNAVAILABLE or STALE record. Records preserve the execution/contract binding, external run ID, verifier version, observed time and result digest. Read stored status as an observation of that binding, not a permanent assertion about the current work.

The gate requires the latest observation for every PR/test declaration in the current completed attempt, current semantic/execution bindings, all required coverage, and no unresolved failure. Observations older than ten minutes are stale for the gate. The worker refreshes due evidence approximately every five minutes, with a per-evidence database lease; crashed workers can be replaced after five minutes. Changed PR heads and reruns are checked again after job pagination. Network failures, 403/429, incomplete pages and unsupported sources never become passes. Soft artifacts do not provide coverage.

Shadow evaluation and its outbox event share the caller's transaction and an issue row lock with contract/review changes. Human decisions can be compared with the run's shadow evaluations without rewriting the original evidence. This version has no switch that enables automated acceptance. Disable the worker to return to manual-only observation; records are retained. Older application versions may reintroduce GitHub merge-to-Done behavior, so downgrading the application is not a safe way to disable verification. Keep upgraded lifecycle handlers when rolling back worker configuration.

Official API contracts: [commit–PR associations](https://docs.github.com/en/rest/commits/commits#list-pull-requests-associated-with-a-commit), [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs), [workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs), [GitHub App authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app).
