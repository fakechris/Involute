---
name: search-work
description: Use when looking up existing Involute work before proposing or claiming anything. Prefer this over inventing a new title.
---

# Search work

Tool: `work_search`

## When

Before `work_propose`, before grabbing ready work, and whenever a title might already exist under the team/repo.

## How

- Query by keyword, identifier (`INV-…`), or repository.
- Filter to the relevant PROJECT / team when possible.
- If a match exists, `work_get_context` next — do not propose a duplicate.

## Rules

- Search before propose. Duplicate titles are a failure.
- Do not treat empty search as license to dump a TODO list — propose at most independently acceptable candidates.

For a complete list, pass `paginate: true` and consume `nodes`; repeat the same query/filter with `after: pageInfo.endCursor` while `hasNextPage` is true. Cursors expire after one hour and recheck permissions each page. Without pagination, the legacy array is preserved. Search shares the UI keyword, segmentation, full-text and bounded semantic recall.
