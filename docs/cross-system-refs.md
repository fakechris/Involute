# Cross-system references (INV-1434, decision INV-1433)

Three systems hold one person's working memory, each for one kind of thing:

| System | Holds | Not |
|---|---|---|
| **Involute** | Requirements, decisions, research conclusions, review declines (INV-1432) | Raw outside material |
| **OVP** | Outside information turned into usable knowledge: sources, reader packs, gated claims | Our own conclusions |
| **planofplan** | Process evidence: agent sessions, messages, commit attribution | Decisions |

A conclusion about an outside project lives in an Involute research item, with the report attached (§11.4) and references to the OVP source it rests on and the session that produced it.

## Reference format

| Prefix | Form | Example |
|---|---|---|
| `ovp:` | `ovp:source/<sha256>` · `ovp:claim/<claim_key>` · `ovp:pack/<reader dir>` | `ovp:source/ddd5d59fd01d1589…` |
| `inv:` | `inv:INV-<n>`, optionally `#RUN-<n>` or `#comment-<uuid>` | `inv:INV-1289` |
| `pop:` | `pop:<provider>:<session_id>#<message_id>@<source_revision>` — planofplan's `SourceRef` | `pop:claude:agent-ad51950ed6c1e202d` |

The message and revision parts of `pop:` are optional; with a revision the reference pins content, without one it points at whatever the session holds now. An OVP sha256 may be shortened to 8+ hex characters when it is unambiguous in prose; tools write the full value.

## Who resolves what

| Prefix | MCP | Tool |
|---|---|---|
| `ovp:source/…`, `ovp:pack/…` | OVP (local) | `find` / `ovp_read_note` |
| `ovp:claim/…` | OVP (local) | `claim` |
| `inv:…` | Involute (remote) | `work_get_context` |
| `pop:…` | planofplan (local) | `read_session`, then `read_message` with the full `SourceRef` (see below) |

### Resolving `pop:`

A `pop:` reference is not a complete `SourceRef`: `read_message` needs all six fields (`provider`, `session_id`, `message_id`, `source_seq`, `source_revision`, `parser_version`) and rejects a mismatch as `STALE_SOURCE`. So:

1. `read_session(session_id)` (or `message_search` scoped to the session) and find the message by `message_id`; take its current `source_ref`.
2. If the reference carries `@<revision>` and it differs from the current `source_revision`, report **changed since cited** — do not present the new text as what was cited.
3. `read_message(source_ref)` for the full text. A session-only reference stops at step 1.

## Rules — no circular calls

1. **Servers never call each other.** A system stores another system's references as text and may render them as links; it never fetches them. (Involute is remote and cannot reach the local OVP or planofplan anyway.)
2. **Each system resolves only its own prefix.**
3. **Only clients resolve** — an agent, or `recall` (INV-1429). `recall` expands **one hop**: references found in results are resolved, references inside those are not. No MCP tool calls `recall`.
4. A reference that does not resolve is reported as unresolved, never silently dropped.

## Writing references

- **Research items:** the description (or a comment, once committed) cites the `ovp:source/…` the conclusion rests on, when OVP has ingested it, and the `pop:…` session that produced it. The report is attached, not left only in a local directory.
- **Run receipts:** `evidence` items may use these prefixes as `ref` with `kind: "url"` until a dedicated kind exists.
- References stay text for now. Whether they become structured fields is decided after the `recall` two-week experiment.
