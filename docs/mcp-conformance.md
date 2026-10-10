# Client protocol diagnostics

`protocol_get_guide` retains its guide text and adds a `protocol` object (schema
version 1). The Involute work protocol version is independent of the MCP transport
version. Clients must treat missing or unknown versions as unknown compatibility,
not success. Reconnect and discover `tools/list` after updating the server.

Pass `project_id` (PROJECT UUID or identifier) and/or `repository` to resolve a
canonical project binding using the same resolver as search and ready work. A
missing root, conflicting repository, or inaccessible project must not be guessed.
The response includes the root, repository, alias, supported capabilities and
credential scopes; no tokens. Availability remains subject to work-specific access
checks, active claims and current revisions.

After configuring `server-url` and `token` in the private CLI configuration, run:

```sh
involute doctor --project INV-79 --repository fakechris/Involute --json
```

The report contains `schemaVersion`, `checks[{id,status,code,remediation}]` and
`exitCode`: 0 means every diagnostic passed, 2 means a configuration, authentication
or compatibility issue (including unknown checks), 3 means service connectivity or
availability failed. Doctor is read-only, does not retry mutations, and preserves
an explicitly configured `/mcp/readonly` endpoint. A passing diagnosis is not an
execution authorization. Query `work_catalog(kind: capabilities)` for action scope.
Direct Tailscale/loopback access can intentionally differ from the public
`APP_ORIGIN`; doctor reports that difference instead of silently trusting it.

Local release builders must pass `--build-arg INVOLUTE_BUILD_SHA=<full source SHA>`
to `docker build`; the Docker publish workflow passes the commit SHA. The protocol
reports a null build SHA when it is unknown. The web image reports the same SHA in
`<meta name="involute-version">` (`dev` when unknown, INV-1146).

## State and revision compatibility

`work_commit.state_id` accepts a workflow state **UUID**, not `READY` or
`UNSTARTED`. Obtain IDs through `work_catalog(kind: states)`. `work_update.state`
and `work_propose.initial_state` retain their documented enum semantics. Candidate
approval and final acceptance remain human actions (existing Bug and Research
exceptions are unchanged).

MCP revision conflicts include `error.data.code = REVISION_CONFLICT` and the
readable work's `currentRevision`. This is a refresh hint, not a compare-and-swap
authorization: read the changed context and reconcile before submitting a new
update. Never automatically overwrite with a freshly fetched revision.

## Evidence boundary

Server tests and browser tests verify the shared fixture and permission contract.
They do not establish that two independent clients passed. Native client acceptance
requires separate named client/version receipts against one isolated server,
including search pagination, propose/human commit, claim/run/evidence, human review,
and A disconnect/expiry/B takeover/old A refusal. Never use production work as a
synthetic fixture, or two invocations of the same SDK as two clients.
