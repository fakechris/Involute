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

- Stable self-hosted deployment on a VPS with documented production steps
- Stable Google OAuth sign-in, admin bootstrap, and session auth
- Team-level visibility and edit permissions
- Migration-driven database changes that are safe to deploy repeatedly
- Backup and restore confidence for a self-hosted operator
- Keep the single-team import and issue lifecycle green while deployment hardens

## Explicitly not optimizing for yet

- Multi-team workspace import
- Large-scale performance work
- Final visual design language
- Enterprise auth and permission boundaries
- Magic-link email auth and provider sprawl
- Making Railway a first-class deployment path before the VPS path is proven end-to-end
