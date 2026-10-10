import type { Prisma, PrismaClient } from '@prisma/client';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/**
 * What finished work must show before it closes, shared by every closing rule
 * that asks for it: research (INV-1001; the attachment check is INV-1128) and
 * incidents (INV-1126). Each rule picks the requirements; this file only says
 * whether the work meets them.
 *
 * - downstream: something was DERIVED_FROM it, or its text says it led to
 *   nothing actionable ("无可执行点" / "no actionable").
 * - attachment: at least one private file is attached to it (INV-1003) — the
 *   research report or the postmortem.
 */
export const NO_ACTIONABLE = /无可执行点|no actionable/i;

export type CloseRequirement = 'downstream' | 'attachment';

export interface ClosableText {
  description: string | null;
  outcome: string | null;
  scope: string | null;
  constraints: string | null;
  acceptance: string | null;
  verification: string | null;
}

export function contractTexts(work: ClosableText): Array<string | null> {
  return [work.description, work.outcome, work.scope, work.constraints, work.acceptance, work.verification];
}

/** True when any of the texts says the work had no actionable outcome. */
export function saysNoActionable(texts: ReadonlyArray<string | null | undefined>): boolean {
  return texts.some((text) => Boolean(text && NO_ACTIONABLE.test(text)));
}

export async function hasDerivedWork(prisma: DatabaseClient, workId: string): Promise<boolean> {
  return (await prisma.workLink.count({ where: { type: 'DERIVED_FROM', toId: workId } })) > 0;
}

export async function hasAttachment(prisma: DatabaseClient, workId: string): Promise<boolean> {
  return (await prisma.attachment.count({ where: { issueId: workId } })) > 0;
}

/**
 * The requirements in `required` that `work` does not meet yet, in the order
 * asked. `extraText` is text that will stand once the close is saved, e.g. a
 * description sent with the state change.
 */
export async function missingCloseRequirements(
  prisma: DatabaseClient,
  work: ClosableText & { id: string },
  required: readonly CloseRequirement[],
  extraText?: string | null,
): Promise<CloseRequirement[]> {
  const missing: CloseRequirement[] = [];
  for (const requirement of required) {
    if (requirement === 'downstream') {
      if (saysNoActionable([...contractTexts(work), extraText])) continue;
      if (!(await hasDerivedWork(prisma, work.id))) missing.push('downstream');
    } else if (!(await hasAttachment(prisma, work.id))) {
      missing.push('attachment');
    }
  }
  return missing;
}
