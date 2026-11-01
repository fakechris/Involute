/**
 * Hover previews for references in prose (INV-1466).
 *
 * The web app turns every "PREFIX-NUMBER" in a description, comment or run
 * summary into a reference: the reader hovers it and sees what it points at,
 * clicks it and lands on the work item. Two rules shape this module:
 *
 * - **Nothing is guessed.** A reference resolves only when the server knows
 *   the item, so `UTF-8` and `ISO-8601` stay plain words. The reader's
 *   permission decides too: an item they may not read is not returned, and
 *   the reference stays plain text.
 * - **The prefix is data, not code.** `INV-1446` is the common form, but a
 *   project may carry an alias (`LUM-398` means `INV-398`, INV-459). The
 *   alias is resolved the same way the webhook resolves it: the alias
 *   prefix becomes the owning team's key, and the item must really belong
 *   to that project's repository.
 */

import type { Prisma, PrismaClient } from '@prisma/client';

import { isTypeLabel } from './labels.js';

/** A page of prose names far fewer than this; the cap only bounds abuse. */
export const MAX_PREVIEW_IDENTIFIERS = 100;

/** `INV-1446`: a letter-led prefix of 1–10 characters and a number. */
const IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9]{0,9}-\d{1,9}$/;

const EXCERPT_LIMIT = 220;

export interface IssuePreviewRecord {
  id: string;
  /** The reference as the reader wrote it, normalized (uppercased). */
  reference: string;
  /** The item's own identifier — the canonical form of the reference. */
  identifier: string;
  title: string;
  stateName: string;
  stateType: string;
  commitmentStatus: string;
  priority: number;
  kind: string;
  repository: string | null;
  teamKey: string;
  typeLabel: string | null;
  excerpt: string | null;
  updatedAt: Date;
}

type PreviewIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  kind: string;
  commitmentStatus: string;
  repository: string | null;
  updatedAt: Date;
  state: { name: string; type: string };
  team: { key: string };
  labels: Array<{ name: string }>;
};

/**
 * The identifier as a lookup key, or null when the text is not a reference at
 * all. Normalizing here keeps the case rules in one place: identifiers are
 * stored uppercase, and readers type them in any case.
 */
export function normalizePreviewIdentifier(raw: string): string | null {
  const trimmed = raw.trim().toUpperCase();
  return IDENTIFIER_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * The opening of a description, without the markdown scaffolding around it:
 * a preview card is a glance, not a second copy of the page.
 */
export function previewExcerpt(description: string | null | undefined): string | null {
  if (!description) return null;
  const text = description
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  if (text.length <= EXCERPT_LIMIT) return text;
  return `${text.slice(0, EXCERPT_LIMIT).replace(/\s+\S*$/, '')}…`;
}

/** The Type label (Bug, Research, …) an item carries, if any. */
export function previewTypeLabel(labels: Array<{ name: string }>): string | null {
  return labels.find((label) => isTypeLabel(label.name))?.name ?? null;
}

/**
 * Resolve a batch of references to the items they point at.
 *
 * `readableWhere` is the viewer's read scope; an item outside it is not
 * returned at all, so the caller cannot learn that it exists.
 */
export async function resolveIssuePreviews(
  prisma: Pick<PrismaClient, 'issue'>,
  identifiers: string[],
  readableWhere: Prisma.IssueWhereInput | undefined,
): Promise<IssuePreviewRecord[]> {
  const references = [...new Set(identifiers.map(normalizePreviewIdentifier).filter((value): value is string => value !== null))];
  if (references.length === 0) return [];
  const capped = references.slice(0, MAX_PREVIEW_IDENTIFIERS);

  const aliases = await findAliasProjects(prisma, capped);
  const direct: string[] = [];
  const viaAlias: Array<{ reference: string; canonical: string; repository: string }> = [];

  for (const reference of capped) {
    const dash = reference.indexOf('-');
    const prefix = reference.slice(0, dash);
    const number = reference.slice(dash + 1);
    const alias = aliases.get(prefix);
    if (alias && alias.teamKey !== prefix) {
      viaAlias.push({ reference, canonical: `${alias.teamKey}-${number}`, repository: alias.repository ?? '' });
    } else {
      direct.push(reference);
    }
  }

  const wanted = [...new Set([...direct, ...viaAlias.map((entry) => entry.canonical)])];
  const issues = await prisma.issue.findMany({
    where: {
      AND: [
        { identifier: { in: wanted, mode: 'insensitive' } },
        ...(readableWhere ? [readableWhere] : []),
      ],
    },
    include: { state: true, team: true, labels: { select: { name: true } } },
  });

  const byIdentifier = new Map(issues.map((issue) => [issue.identifier.toUpperCase(), issue]));
  const records: IssuePreviewRecord[] = [];

  for (const reference of direct) {
    const issue = byIdentifier.get(reference);
    if (issue) records.push(toPreviewRecord(reference, issue));
  }

  for (const entry of viaAlias) {
    const issue = byIdentifier.get(entry.canonical);
    // The alias asserts membership: the item has to belong to the project the
    // alias stands for, or the reference means nothing (INV-459).
    if (!issue) continue;
    if (!entry.repository || (issue.repository ?? '').toLowerCase() !== entry.repository.toLowerCase()) continue;
    records.push(toPreviewRecord(entry.reference, issue));
  }

  return records;
}

/**
 * Projects that carry an alias among the prefixes the references use, e.g. the
 * lumenbox project with alias `LUM` (INV-459, INV-793).
 */
async function findAliasProjects(
  prisma: Pick<PrismaClient, 'issue'>,
  references: string[],
): Promise<Map<string, { teamKey: string; repository: string | null }>> {
  const prefixes = [...new Set(references.map((reference) => reference.slice(0, reference.indexOf('-'))))];
  if (prefixes.length === 0) return new Map();
  const projects = await prisma.issue.findMany({
    where: { kind: 'PROJECT', alias: { in: prefixes, mode: 'insensitive' } },
    select: { alias: true, repository: true, team: { select: { key: true } } },
  });
  const aliases = new Map<string, { teamKey: string; repository: string | null }>();
  for (const project of projects) {
    if (!project.alias) continue;
    aliases.set(project.alias.toUpperCase(), {
      teamKey: project.team.key.toUpperCase(),
      repository: project.repository,
    });
  }
  return aliases;
}

function toPreviewRecord(reference: string, issue: PreviewIssue): IssuePreviewRecord {
  return {
    id: issue.id,
    reference,
    identifier: issue.identifier,
    title: issue.title,
    stateName: issue.state.name,
    stateType: issue.state.type,
    commitmentStatus: issue.commitmentStatus,
    priority: issue.priority,
    kind: issue.kind,
    repository: issue.repository,
    teamKey: issue.team.key,
    typeLabel: previewTypeLabel(issue.labels),
    excerpt: previewExcerpt(issue.description),
    updatedAt: issue.updatedAt,
  };
}
