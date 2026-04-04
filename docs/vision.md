# Vision

## Slogan

一人团队的 Linear 式项目管理系统开源实现。

## Product intent

Involute is a focused, self-hostable project management system for a small team, especially a one-person team that still wants Linear-style structure: issues, workflows, labels, comments, and fast keyboard-and-board-driven operations.

## Current north star

The shortest path to value is:

1. Export one Linear team.
2. Import it into Involute.
3. Verify the import result.
4. Open the board and visually accept the data.

If this path is stable, the product is already useful for migration rehearsal, archival visibility, and daily issue work.

## What we are optimizing for now

- Reliable single-team import and verification
- Reproducible local stack through Docker Compose
- Stable issue lifecycle in the UI: create, edit, comment, delete
- Automated end-to-end acceptance coverage before a larger UI/UX rewrite

## Explicitly not optimizing for yet

- Multi-team workspace import
- Large-scale performance work
- Final visual design language
- Enterprise auth and permission boundaries
