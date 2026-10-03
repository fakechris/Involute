# External executor protocol (version 1)

Involute stores execution authority and delivery facts. The runtime holds its
own Git/deployment credentials and performs effects outside the server.
Executor receipts are authenticated statements by that runtime, not independent
verification and not human acceptance.

## Candidate authorization

A delivery unit can name `executorActorId` and `maxAttempts` (1–10). A person
approves that delegation together with the existing repository, paths, actions,
CI checks and deployment environments in Candidates. Omitting the executor
leaves external dispatch disabled. Agent mentions do not grant delegation.
Creating an approved implementation creates its durable queued dispatch and an
`executor.dispatched` outbox event in the same transaction. The root work ID is
the delegation origin; the runtime cannot add another delegate or increase its
attempt budget without another candidate change.

Agents can discover identities through `work_catalog(kind: "actors")`; people
choose an agent in the delivery policy editor. Work ownership remains human.
Only the approved executor may claim the implementation.

## Runtime sequence

1. Read `work_executor_context(id)` and the approved delivery context. Unsupported
   protocol versions must fail closed. Use the implementation UUID for writes.
2. `work_claim`, then `run_report(running)`. Keep the returned claim token in a
   private execution file, never in a command line, report, log or repository.
3. `work_executor_update(operation: "ack")` with `details.runId`, `claimToken`,
   `expectedRevision` and `generation` binds the dispatch to that execution.
4. Perform implementation and tests. Renew the work lease before it expires and
   send a `checkpoint` with a durable, secret-free recovery summary. Refresh the
   dispatch after writes; revision conflicts require a new read, not blind retry.
5. Before merge/deploy, send `prepare_effect` with `effect` containing `key`,
   `action`, `environment` (deploy only), `commitSha`, and the actual changed
   `paths`. Repository scope comes from the approved work. A merge SHA must match
   the run's PR head. A deployment SHA is the release version and may differ from
   the PR head.
6. After all asynchronous preparation, call `start_effect(effectId)` immediately
   before invoking the external operation. It rechecks the grant, execution,
   credential, stop state and environment. A started effect is never replayable.
   A lost response or crash leaves its outcome unknown; reconcile the external
   system instead of issuing another effect with a new key.
7. Observe the external result and submit `receipt`, with `idempotencyKey` and,
   for a deployment, the exact `effectId`. The version 1 receipt contains:

   ```json
   {
     "version": 1,
     "repository": "owner/repository",
     "commitSha": "<40-character PR head SHA bound to the run>",
     "pullRequestNumber": 123,
     "environment": "staging",
     "deployedSha": "<40-character observed deployed SHA>",
     "health": "pass",
     "behavior": "unknown",
     "evidenceUrls": ["https://example.org/durable-observation"],
     "observedAt": "2026-10-03T01:00:00.000Z"
   }
   ```

   Without deployment, use null environment/deployedSha. Health and behavior are
   `pass`, `fail` or `unknown`. The server binds repository, PR and head SHA to the
   run; it shows a mismatch against the referenced release intent. It does not
   rewrite either value to make them agree. A receipt does not verify itself.
8. Attach durable evidence, report the run completed, and move the root delivery
   package to Review with `work_update` once all units have delivered. People see
   the package's execution and deployment receipts on its work page and accept
   or return the package there. CI verification stays separately visible.

Return revokes the old runs and requeues the original approved executor with the
human feedback, within `maxAttempts`. Exhaustion is visible as `EXHAUSTED`; a new
budget is a candidate change. A stopped/expired execution with no started effect
can use `recover` after its old claim expires. Its old run is revoked. An unknown
external effect blocks automatic recovery.

## Stop and failure semantics

People can select **Stop executor** on the work page. A request is not an
acknowledgement. The runtime stops its process and reports `stop_ack` using the
bound execution token. Expired leases appear as `UNKNOWN`. If an external effect
already started, even a runtime stop acknowledgement retains an unknown external
outcome. Involute cannot undo an operation already accepted by another system.

The authorization check and an external provider's operation are not one database
transaction. Revocation prevents subsequent authorization and the reference
runtime observes stop/revocation while running; it cannot promise cancellation of
an irreversible operation already underway.

## Reference CLI effect adapter

`involute executor-effect` operates a local recipe installed by the runtime
operator. It verifies a clean Git checkout, repository identity and actual changed
paths, then authorizes immediately before spawning the command without a shell.
The CLI polls for stop/revocation, terminates its child process group, and records a
private durable journal. Child output is not printed. Exit zero is only command
completion: the agent still observes health/version and submits its receipt.

```sh
involute executor-effect --work <implementation-uuid> \
  --execution-file /private/runtime/execution.json \
  --recipe /private/runtime/staging-recipe.json \
  --sha <full-sha> --key deploy-attempt-1 \
  --journal /private/runtime/journals/deploy-attempt-1.json
```

The execution file has `work_id`, `run_id`, `claim_token` and mode 0600. Configure
CLI authentication in its private configuration. A recipe has `version: 1`,
`repository`, absolute `cwd`, pinned `baseSha`, `action`, optional `environment`,
absolute `command`, and `args`; at least one argument must contain `{sha}`. The
operator must map each recipe to the stated environment and restrict the runtime's
credentials accordingly. Recipes and credentials must not be writable by untrusted
workload code. This adapter is not an OS sandbox and cannot constrain arbitrary
programs that possess deployment credentials outside it.

Outbox delivery can wake an external runtime; polling the context recovers missed
notifications. No hosted runtime or automatic third-party credential provisioning
is implied. Production GitHub CI proofs additionally require the separately
configured evidence verifier.
