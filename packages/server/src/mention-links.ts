import type { Prisma, WorkLinkType } from '@prisma/client';

import { createWorkLink } from './link-service.js';
import type { WriteActor } from './work-service.js';

type Tx = Prisma.TransactionClient;

const REFERENCE = /\b([A-Za-z][A-Za-z0-9]*)-(\d+)\b/g;

/**
 * Identifiers of this team's work referenced in `texts`: `KEY-123`, plus any
 * project alias prefix of the team (e.g. `LUM-398` → `INV-398`, INV-459).
 * Case-insensitive on the prefix, canonicalised to the team key.
 */
export function extractTeamReferences(texts: Array<string | null | undefined>, teamKey: string, aliases: string[]): string[] {
  const prefixes = new Set([teamKey.toUpperCase(), ...aliases.map((alias) => alias.toUpperCase())]);
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(REFERENCE)) {
      const prefix = match[1]!.toUpperCase();
      if (prefixes.has(prefix)) found.add(`${teamKey.toUpperCase()}-${Number(match[2])}`);
    }
  }
  return [...found];
}

/**
 * Norm v1 (INV-718/720): mentioning another work item records the relation.
 * Each same-team item referenced in `texts` that is not the work itself and is
 * not yet connected to it by any link gets a RELATED_TO edge, created in the
 * caller's transaction and attributed to the writer. Removing a mention never
 * removes an edge; people delete wrong ones by hand, as in Linear.
 */
export async function linkMentionedWork(
  tx: Tx,
  input: { workId: string; teamId: string; texts: Array<string | null | undefined>; actor?: WriteActor | null },
): Promise<string[]> {
  const team = await tx.team.findUnique({ where: { id: input.teamId }, select: { key: true } });
  if (!team) return [];
  const aliasRows = await tx.issue.findMany({
    where: { teamId: input.teamId, kind: 'PROJECT', alias: { not: null } },
    select: { alias: true },
  });
  const identifiers = extractTeamReferences(input.texts, team.key, aliasRows.map((row) => row.alias!).filter(Boolean));
  if (identifiers.length === 0) return [];

  const targets = await tx.issue.findMany({
    where: { teamId: input.teamId, identifier: { in: identifiers }, id: { not: input.workId } },
    select: { id: true, identifier: true },
  });
  if (targets.length === 0) return [];
  const connected = await tx.workLink.findMany({
    where: {
      OR: [
        { fromId: input.workId, toId: { in: targets.map((target) => target.id) } },
        { toId: input.workId, fromId: { in: targets.map((target) => target.id) } },
      ],
    },
    select: { fromId: true, toId: true },
  });
  const linked = new Set(connected.flatMap((link) => [link.fromId, link.toId]));
  const created: string[] = [];
  for (const target of targets) {
    if (linked.has(target.id)) continue;
    const type: WorkLinkType = 'RELATED_TO';
    await createWorkLink(tx, { actor: input.actor ?? null, fromId: input.workId, toId: target.id, type });
    created.push(target.identifier);
  }
  return created;
}

const DEPENDENCY_WORDING = /(依赖|前置|阻塞|阻挡|先行|前提|进入条件|完成后|depends? on|blocked by|prerequisite|after\s)/i;

/**
 * References that read like dependencies ("依赖 INV-420", "blocked by INV-9")
 * but have no BLOCKS edge either way — a prompt for a human or agent to record
 * the dependency, never an automatic one (the wording can be an example).
 */
export async function dependencyHints(
  tx: Tx | import('@prisma/client').PrismaClient,
  work: { id: string; teamId: string; texts: Array<string | null | undefined> },
): Promise<string[]> {
  const team = await tx.team.findUnique({ where: { id: work.teamId }, select: { key: true } });
  if (!team) return [];
  const aliasRows = await tx.issue.findMany({
    where: { teamId: work.teamId, kind: 'PROJECT', alias: { not: null } },
    select: { alias: true },
  });
  const aliases = aliasRows.map((row) => row.alias!).filter(Boolean);
  const worded = new Set<string>();
  for (const text of work.texts) {
    if (!text) continue;
    let previousEnd = 0;
    for (const match of text.matchAll(REFERENCE)) {
      const at = match.index ?? 0;
      const end = at + match[0].length;
      // Wording belongs to this reference only within its own clause: look back
      // at most 20 characters, never past a sentence break or the previous
      // reference, and a few characters ahead for "X 完成后" / "X first".
      let start = Math.max(previousEnd, at - 20);
      const lastBreak = Math.max(...['。', '；', ';', '. ', '\n', '!', '?', '！', '？'].map((mark) => text.lastIndexOf(mark, at - 1)));
      if (lastBreak + 1 > start) start = lastBreak + 1;
      const after = text.slice(end, end + 6).split(/[。；;\n]/)[0] ?? '';
      const window = text.slice(start, at) + ' ' + after;
      previousEnd = end;
      if (!DEPENDENCY_WORDING.test(window) && !/^\s*(完成后|之后|first)/i.test(after)) continue;
      for (const identifier of extractTeamReferences([match[0]], team.key, aliases)) worded.add(identifier);
    }
  }
  if (worded.size === 0) return [];
  const targets = await tx.issue.findMany({
    where: { teamId: work.teamId, identifier: { in: [...worded] }, id: { not: work.id } },
    select: { id: true, identifier: true },
  });
  if (targets.length === 0) return [];
  const blocks = await tx.workLink.findMany({
    where: {
      type: 'BLOCKS',
      OR: [
        { fromId: work.id, toId: { in: targets.map((target) => target.id) } },
        { toId: work.id, fromId: { in: targets.map((target) => target.id) } },
      ],
    },
    select: { fromId: true, toId: true },
  });
  const blocked = new Set(blocks.flatMap((link) => [link.fromId, link.toId]));
  return targets.filter((target) => !blocked.has(target.id)).map((target) => target.identifier).sort();
}
