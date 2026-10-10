# Severity (SEV1–SEV3)

Severity says **how bad the effect is**. Priority says **what goes first** and,
for a bug, sets the SLA (Urgent 24h, High 48h, otherwise 7 days). They are two
fields on purpose (INV-1115): an agent can report the impact it sees, and a
person still decides the order. Changing severity never moves an SLA.

| Level | Name | Use it when |
|---|---|---|
| `SEV1` | Critical | Service down, data lost or corrupted, a security exposure, or a core flow unusable for everyone — and no workaround. |
| `SEV2` | Major | A core flow broken or badly degraded for many people, or a workaround that is painful; data at risk but not yet lost. |
| `SEV3` | Minor | Limited impact: a few people, a non-core flow, or a workaround that is easy. |

Rules of thumb:

- **Unsure between two levels? Pick the higher one.** It can be lowered later;
  every change is audited with the old value.
- **A SEV3 incident is essentially a bug.** File it as a Bug with a severity
  rather than declaring an incident.
- Severity is required on incidents (Type: Incident, INV-1123): declaring one
  without it is refused.
- Severity is optional on bugs and on any other work. Leave it empty
  ("not judged") when nobody has looked at the impact yet.

Where it lives:

- Web: the issue page and drawer (Structure → Severity), the Report bug
  dialog, the board card (a SEV badge), and `/bugs` (Open by severity).
- GraphQL: `Issue.severity`, `issueUpdate` / `bugReport` / `workPropose`
  inputs, `bugSummary.bySeverity`.
- MCP: `severity` on `work_propose`, `work_file_bug` and `work_update`
  (`null` clears it).
- IQL: `severity:sev1`, `severity:sev1,sev2`, `severity:none`.
