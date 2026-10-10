# Postmortem (事故复盘, INV-1126)

Every incident (Type: Incident, AGENTS.md §14) ends with what it taught turned
into work. A SEV1 or SEV2 incident also ends with a written postmortem,
attached to the incident as a private file (INV-1003) — not committed to git.

## The template: six sections

1. **摘要** — two or three sentences: what happened, who was affected, how it
   recovered.
2. **影响** — scope (people, features, data), duration, SLA breach. The draft
   fills in the declaration time and the impact timestamps (impact started /
   detected / mitigated / resolved, INV-1125) when they are recorded, and
   quotes the impact statement from the declaration.
3. **时间线（自动，取标星条目）** — the timeline entries someone starred as key
   events (INV-1116), oldest first, with time and actor. Star entries on the
   issue page's timeline or with `work_timeline(action: "star")`, then
   regenerate the draft.
4. **促成因素** — several contributing factors (technical, process,
   communication, monitoring). Do not chase a single root cause; state facts,
   not blame.
5. **教训** — what went well, what to improve, where we were lucky.
6. **Follow-ups** — the items DERIVED_FROM the incident, with their state.

## Drafting it

Agents call `work_timeline` with `action: "postmortem_draft"` and `work_id`.
It writes nothing and returns `markdown` (the six sections, prefilled, with
TODO markers), `filename` (`postmortem-<identifier>.md`), the timestamps, the
starred-entry count and the follow-ups. Complete the TODOs, then attach it:
`work_attach_file(work_id, filename, mime_type: "text/markdown", content)`.
People write it from this template and attach it from the incident's Files.

## Closing rule

An incident moves to Done only when:

- something is DERIVED_FROM it (its follow-ups), or its description says
  "无可执行点" / "no actionable points"; and
- for SEV1 / SEV2, at least one file is attached to it (the postmortem).

The rule is about the work, not who closes it: the issue page, the board,
review acceptance (`workReview`) and creating an item straight into Done all
refuse with the reason in `message`. The check lives in
`packages/server/src/incident-closure.ts` (`assertIncidentMayClose`) on top of
the shared `missingCloseRequirements` in `packages/server/src/work-closure.ts`.

When every follow-up of an open incident is committed, its declarer and its
Incident Lead get one `incident.closable` notification (and outbox event).
`/hygiene` lists incidents in Review or Done that lack follow-ups, and SEV1/SEV2
ones that lack a postmortem.
