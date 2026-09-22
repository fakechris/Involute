# Optional semantic advice module

The server package exports `@turnkeyai/involute-server/semantic-advice`. This is the
provider/experiment foundation for optional suggestions. It does not register a
GraphQL/MCP mutation, change issue state, or enable suggestions in the web UI.
Scenario consumers are separate work. The module is disabled by default.

## Server-side use

Apply database migrations before using `createPrismaAdviceJournal`. Construct one
module per worker. Keep it outside database transactions and authorization/claim
critical paths. `isCurrent` must re-read the caller's permission and the current
work revision, contract digest and authorized projection. Never implement it as a
constant `true` in a live integration.

```ts
import {
  createSemanticAdvice, createPrismaAdviceJournal, createJevProvider,
} from '@turnkeyai/involute-server/semantic-advice';

const advice = createSemanticAdvice({
  journal: createPrismaAdviceJournal(prisma),
  providers: [createJevProvider({ apiKey: () => process.env.TYPESAFE_API_KEY })],
  config: process.env.SEMANTIC_ADVICE_CONFIG, // absent/invalid => disabled
  isCurrent: async binding => checkCurrentReadScopeAndContract(binding),
});
```

The surrounding application implements `checkCurrentReadScopeAndContract` using
its authenticated principal; client-supplied hashes are not authorization.
`evaluate` takes authorized text/structured state, bounded checks, a validated
existing-behavior `baseline`, and these bindings: `teamId`, `repository`, `scenario`,
`workId`, `actorId`, `revision`, `contractDigest`, `authorizationDigest`.

Checks use provider-neutral `selection` (named options), `likelihood` (condition),
and `rating` (ordered descriptive levels). Include an explicit no-match option in
selections when appropriate. Provider judgments carry `value: null` for abstention.
Uncertainty is optional and carries provider-specific semantics; a missing value
is not zero, and a concentrated distribution does not prove correctness.

Example configuration (pass as JSON, or as an object to `configure`):

```json
{
  "enabled": true,
  "policies": [{
    "teamId": "your-team-id",
    "repository": "owner/repository",
    "scenario": "triage",
    "mode": "shadow",
    "experimentId": "triage-pilot",
    "assignmentVersion": "1",
    "assignmentUnit": "work",
    "salt": "fixed-trial-salt",
    "treatmentBps": 5000,
    "provider": "jev",
    "model": "jev-1.13.0",
    "questionVersion": "triage-1",
    "calibrationVersion": "unvalidated-1",
    "policyVersion": "1"
  }]
}
```

This is an opt-in example, not the default. No environment configuration is read
implicitly by module imports. The host supplies/reloads configuration and calls
`configure`; editing an environment variable alone does not reload a running worker.
A distributed host must deliver configuration changes to every worker.

| Mode | Provider work | Visible result |
| --- | --- | --- |
| `off` | None | Existing baseline |
| `shadow` | Evaluate authorized sample | Existing baseline, never treatment exposure |
| `ab` | Treatment only | Persisted control/treatment assignment |
| `enabled` | Evaluate every eligible request | Advice, or baseline on failure |

Global `enabled: false` wins over policies. Each policy selects an exact
team/repository/scenario. `configure` aborts in-flight evaluations, increments a
local epoch, clears caches and invalidates outstanding exposure handles. Even a
provider ignoring cancellation cannot publish its late result. A stale result
has `visible: null`; the caller must discard the payload and refresh authoritative
context. For timeout/unavailability the baseline remains visible only after an
independent current-authority check. Do not persist
or display any response with status `stale` as a current suggestion.

## Experiment identity and records

A/B assignment uses SHA-256 and a fixed salt over experiment/assignment version,
team, repository, scenario and the selected work/actor/team unit. Work revision and
configuration epoch do not change assignment. Assignment is durable and sticky:
changing allocation does not move existing units; to rerandomize, use a new
`assignmentVersion`. Changing unit/salt with the same identity fails closed.
Shadow and enabled assignments are separate from randomized A/B assignments.

`SemanticAdviceRecord` stores immutable first-writer-wins definitions, assignments,
execution observations, resolutions, invalidations and interactions. Observations keep the input digest and bindings,
baseline and evaluated judgments, actual/requested model, policy versions, usage,
cache status, elapsed time and fallback reason. They do not store input state,
credentials, error bodies, or generated rationales. This table is not trusted
EvidenceVerification and does not participate in acceptance gates. Provider output
is normalized with an explicit field allowlist before caching or persistence.
Execution observations describe the model attempt. Join the corresponding
`resolution:<observationId>` and honor any `invalidation:<observationId>` before
interpreting the proposed return disposition; a missing resolution is unknown.
Resolutions are provisional, since journal failures may prevent recording a later
invalidation. They never establish actual visibility. Only an explicit exposure
event means the application reported displaying a result.

A successful evaluation is not an exposure. After actually displaying a result,
call `recordInteraction(observationId, actorId, 'exposure')`. Explicit feedback is
`recordInteraction(observationId, actorId, 'feedback', 'accepted'|'corrected'|'rejected')`.
The authenticated actor must match the request; feedback requires prior exposure.
First exposure/feedback is deduped per assignment, full configuration and actor,
including across processes. Repeated feedback does not overwrite the original.
Shadow, stale, evicted, or pre-restart handles cannot record exposure; refresh the
advice before display. Observation handles are bounded per worker.

Authorized fallback results also accept exposure: the event retains the assigned
arm and records `visibleProvider: baseline` with its failure reason. Failures stay
in the assigned arm. Analyze intent-to-treat separately from actual
provider execution, and keep shadow comparisons separate from user-facing A/B.
Changing model/questions/calibration changes the configuration digest and records;
never transfer a confidence threshold across providers without evaluation.

## Limits and provider replacement

Default limits: 1500ms provider-path deadline, 4 concurrent provider requests, 64KB input, 32 checks,
100 selection candidates, 60 remote attempts/minute, 200 cache entries and 30s TTL.
They can be set under `limits` using the names in `AdviceConfig`. Limits and caches
are per module/worker, not a distributed billing cap. Retries are deliberately not
performed. Recovery journal writes and freshness checks each have a separate bounded
deadline, so total response time can exceed the provider-path deadline. Requests
that ignore cancellation retain their concurrency slot until they settle.
A host adding retries must account for the same deadline and budget.
Caches include authorized input and complete configuration; authorization is checked
again even on cache hits.

The Jev adapter uses a fixed HTTPS endpoint, forbids redirects, requires a pinned
`jev-X.Y.Z` model, bounds response bytes and validates returned candidates,
probabilities, score bounds, token usage and model identity. Keys remain server-side.
Register another `AdviceProvider` to replace it; expose supported judgment kinds,
normalize response shape, and retain uncertainty semantics. Contract tests include
an alternative response layout without probabilities. They do not prove a second
live provider or real Chinese judgment accuracy.

## Validation

Run in an isolated database ending in `_test`:

```sh
pnpm --filter @turnkeyai/involute-server test --run src/semantic-advice.test.ts src/semantic-advice-provider.test.ts
pnpm --filter @turnkeyai/involute-server typecheck
```

Set `DATABASE_URL` and `TEST_DATABASE_URL` to that same isolated database. Deterministic
fixtures validate interface and failure behavior; actual provider latency, cost,
Chinese quality and user-facing experiments require separate live evidence.
