# Field definitions: work-item fields as configuration (design, INV-1500)

Status: **stages 1–2 implemented** — model, validator, GraphQL / MCP read and
write, the GIN index, audit snapshots and the issue page Fields section
(INV-1503); Settings → Administration → Fields and Team settings → Fields,
governance limits, the 90-day cleanup prompt, key rename and FieldValueIndex
with its background backfill / cleanup (INV-1504). IQL, board grouping,
autonomy conditions, dialogs and import: INV-1505. Today every work-item field is a Prisma
column; adding one means a migration, GraphQL and MCP changes, the parity and
human-surface guards, a web form and a release. This page designs the layer
that makes a new field a piece of configuration instead, while keeping every
field the server reasons about as a column. Research: INV-1499 (attachment).
Decision: INV-1501.

## 1. What we are choosing between

| | Jira | Linear | Plane | Involute (this design) |
|---|---|---|---|---|
| Fields | arbitrary, global by default, scoped by contexts and screens | none; label groups, templates + Asks fields, curated properties | properties defined per project / workspace, exposed per work item type | definitions scoped to workspace / team / project, exposed per Kind × Type |
| Where it hurts | thousands of fields, slow create / edit / search, 2026 cap of 700 per field configuration | severity, deal stage, contract value have nowhere to go; agents cannot read anything typed | values do not survive a cross-project copy | — |
| What we keep | contexts and limits (governance) | the fixed system fields and the Type label group | the type-scoped model and typed values | all three |

The deciding constraint is ours alone: **agents judge work by fields** (the
autonomy policy conditions, SLA, locks). Labels have no type, so a labels-only
answer is not enough; an arbitrary-field answer repeats Jira. Plane's shape
fits what we already have — Kind (PROJECT / MILESTONE / EPIC / ISSUE /
DECISION) and Type (Bug / Feature / Improvement / Research / Incident).

## 2. System fields stay columns

A column stays a column when the server has logic on it. This is the retention
list and the reason for each; nothing here moves to `attributes`.

| Column | Why it stays a column |
|---|---|
| `title`, `description`, `identifier`, `kind`, `commitmentStatus`, `stateId`, `revision`, `teamId`, `parentId`, `assigneeId` | identity, placement, the four state machines, CAS |
| `priority` | bug SLA budget, zero-bug commit rule, autonomy L1 condition |
| `severity` | SEV1 / SEV2 locks on Done, incident metrics |
| `reproducibility` | intermittent bugs never auto-accept (INV-1122) |
| `foundInSha` | deploy-range bug reports (INV-1121) |
| `outcome`, `scope`, `constraints`, `acceptance`, `verification` | the delivery contract: frozen per run, amended through proposals, required to commit |
| `repository`, `alias`, `webOrigins`, `autoAcceptBugs` | GitHub routing, reference aliases, extension routing, the legacy acceptance switch |
| `resolution`, `reopenCount`, `supersededById` | close semantics, reopen metrics, supersession (INV-1498) |
| `impactStartedAt`, `detectedAt`, `mitigatedAt`, `resolvedAt` | incident MTTR / MTTM, ordering rules, Review gate |
| `source`, `snoozedUntil`, `capture` | provenance, candidate snooze, bug capture context (already JSON, bug-only) |
| `projectId`, `cycleId`, `deliveryRootId`, `deliveryUnitKey`, `deliveryGrantRevision`, `stateSourcePrId`, `lastAppliedEventTime` | legacy project / cycle, delivery packages, webhook provenance |

Rule for the future: a field becomes a column only when a server rule depends
on it; a field a team wants to record, filter and show is a definition.

## 3. The model

```
FieldDefinition
  id            uuid
  scope         WORKSPACE | TEAM | PROJECT
  scopeId       text                      -- workspace id / Team.id / PROJECT Issue.id
  key           text                      -- snake_case, unique within the scope chain seen by an item
  label         text
  description   text?
  type          TEXT | NUMBER | BOOLEAN | DATE | ENUM | MULTI_ENUM | WORK_REF | USER_REF | URL
  options       jsonb?                    -- [{ value, label, archived? }] for ENUM / MULTI_ENUM
  appliesTo     jsonb                     -- { kinds: WorkKind[], types: TypeLabel[] | 'any' }
  required      boolean                   -- on items the definition applies to
  defaultValue  jsonb?
  searchable    boolean                   -- indexed in FieldValueIndex (see §6)
  active        boolean                   -- deactivated, never deleted; values stay
  version, reason, createdById, createdAt -- versioned like WorkflowPolicy

Issue.attributes  jsonb  default '{}'     -- { [key]: value }, only keys with an applicable active definition

FieldValueIndex                            -- rows only for searchable definitions
  issueId, key, textValue?, numberValue?, dateValue?, refId?
  btree (key, textValue), (key, numberValue), (key, dateValue), (key, refId), (issueId)
```

Value shapes: TEXT string ≤ 2 000 chars; NUMBER finite double; BOOLEAN;
DATE ISO date-time string; ENUM one option value; MULTI_ENUM up to 50 option
values; WORK_REF a work UUID (identifier accepted on write, stored as UUID);
USER_REF a user UUID; URL http(s) ≤ 2 000 chars. Resolution of the definitions
an item sees: project → team → workspace, nearest scope wins on a key clash.

## 4. Validation, everywhere writes happen

One validator, `validateAttributes(definitions, item, attributes)`, called from
every write path. It returns the normalised object or a refusal naming the key
and the rule.

| Write path | Where the validator runs |
|---|---|
| GraphQL `issueCreate(input.attributes)` | `createIssue` before insert |
| GraphQL `issueUpdate(input.attributes)` | `updateIssue` inside the row transaction; partial update merges with stored values, `null` clears a key |
| GraphQL `bugReport(input.attributes)` | `reportBug` before create; required fields for Type Bug appear in the dialog |
| GraphQL `workPropose(input.attributes)` | `proposeWork` before insert (candidates may leave required fields empty; commit refuses until filled, like acceptance) |
| GraphQL `workCommit(input.attributes)` | `commitWork`: fills and re-validates required fields |
| MCP `work_propose(attributes)` | same `proposeWork` |
| MCP `work_update(attributes)` | same `updateIssue`; agents may write attributes on committed work (they are not contract fields) |
| MCP `work_file_bug(attributes)` | same `proposeWork` bug path |
| Import pipelines (Redmine, Linear) | `importAttributes` maps source custom fields onto definitions by key, unknown keys to a `imported_extra` TEXT definition created once per import |

Rules the validator enforces: unknown key refused; wrong type refused; option
not in the definition refused; `required` enforced on committed items of a
matching Kind × Type (candidates get a warning, commit refuses); WORK_REF must
be readable by the writer and on the same team; USER_REF must be an active
member of the team; size limits above. Every change writes the before / after
`attributes` into the WorkAudit snapshot (bounded by the size limits).

## 5. Reading

- GraphQL `Issue.attributes: Json!` and `Issue.fieldDefinitions: [FieldDefinition!]!` (the applicable, active definitions, so a client can render without a second query).
- MCP `work_get_context` returns `attributes` and `field_definitions` in the bundle; `work_catalog(kind: 'fields', team_id)` lists a team's definitions for proposal time.
- Parity: `attributes` is a JSON object on both surfaces; the parity test treats `attributes` as the one shared JSON-typed field (an explicit `FIELD_TYPE_EXCEPTIONS` entry is not needed because both sides are `object` / `Json`).

## 6. Performance: two tiers, one default

1. **Default tier — JSONB + GIN.** `Issue.attributes` carries a
   `GIN (attributes jsonb_path_ops)` index. Every field gets equality and
   containment (`attributes @> '{"severity_band":"high"}'`, multi-enum
   `@> '{"tags":["a"]}'`) without per-field DDL. Covers IQL `=`, `in`, `has`
   and the filter part of board grouping. GIN does not help ranges, sorting or
   aggregation.
2. **Extension tier — FieldValueIndex.** With `searchable: true` the write
   transaction also upserts the typed row; btree indexes give ranges, date
   windows, sort and group-by counts, and reverse lookup by reference. Flipping
   `searchable` (or retiring / reactivating a searchable field) sets
   `FieldDefinition.indexJob` to BACKFILL or CLEANUP; a server timer
   (`runFieldIndexJobs`, every 30 s) walks the scope's items that hold the key
   in id order, 200 at a time, and the settings page shows the progress. An
   item governed by a nearer definition of the same key is left to it. No
   runtime `CREATE INDEX`.

IQL compilation of `attr.<key> <op> <value>`: indexed → join
FieldValueIndex; else `=` / `in` → JSONB containment via GIN; else a range or
sort on a non-indexed field is **refused** with "mark the field searchable",
never a silent sequential scan. Board grouping and autonomy conditions accept
searchable fields only.

Scale: the production work graph is thousands of items; a sequential scan is
milliseconds. Jira's pain starts at 10⁵–10⁶ issues × thousands of global
fields. The governance caps below keep our multiplier in two digits. What the
two tiers avoid is the one thing that does not scale: a column or an index per
field.

Extensibility: a new **field** is configuration (no release); a new field
**type** is code (validator, index column mapping, web control) and a release,
expected to be rare.

## 7. Governance (Jira's lessons as rules)

- Scope is never workspace by default; the create form starts at team.
- Limits per scope: 30 active definitions; 50 options per enum; raising a limit is a decision, not a setting.
- `searchable` is off by default; the settings page shows how many items carry a value before offering it.
- Deactivation keeps values and audit; reactivation restores them; delete does not exist.
- Settings → Administration → Fields (Admin) and Team settings → Fields (Owner) list definitions with item counts; a "defined, never used in 90 days" view is the cleanup prompt.
- A key may be renamed only with a reason; the old key keeps reading for one release (alias in the definition).

## 8. Where people and agents meet it

- Issue page: a Fields section under the system properties, rendered from the applicable definitions; required ones marked; USER_REF and WORK_REF render as people and references.
- Report bug / propose / commit dialogs: the required fields for the chosen Kind × Type.
- Board: group by any searchable ENUM / BOOLEAN / USER_REF field; filter by any field (IQL `attr.<key>`).
- Autonomy policy: `CONDITION_FIELDS` gains `attr.<key>` for searchable fields, so an L1 intake rule can say "commit when attr.risk = low".
- MCP tool descriptions list the team's required fields at proposal time, so agents stop guessing.

## 9. Not in scope

- Formula fields, field-level permissions, cross-team copying of definitions.
- Moving any system field in §2 to a definition.
- Runtime DDL of any kind.

## 10. Implementation split (candidates after the decision)

1. Model + validator + GraphQL / MCP read and write (`attributes`, `fieldDefinitions`, `work_catalog(fields)`), JSONB GIN index, WorkAudit snapshot; no UI beyond the issue page Fields section.
2. Settings pages (Administration → Fields, Team settings → Fields), governance limits, cleanup view, FieldValueIndex with backfill job.
3. IQL `attr.<key>`, board grouping, autonomy `attr.<key>` conditions, required fields in Report bug / propose / commit dialogs, import mapping.
