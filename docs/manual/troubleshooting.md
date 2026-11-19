# Troubleshooting

| What you see | What to check |
| --- | --- |
| Google sign-in is refused | Use the invited address. Ask an admin to check your invitation, approved domain, and account status. See [Permissions](../permissions.md). |
| An item is missing from Board or Backlog | Verify the team and project filters, clear restrictive filters, and search for the identifier. Uncommitted proposals are in **Candidates**, not on Board. |
| **Create issue** stays disabled | Fill **Title**, select the **Project** and **Location**, and check required fields. If the team has no project, use **Projects** or ask the team to create it. |
| A proposal won't commit | Check **Acceptance**, parent placement, required fields, and bug priority. If it is snoozed, choose **Wake now** before committing. |
| A move or bulk action succeeds only on some items | Read the result for each item. A live claim, conflict, or missing close data can leave it unchanged. Fix the underlying reason and retry only the remaining items. |
| **Needs you** and **Activity** don't show the same items | Needs you tracks decisions assigned to you; Activity tracks what happened, including things you only need to read. |
| Delivery has no samples or incomplete history | Check the window and project. Inspect the sample count and coverage; older missing data is unknown, not zero. |
| An agent cannot connect or act | Check the instance URL, `/mcp` versus `/mcp/readonly`, and the token scope, lifetime, and team. Follow [agent setup](../agent-setup.md#3-verify-the-connection). Never include the token in a support request. |
| Pull requests aren't appearing | Check the team's installation and repository mapping in **Settings** → **GitHub**. See [Connecting GitHub](../github-connection.md). |

If the problem persists, note the page, team, item identifier, steps to reproduce, expected and actual behavior, and the error text. Capture a screenshot if it helps, but remove credentials and private data. Use [Report bug](bugs-and-incidents.md#report-a-bug) for a product defect or the [operator runbook](../ops.md) for a service problem.
