---
name: attach-evidence
description: Use when attaching a durable PR, test, or artifact URL to an Involute run. Also moves work toward In Review.
---

# Attach evidence

Tool: `evidence` with `action: 'attach'` (default; the old name `evidence_attach` still works for one version, INV-1046)

## When

You have a durable pointer (PR URL, CI run, artifact path) proving the run.

## How

- Require `work_id`, `run_id`, `kind`, `url`, short `summary`.
- Prefer https PR/commit URLs; `file://` only for box-local receipts the operator can open.
- Never attach tokens, `.env`, or secret-bearing paths.

## Rules

- Evidence is not a substitute for `run_report` completed.
- Do not invent citations or fake URLs.

## Attaching private files (`work_attach_file` / `involute work attach-file`, INV-1003 / INV-1273)

When attaching a research report, incident postmortem, diagnostic Markdown, log, or screenshot to a work item (`work_attach_file`, then optionally citing its returned `/uploads/...` URL in `evidence(action: 'attach', kind: 'artifact')`):

1. **Local file already on disk? Upload directly via CLI (fastest, zero LLM tokens, no truncation):**
   ```bash
   involute work attach-file <INV-xxx> /path/to/report.md [--mode overwrite|append|delete] [--filename report.md]
   ```
   Never run `base64 -i <file>` + `cat` to paste large Base64 blobs into an MCP tool call — single-line `base64` output is truncated by shell tool output limits (~3.7 KB) and wastes thousands of output tokens.
2. **Passing text/Markdown through MCP `work_attach_file`? Pass plain UTF-8 (`encoding: 'utf-8'`):**
   ```json
   {
     "work_id": "INV-123",
     "filename": "report.md",
     "encoding": "utf-8",
     "content": "# Report\n\nPlain UTF-8 markdown..."
   }
   ```
   `mime_type` is auto-inferred from `filename` when omitted, and `encoding` auto-detects plain UTF-8 vs Base64 for `.md`/`.txt`/`.log`/`.json`.
3. **Fixing a truncated upload or uploading in chunks (`mode`):**
   - `mode: 'overwrite'` replaces the existing attachment on `work_id` with the same `filename` (or `attachment_id`) in-place, keeping its ID and URL.
   - `mode: 'append'` appends `content` to the existing attachment with the same `filename` (or creates it if it does not exist yet) — never split one logical report into `part1-of-5`..`part5-of-5` files.
   - `mode: 'delete'` removes a mistaken or truncated attachment by `attachment_id` or `filename`.

## Execution ownership (INV-943)

`work_claim` returns a secret `claim_token` and an `executionId`. Keep the token in this execution’s secret state; never put it in a comment, receipt, log or Git. Pass `claim_token` when renewing the lease, reporting a run, attaching evidence, releasing your claim (`work_claim_release`, with a reason), or retracting your own pre-acceptance evidence (`evidence_retract`, with a reason). Sharing an actor identity does not share execution authority. After lease expiry, acquire a new claim and use its new token; old runs cannot resume. A lost token cannot be recovered from context: wait for expiry or ask a person to release the claim in the UI. Completed runs retain their token binding for attaching evidence after completion.
