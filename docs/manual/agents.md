# Working with agents

## Connect an agent

1. A team Owner or workspace Admin opens the team's **Settings** → **Agents**. Workspace Admins can also find the team through **Settings** → **Administration** → **Agents**.
2. Choose an **Accountable owner** and only the scopes the agent needs, then click **Issue credential**. Use **Copy token** to put the one-time token in the client's private configuration or secret store. Don't paste it in issues, screenshots, logs, or source code. If it is lost or exposed, revoke it and issue a replacement.
3. Point the client at your instance's `/mcp` endpoint, or `/mcp/readonly` for read-only review. Follow [agent setup](../agent-setup.md) to configure and verify your client. `protocol_get_guide` is the starting point for the server's current agent rules.

## Follow a claim, run, and evidence

An agent looks up work and reads its contract with `work_get_context`. It uses `work_claim` to lease eligible committed work, then records phases with `run_report`. The claim token belongs to that execution and should not be shared. A reported completion normally moves work to **In Review**; it is not acceptance.

Attach evidence such as a pull request, test result, or screenshot to the work. On the issue, open **Work context** to see claims, runs and evidence; review the result against **Acceptance**. See the [API and MCP reference](../api.md#mcp) and [evidence verification](../evidence-verification.md) for technical details.

## Read evidence gap hints

When available, **Evidence gap hints** appears in **Work context** → **Evidence**. It points to acceptance criteria and suggests where the submitted evidence may be incomplete. Open the underlying evidence and verify the result yourself. A hint does not verify the evidence, approve the work, or change its state. Agents can also read hints with `work_coverage_hints`.

## Understand autonomy levels

Check the effective policy for your team or project before assuming that a person must make every decision:

| Level | What can happen under policy |
| --- | --- |
| **L0 Review everything** | The normal workflow keeps decisions with people. |
| **L1 Low-risk pass-through** | Qualifying bug and improvement proposals can be committed, and verification-only amendments can be accepted. |
| **L2 Green-light accept** | Eligible work in review can be accepted when evidence grades `CLEAR` outside shadow mode. |
| **L3 Hands-off** | Matching intake can be committed and sent to a trusted agent; delegation is explicit and bounded. |

Rules, role trust, and workspace locks still apply. Review automated decisions in [Needs you](needs-you-and-activity.md), and use the [autonomy policy reference](../autonomy-policy.md) for exact gates and exceptions.
