# Views and search

## Board and Backlog

Use **Board** to see committed work by status and move a card to another column. Use the team or project scope and filters to narrow what is shown. Press `F` on Board to show or hide its filter bar, or `/` to focus the search field there. `Shift+F` clears all Board filters. A live claim or a required close reason may prevent or interrupt a move; read the result before assuming the state changed.

Use **Backlog** for a table of committed work. Filter or sort the rows before reviewing them; click the issue title to open it. To act on multiple rows, use their selection checkboxes, choose **Move to…**, and click **Apply to selected**. See [closing superseded work](review.md#close-work-that-has-a-replacement) for a concrete example.

## Search and IQL

On **Search**, enter words and click **Search**. Every word must match somewhere in the work's title, description, contract, or comments. Use the project, kind, state, and label filters or add terms in **IQL filter** and press `Enter`. IQL only refines a keyword search on this page. If you submit IQL without words, an inline hint asks you to add a keyword or links to **Backlog** with those filters to browse committed work instead. If a result is missing, remove restrictive filters and check that you can read the work.

IQL terms are combined with AND. For example, `assignee:me -state-type:completed,canceled` finds nonterminal work assigned to you; `state:"In Review"` uses quotes for a value containing spaces. The [IQL reference](../api.md#iql--unified-work-filter) covers graph terms, custom fields, and what each surface accepts.

## Save and reopen a view

On Board or Backlog, set up your state, label, and assignee filters and sorting, then choose **Save view** and name it. Open it from **Views** or the relevant saved-view control. Recheck the project and any other filters after loading; those controls can be separate from the saved view. On **Views**, use **Share with team** or **Make private** where available; sharing a view does not bypass the team's work access rules.

## Keyboard shortcuts

Press `?` for the shortcut list. Common keys: `G` then `B` for Board, `G` then `L` for Backlog, `G` then `C` for Candidates, and `G` then `N` for In Review. On Board use `J`/`K` to focus an issue, `Space` to peek, `Enter` to open it, and `X` to toggle selection. Navigation chords are two consecutive keystrokes, not a simultaneous key press.
