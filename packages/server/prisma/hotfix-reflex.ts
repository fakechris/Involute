import { PrismaClient } from '@prisma/client';

import { proposeWork } from '../src/claim-service.ts';
import { findWorkByIdOrIdentifier } from '../src/context-service.ts';
import { resolveAgentPrincipal } from '../src/agent-credentials.ts';
import type { WriteActor } from '../src/work-service.ts';
import { HOTFIX_REFLEX_ACTOR, ensureServiceActor } from '../src/service-actors.ts';
import { loadProjectEnvironment } from './env.ts';

loadProjectEnvironment();

const prisma = new PrismaClient();

function readFlag(args: string[], name: string): string | null {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    return null;
  }
  return args[index + 1] ?? null;
}

/**
 * Who files the hotfix item (INV-573 P1-2).
 *
 * The reflex is a mechanism, not a mind: it is invoked *by* an agent session,
 * so the work item should name that agent, with `surface: hotfix-reflex`
 * recording how. The agent proves itself the way it does everywhere else — with
 * its own credential — so attribution comes from authentication, not from a
 * name this script chooses.
 *
 * Failure modes are deliberate:
 * - A token that is present but invalid, expired or revoked FAILS. It never
 *   degrades to the service identity; that would let a revoked agent keep
 *   writing under a different name.
 * - No token at all is allowed only in an explicitly trusted service context
 *   (HOTFIX_REFLEX_TRUSTED_SERVICE=true), and then files as @hotfix-reflex.
 *
 * There is no `--commit`. The previous version looked up *any* HUMAN admin and
 * committed as them, which proved nothing about that person having authorized
 * the write. Committing is a human gate; a human does it (AGENTS.md §6).
 */
async function resolveReflexActor(): Promise<WriteActor & { label: string; teamId: string | null }> {
  const token = process.env.INV_AGENT_TOKEN?.trim() || null;
  const sessionId = process.env.INV_SESSION_ID?.trim() || null;

  if (token) {
    const principal = await resolveAgentPrincipal(prisma, token);
    if (!principal) {
      throw new Error(
        'INV_AGENT_TOKEN is set but is not a valid, unexpired, unrevoked agent credential. '
        + 'Refusing to file the hotfix under a different identity.',
      );
    }
    if (!principal.scopes.includes('propose')) {
      throw new Error(
        `Agent ${principal.user.handle ?? principal.user.name} lacks the propose scope.`,
      );
    }
    return {
      actorId: principal.user.id,
      actorKind: 'AGENT',
      label: `@${principal.user.handle ?? principal.user.name} (agent, via hotfix-reflex)`,
      sessionId,
      surface: HOTFIX_REFLEX_ACTOR.surface,
      // The credential's binding is where this agent may write. A --team flag
      // that disagrees is an attempt to write somewhere else (INV-594).
      teamId: principal.teamId,
    };
  }

  if (process.env.HOTFIX_REFLEX_TRUSTED_SERVICE === 'true') {
    const service = await ensureServiceActor(prisma, HOTFIX_REFLEX_ACTOR);
    return {
      ...service,
      label: `@${HOTFIX_REFLEX_ACTOR.handle} (trusted service context)`,
      sessionId,
      teamId: null,
    };
  }

  throw new Error(
    'No agent identity. Set INV_AGENT_TOKEN to the credential of the agent running this session '
    + '(pnpm --filter @turnkeyai/involute-server agent:create ...), or set '
    + 'HOTFIX_REFLEX_TRUSTED_SERVICE=true to file as the @hotfix-reflex service in a trusted context.',
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const title = readFlag(args, 'title');
  const parentArg = readFlag(args, 'parent');
  const teamFlag = readFlag(args, 'team');
  const repo = readFlag(args, 'repo') ?? 'fakechris/Involute';
  const customDesc = readFlag(args, 'desc');

  if (!title || title.trim() === '') {
    console.error(`
[Involute Hotfix Reflex] Error: Missing required --title argument.

Usage:
  pnpm hotfix:reflex --title "Fix memory leak in link query" [--parent <INV-xxx>]

Options:
  --title   Description of the fix (required)
  --parent  Parent issue or milestone identifier/UUID (e.g. INV-2)
  --team    Team key (default: INV)
  --repo    Repository (default: fakechris/Involute)
  --desc    Custom detailed description

Identity:
  INV_AGENT_TOKEN                 credential of the agent running this session (preferred)
  INV_SESSION_ID                  the session id, recorded on the write for later context
  HOTFIX_REFLEX_TRUSTED_SERVICE   "true" to file as @hotfix-reflex when no agent token exists
`);
    process.exit(1);
  }

  const reflexActor = await resolveReflexActor();

  // An agent credential is bound to one team; that is the team, full stop.
  // A service (no binding) takes --team, defaulting to INV.
  let team = reflexActor.teamId
    ? await prisma.team.findUnique({ where: { id: reflexActor.teamId } })
    : await prisma.team.findUnique({ where: { key: teamFlag ?? 'INV' } });

  if (!team) {
    console.error(`[Involute Hotfix Reflex] Error: Team "${teamFlag ?? reflexActor.teamId}" not found.`);
    process.exit(1);
  }
  if (reflexActor.teamId && teamFlag && teamFlag !== team.key) {
    console.error(`[Involute Hotfix Reflex] Error: --team ${teamFlag} but this credential is bound to ${team.key}. Refusing to write outside the credential's team.`);
    process.exit(1);
  }

  // Resolve parent work item
  let parentItem = null;
  if (parentArg) {
    parentItem = await findWorkByIdOrIdentifier(prisma, parentArg);
    if (!parentItem) {
      console.warn(`[Involute Hotfix Reflex] Warning: Specified parent "${parentArg}" not found, falling back to root project.`);
    } else if (parentItem.teamId !== team.id) {
      console.error(`[Involute Hotfix Reflex] Error: parent ${parentArg} is on another team; this credential may not link work to it.`);
      process.exit(1);
    }
  }

  if (!parentItem) {
    // Find root project for repo or team
    parentItem = await prisma.issue.findFirst({
      where: {
        teamId: team.id,
        repository: repo,
        kind: 'PROJECT',
      },
    });
  }

  const description =
    customDesc ??
    `### 1. 目标与架构定位
即时热修与计划外工作（Unplanned Hotfix）。在开发或排查过程中发现超出当前任务范围的问题，就地修复并自动闭环登记至 Involute，杜绝幽灵修复。

### 2. 核心功能与交付范围
${title.trim()}

### 3. 验收标准与验证方案
相关修改通过本地自动化测试与 TypeScript 类型检查，验证无功能回归。`;

  // Resolve the identity BEFORE anything is written, so a bad credential
  // fails the whole run rather than half of it.
  

  const candidate = await proposeWork(prisma, {
    acceptance: 'Fix verified by automated tests and typecheck; no regression.',
    description,
    kind: 'ISSUE',
    outcome: `Hotfix resolved: ${title.trim()}`,
    parentId: parentItem ? parentItem.id : null,
    relatedWorkId: parentItem ? parentItem.id : null,
    relatedWorkType: parentItem ? 'DISCOVERED_DURING' : null,
    repository: repo,
    scope: 'hotfix',
    source: 'hotfix-reflex',
    teamId: team.id,
    title: title.trim(),
    verification: 'Automated test suite and typecheck pass cleanly.',
  }, reflexActor);

  console.log(`\n✓ Successfully created Involute Hotfix Item: [${candidate.identifier}] (${candidate.id})`);
  console.log(`  Title: ${candidate.title}`);
  console.log(`  Filed as: ${reflexActor.label}`);
  if (parentItem) {
    console.log(`  Parent / Discovered During: [${parentItem.identifier}] ${parentItem.title}`);
  }
  console.log('  Status: CANDIDATE — a human commits it via /candidates or candidates:batch-commit.');
}

main()
  .catch((error: unknown) => {
    console.error('[Involute Hotfix Reflex] Failed.');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
