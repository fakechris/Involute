# Settings, teams, and integrations

## Find the right settings

- For personal details or display settings, open **Settings** → **Profile** or **Preferences**.
- For a team's roster, expand the team in the sidebar and open **Members**. Team Owners and workspace Admins can manage team membership. Use that team's **Settings** for its visibility, workflow states, bug triage, or agent credentials.
- Workspace Admins use **Settings** → **Administration** for workspace-level **Members**, **Teams**, **Agents**, **Security**, **Autonomy**, **Fields**, **Service actors**, **Labels**, and **Server features**. The workspace **Agents** tab links to each team's settings; credentials are created at team level. The separate **Agents** directory is for agent activity and details.

Workspace roles and team roles are separate. If a control isn't visible, verify both your role and the active team. See [Permissions](../permissions.md) before granting access or changing visibility.

## Connect GitHub

1. Open **Settings** → **GitHub**. A workspace Admin uses **Create GitHub App** once for the deployment, when there isn't already an app.
2. A team Owner or Admin uses **Install on GitHub** for the desired team and grants access to the repositories the team tracks. **Use a token instead** is the alternative for a read-only credential.
3. In the GitHub settings, check the connection's repositories and sync status. Confirm a repository is associated with the right team's project so referenced branches and pull requests can appear on the work.

See [Connecting GitHub](../github-connection.md) for prerequisites, repository routing, and recovery from a disconnected integration. Server deployment, backup, and recovery are in the [operator runbook](../ops.md).
