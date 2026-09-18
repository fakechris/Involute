import type { Prisma, PrismaClient } from '@prisma/client';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

// Bounds. The context rides inside a webhook payload, so it is a briefing, not
// an archive: a consumer that needs more calls `work_get_context`.
const MAX_ANCESTORS = 5;
const MAX_RUNS = 3;
const MAX_EVIDENCE = 3;
const MAX_FIELD_LENGTH = 2_000;
export const MAX_PROMPT_CONTEXT_LENGTH = 8_000;

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/**
 * The already-assembled context that ships with `agent.mentioned`, modelled on
 * Linear's `promptContext`: the consumer should not have to go and collect the
 * contract, the acceptance criteria and the recent runs itself before it can
 * answer. Markdown, deterministic field order, hard length cap.
 */
export async function buildMentionPromptContext(
  db: DatabaseClient,
  workId: string,
): Promise<string> {
  const work = await db.issue.findUnique({
    where: { id: workId },
    select: {
      acceptance: true,
      description: true,
      identifier: true,
      kind: true,
      parentId: true,
      repository: true,
      state: { select: { name: true } },
      title: true,
    },
  });

  if (!work) {
    return '';
  }

  const [runs, evidence] = await Promise.all([
    db.workRun.findMany({
      where: { workId },
      select: { createdAt: true, phase: true, status: true, summary: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_RUNS,
    }),
    db.workEvidence.findMany({
      where: { retractedAt: null, workId },
      select: { createdAt: true, kind: true, summary: true, url: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_EVIDENCE,
    }),
  ]);

  const sections: string[] = [
    `# ${work.identifier} — ${work.title}`,
    `- kind: ${work.kind}`,
    `- state: ${work.state?.name ?? 'unknown'}`,
    ...(work.repository ? [`- repository: ${work.repository}`] : []),
  ];

  const ancestors = await loadAncestorChain(db, work.parentId);
  if (ancestors.length > 0) {
    sections.push(`- parents: ${ancestors.join(' › ')}`);
  }

  if (work.description) {
    sections.push('', '## Contract', truncate(work.description, MAX_FIELD_LENGTH));
  }

  if (work.acceptance) {
    sections.push('', '## Acceptance', truncate(work.acceptance, MAX_FIELD_LENGTH));
  }

  if (runs.length > 0) {
    sections.push('', '## Recent runs');
    for (const run of runs) {
      const phase = run.phase ? ` ${run.phase}` : '';
      const summary = run.summary ? ` — ${truncate(run.summary, 240)}` : '';
      sections.push(`- ${run.createdAt.toISOString()} ${run.status}${phase}${summary}`);
    }
  }

  if (evidence.length > 0) {
    sections.push('', '## Recent evidence');
    for (const item of evidence) {
      const summary = item.summary ? ` — ${truncate(item.summary, 240)}` : '';
      sections.push(`- ${item.kind}: ${item.url}${summary}`);
    }
  }

  return truncate(sections.join('\n'), MAX_PROMPT_CONTEXT_LENGTH);
}

async function loadAncestorChain(
  db: DatabaseClient,
  parentId: string | null,
): Promise<string[]> {
  const chain: string[] = [];
  const seen = new Set<string>();
  let currentId = parentId;

  while (currentId && chain.length < MAX_ANCESTORS && !seen.has(currentId)) {
    seen.add(currentId);
    const parent: { identifier: string; parentId: string | null; title: string } | null =
      await db.issue.findUnique({
        where: { id: currentId },
        select: { identifier: true, parentId: true, title: true },
      });

    if (!parent) {
      break;
    }

    chain.unshift(`${parent.identifier} ${parent.title}`);
    currentId = parent.parentId;
  }

  return chain;
}
